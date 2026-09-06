import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { AiShadowQueue } from './shadow.queue'
import { DelegationProposalService } from '../observation/delegation-proposal.service'
import { SKUGGFALT, SKUGGKALLA_FELANMALAN } from './shadow-fields'

/** Låsets livslängd. Passet köar jobb, det kör dem inte. */
const LAS_TTL_SEC = 120

/** Hur många ärenden ett pass köar. Ett tak som SYNS — se nedan. */
export const SVEP_BATCH = 200

/**
 * Hur långt bakåt svepet tittar.
 *
 * Ett dygn, och det är en avvägning som ska stå skriven: kortare hade missat ett
 * Redis-avbrott över natten, längre hade betytt att en organisation som slår PÅ
 * flaggan får hela sin ärendehistorik skuggkörd på en gång — hundratals
 * modellanrop hyresvärden inte bett om, på en kvot hen betalar för.
 */
const SVEP_FONSTER_MS = 24 * 60 * 60 * 1000

// ── KLASSIFICERING: A — LÅST (cron:ai-shadow-sweep) ─────────────────────────
/**
 * SKYDDSNÄTET UNDER SKUGGKÖN.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Producenten hakar på `maintenance.service.create` via `enqueueSafely`, som
 * ALDRIG KASTAR: ett Redis-avbrott larmar till Sentry och släpper igenom
 * ärendet — vilket är rätt, ärendet får inte falla för att skuggläget är nere.
 * Men följden är att skuggförslaget då tyst uteblir, och "agenten föreslog
 * ingenting" ser likadant ut som "agenten kördes aldrig".
 *
 * Passet plockar upp ärenden från senaste dygnet som saknar förslag och köar dem
 * på nytt. Kön avvisar det som redan ligger där (härlett jobId), och det
 * partiella unika indexet avvisar det som redan skrivits.
 *
 * ── OCH DÄRFÖR HAR DEN ETT HJÄRTSLAG, TILL SKILLNAD FRÅN KÖN ────────────────
 *
 * `LASTA_CRON_JOBB` är cron-specifik: tröskeln härleds ur `@Cron`-uttrycket, och
 * `cron-heartbeat.spec.ts` kräver att kartan är identisk med både A-mängden i
 * cron-classification.ack.json och uttrycken i källan. En KÖ har inget uttryck
 * och hör därför inte hemma där. Svepet gör det — och genom det blir hela
 * skuggkedjans tystnad synlig i `/v1/health`.
 */
@Injectable()
export class AiShadowSweepService {
  private readonly logger = new Logger(AiShadowSweepService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AiShadowQueue,
    private readonly locks: LockService,
    private readonly cronErrors: CronErrorSink,
    private readonly förslag: DelegationProposalService,
  ) {}

  @Cron('*/15 * * * *')
  async svepPass(): Promise<void> {
    const utfall = await this.locks.runIfUnlocked(
      'cron:ai-shadow-sweep',
      () => this.svepPassUnsafe(),
      {
        ttlSec: LAS_TTL_SEC,
      },
    )
    if (!utfall.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig".
      this.logger.log(
        `[cron:ai-shadow-sweep] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${utfall.heldForSec ?? '?'} s av ${LAS_TTL_SEC} s.`,
      )
    }
  }

