import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { AiExecutionDryRunQueue } from './dryrun.queue'

/** Låsets livslängd. Passet köar jobb, det fäller inga domar. */
const LAS_TTL_SEC = 120

/** Hur många uppdrag ett pass köar. Ett tak som SYNS — se nedan. */
export const SVEP_BATCH = 200

// ── KLASSIFICERING: A — LÅST (cron:ai-execution-dryrun) ─────────────────────
/**
 * SKYDDSNÄTET UNDER TORRLÄGETS KÖ.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * Skuggproducenten köar en dom direkt när ett förslag skrivits, via
 * `enqueueSafely` — som ALDRIG KASTAR: ett Redis-avbrott larmar till Sentry och
 * släpper igenom förslaget, vilket är rätt (förslaget får inte falla för att
 * torrläget är nere). Följden är att domen då tyst uteblir, och "ingen dom" ser
 * likadant ut som "agenten hade inte fått handla".
 *
 * Passet plockar upp skuggförslag UTAN dom och köar dem på nytt. Kön avvisar det
 * som redan ligger där (härlett jobId), och tjänsten avvisar det som redan har
 * en dom.
 *
 * ── INGET TIDSFÖNSTER, TILL SKILLNAD FRÅN SKUGGSVEPET ──────────────────────
 *
 * Skuggsvepet tittar ett dygn bakåt, därför att en organisation som slår PÅ
 * flaggan annars får hela sin ärendehistorik skuggkörd på en gång — hundratals
 * modellanrop hyresvärden inte bett om, på en kvot hen betalar för.
 *
 * Den avvägningen finns inte här: en dom är en databasläsning, inte ett
 * modellanrop, och den kostar ingenting utöver frågan. Att sätta ett fönster
 * hade i stället gjort att förslag äldre än ett dygn ALDRIG fick en dom om kön
 * tappade dem — en permanent lucka i facit, för att undvika en kostnad som inte
 * finns. Taket per pass gör mängden hanterbar utan att göra luckan permanent.
 *
 * ── OCH DÄRFÖR HAR DEN ETT HJÄRTSLAG ───────────────────────────────────────
 *
 * `LASTA_CRON_JOBB` bär tröskeln, härledd ur `@Cron`-uttrycket. Genom det blir
 * hela torrlägeskedjans tystnad synlig i `/v1/health` i stället för att bara
 * yttra sig som att facit slutar växa.
 *
 * ── VAD DEN INTE KAN SE ────────────────────────────────────────────────────
 *
 * Att domarna är RÄTTA. Passet mäter att varje förslag får en dom; att domen
 * motsvarar delegationsläget ägs av `execution-dryrun.db.spec.ts`, som prövar
 * grinden mot riktig Postgres.
 */
@Injectable()
export class AiExecutionDryRunSweepService {
  private readonly logger = new Logger(AiExecutionDryRunSweepService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AiExecutionDryRunQueue,
    private readonly locks: LockService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  @Cron('*/15 * * * *')
  async svepPass(): Promise<void> {
    const utfall = await this.locks.runIfUnlocked(
      'cron:ai-execution-dryrun',
      () => this.svepPassUnsafe(),
      { ttlSec: LAS_TTL_SEC },
    )
    if (!utfall.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig".
      this.logger.log(
        `[cron:ai-execution-dryrun] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${utfall.heldForSec ?? '?'} s av ${LAS_TTL_SEC} s.`,
      )
    }
  }

  /**
   * Namnet är INTE fritt: `check-cron-error-sink.mjs` följer exakt ETT steg, och
   * det steget är `${metod}Unsafe`.
   */
  private async svepPassUnsafe(): Promise<void> {
    await runCronSafely('ai-execution-dryrun', () => this.svep(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  /** @returns antal köade, och om taket slog i. */
  async svep(): Promise<{ koade: number; takNatt: boolean }> {
    // TAKET SYNS, DET KRYMPER INTE TYST: kandidaterna räknas separat, så en
    // rapporterad radlängd inte blir en mätning av taket.
    const kandidater = await this.prisma.aiAssignment.count({
      where: { shadow: true, executionVerdict: null },
    })
    const rader = await this.prisma.aiAssignment.findMany({
      where: { shadow: true, executionVerdict: null },
      orderBy: { createdAt: 'asc' },
      take: SVEP_BATCH,
      select: { id: true, organizationId: true },
    })
    const takNatt = kandidater > rader.length

    let koade = 0
    for (const r of rader) {
      await this.queue.enqueue({ organizationId: r.organizationId, assignmentId: r.id })
      koade++
    }

    if (takNatt)
      this.logger.warn(
        `[cron:ai-execution-dryrun] Taket ${SVEP_BATCH} slog i — ${kandidater} obedömda ` +
          'förslag finns, resten väntar till nästa pass.',
      )
    if (koade > 0) this.logger.log(`[cron:ai-execution-dryrun] Köade ${koade} domar.`)
    return { koade, takNatt }
  }
}
