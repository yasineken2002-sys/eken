import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { AiShadowQueue } from './shadow.queue'
import { SKUGGKALLA_FELANMALAN } from './shadow-fields'

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

    if (takNatt)
      this.logger.warn(
        `[cron:ai-shadow-sweep] Taket ${SVEP_BATCH} slog i för minst en organisation — ` +
          'resten väntar till nästa pass.',
      )
    if (koade > 0) this.logger.log(`[cron:ai-shadow-sweep] Köade ${koade} skuggkörningar.`)
    return { koade, takNatt }
  }
}