  /**
   * Namnet är INTE fritt: `check-cron-error-sink.mjs` följer exakt ETT steg, och
   * det steget är `${metod}Unsafe`. En delegat som heter något annat gör att
   * vakten inte ser sänkan — och utfallet är rött, inte tyst, vilket är rätt
   * håll att fela åt.
   */
  private async svepPassUnsafe(): Promise<void> {
    await runCronSafely('ai-shadow-sweep', () => this.svep(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  /**
   * MÖNSTREN I EN ORGANISATION — vilka (verktyg, typ) som besluten faktiskt rör.
   *
   * MÄNGDEN HÄRLEDS UR BESLUTEN, aldrig ur en lista. En uppräkning av "verktyg
   * vi bryr oss om" hade blivit fel första gången skuggagenten föreslog något
   * nytt, och felet hade varit tyst: förslaget uteblir, och ingen märker att en
   * vana aldrig fick sin fråga.
   */
  private async prövaMönsterFör(organizationId: string, nu: Date): Promise<number> {
    const beslutade = await this.prisma.aiAssignment.findMany({
      where: {
        organizationId,
        kind: 'TOOL_PROPOSAL',
        status: 'APPROVED',
        decidedByUserId: { not: null },
      },
      select: { toolName: true, prediction: true },
      // Taket är generöst men finns: mängden distinkta mönster är liten, men en
      // organisation med tiotusen beslut ska inte läsa in dem alla varje kvart.
      take: 500,
      orderBy: { decidedAt: 'desc' },
    })

    const typfält = SKUGGFALT[0]!.nyckel
    const mönster = new Set<string>()
    for (const r of beslutade) {
      const p = r.prediction as Record<string, unknown> | null
      const typ = p?.[typfält]
      if (typeof typ !== 'string' || typ === '') continue
      mönster.add(`${r.toolName}\u0000${typ}`)
    }

    let skapade = 0
    for (const m of mönster) {
      const [verktyg, typ] = m.split('\u0000') as [string, string]
      const r = await this.förslag.prövaMönster(organizationId, verktyg, typ, nu)
      if (r.utfall === 'SKAPAT') skapade++
    }
    return skapade
  }

  /**
   * @param nu injiceras av proven; ett pass mäter alla rader mot samma klocka.
   * @returns antal köade, och om taket slog i.
   */
  async svep(nu: Date = new Date()): Promise<{ koade: number; takNatt: boolean }> {
    const orgar = await this.prisma.organization.findMany({
      where: { shadowAgentEnabled: true },
      select: { id: true },
    })
    if (orgar.length === 0) return { koade: 0, takNatt: false }

    const fran = new Date(nu.getTime() - SVEP_FONSTER_MS)
    let koade = 0
    let takNatt = false

    for (const org of orgar) {
      const medForslag = await this.prisma.aiAssignment.findMany({
        where: { organizationId: org.id, shadow: true, sourceKind: SKUGGKALLA_FELANMALAN },
        select: { sourceId: true },
      })
      const har = new Set(medForslag.map((r) => r.sourceId).filter((x): x is string => !!x))

      // TAKET SYNS, DET KRYMPER INTE TYST: kandidaterna räknas separat, så en
      // rapporterad radlängd inte blir en mätning av taket.
      const kandidater = await this.prisma.maintenanceTicket.count({
        where: { organizationId: org.id, createdAt: { gte: fran, lte: nu } },
      })
      const arenden = await this.prisma.maintenanceTicket.findMany({
        where: { organizationId: org.id, createdAt: { gte: fran, lte: nu } },
        orderBy: { createdAt: 'desc' },
        take: SVEP_BATCH,
        select: { id: true },
      })
      if (kandidater > arenden.length) takNatt = true

      for (const a of arenden) {
        if (har.has(a.id)) continue
        await this.queue.enqueue({ organizationId: org.id, ticketId: a.id })
        koade++
      }
    }

    // ── DELEGATIONSFÖRSLAGEN, I SAMMA LÅSTA PASS ────────────────────────
    //
    // Egen cron hade betytt ett andra lås, ett andra hjärtslag och en andra
    // uppräkning av "vilka organisationer har skuggagenten på" — för ett jobb
    // som bara ställer frågor mot databasen. Passet är redan låst och har
    // redan org-listan; mönsterprövningen hör hemma efter köandet, när
    // dagens beslut hunnit skrivas.
    //
    // KASTAR ALDRIG UT: ett fel i förslagsdelen får inte ta med sig
    // skuggköandet, som är passets huvuduppgift och det enda som är
    // tidskritiskt. `runCronSafely` ovanför fångar ändå allt som slipper
    // igenom, men då hade köandet redan hunnit ske.
    let förslagSkapade = 0
    for (const org of orgar) {
      try {
        förslagSkapade += await this.prövaMönsterFör(org.id, nu)
      } catch (err) {
        this.logger.error(
          `[cron:ai-shadow-sweep] Mönsterprövningen föll för ${org.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (förslagSkapade > 0)
      this.logger.log(`[cron:ai-shadow-sweep] Skapade ${förslagSkapade} delegationsförslag.`)

    if (takNatt)
      this.logger.warn(
        `[cron:ai-shadow-sweep] Taket ${SVEP_BATCH} slog i för minst en organisation — ` +
          'resten väntar till nästa pass.',
      )
    if (koade > 0) this.logger.log(`[cron:ai-shadow-sweep] Köade ${koade} skuggkörningar.`)
    return { koade, takNatt }
  }
}
