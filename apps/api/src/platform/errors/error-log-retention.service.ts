import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import {
  ERROR_LOG_RETENTION_BUCKETS,
  cutoffFor,
  retentionDaysForBucket,
  type ErrorLogRetentionBucket,
} from './error-log-retention'

/**
 * GALLRING AV `ErrorLog` (#612).
 *
 * Fristerna och skälen bor i `error-log-retention.ts`. Den här filen kör dem.
 *
 * ── VAD DEN HÄR TJÄNSTEN INTE KAN SE ────────────────────────────────────────
 *
 * Den gallrar på ÅLDER och `resolved`. Den läser aldrig innehållet, och kan
 * alltså inte veta att en viss rad bär ett personnummer. Det är avsiktligt:
 * fritext går inte att klassificera tillförlitligt, och en gallring som
 * försökte hade blivit en heuristik som ibland sparar fel rad.
 *
 * Riktad borttagning på begäran ägs i stället av `anonymize-tenant.ts`, som
 * matchar på hyresgästens UUID. De två mekanismerna täcker olika saker och
 * ersätter inte varandra: den här är tiden, den andra är personen.
 */
const RETENTION_BATCH_SIZE = 1_000

export interface ErrorLogRetentionBucketOutcome {
  bucket: ErrorLogRetentionBucket
  /** Fristen i dagar som användes — med i utfallet så rapporten är självbärande. */
  days: number
  rows: number
  /**
   * Hur många av raderna som saknade organisation.
   *
   * Redovisas SEPARAT därför att just de raderna var odödliga före #612 (den
   * enda raderingsvägen matchade på `organizationId`). Att talet syns i
   * rapporten är skillnaden mellan "de omfattas" och "vi tror att de omfattas".
   */
  utanOrganisation: number
}

export interface ErrorLogRetentionOutcome {
  mode: RetentionMode
  buckets: ErrorLogRetentionBucketOutcome[]
  total: number
}

export type RetentionMode = 'dry-run' | 'enforce'

@Injectable()
export class ErrorLogRetentionService {
  private readonly logger = new Logger(ErrorLogRetentionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // deleteMany på ErrorLog filtrerad på `id: { in: [...] }` där id-listan kommer
  // ur en läsning på createdAt < gränsen för sin hink — raderade rader kan inte
  // raderas igen, så en samtidig andra körning träffar noll rader. Ingen räknare
  // och ingen sidoeffekt utanför tabellen, alltså inget dubbelräkningsfel heller.
  //
  // Bevakas av check-cron-classification.mjs.
  @Cron('30 4 * * *', { timeZone: 'Europe/Stockholm', name: 'error-log-retention' })
  async scheduledRetention(): Promise<void> {
    // #605 — VARAKTIG FELSÄNKA. En gallring som tyst slutar köra är den
    // farligaste sortens tystnad: tabellen växer förbi sin frist utan att någon
    // vet, vilket är en dataskyddsfråga och inte bara en driftfråga. Samma skäl
    // som `ai-retention` anger.
    await runCronSafely(
      'error-log-retention',
      async () => {
        const utfall = await this.runRetention('enforce')
        this.rapportera(utfall)
      },
      { logger: this.logger, sink: this.cronErrors },
    )
  }

  /**
   * Kör (eller simulerar) gallringen.
   *
   * `dry-run` läser exakt samma rader med exakt samma villkor men skriver
   * ingenting — talen är alltså de tal en skarp körning hade gett, inte en
   * uppskattning. Samma kontrakt som `AiRetentionService.runRetention`.
   */
  async runRetention(
    mode: RetentionMode,
    now: Date = new Date(),
  ): Promise<ErrorLogRetentionOutcome> {
    const buckets: ErrorLogRetentionBucketOutcome[] = []

    for (const bucket of ERROR_LOG_RETENTION_BUCKETS) {
      buckets.push(await this.collect(bucket, mode, now))
    }

    return { mode, buckets, total: buckets.reduce((s, b) => s + b.rows, 0) }
  }

  private async collect(
    bucket: ErrorLogRetentionBucket,
    mode: RetentionMode,
    now: Date,
  ): Promise<ErrorLogRetentionBucketOutcome> {
    // Hinken väljs av NUVARANDE `resolved`, inte av något som låstes när raden
    // skrevs — se docblocket i error-log-retention.ts. `organizationId` är med
    // FLIT inte med i villkoret: rader utan organisation ska omfattas.
    const stale = await this.prisma.errorLog.findMany({
      where: {
        resolved: bucket === 'resolved',
        createdAt: { lt: cutoffFor(bucket, now) },
      },
      select: { id: true, organizationId: true },
      take: RETENTION_BATCH_SIZE,
    })

    if (mode === 'enforce' && stale.length > 0) {
      await this.prisma.errorLog.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } })
    }

    return {
      bucket,
      days: retentionDaysForBucket(bucket),
      rows: stale.length,
      utanOrganisation: stale.filter((r) => r.organizationId === null).length,
    }
  }

  private rapportera(utfall: ErrorLogRetentionOutcome): void {
    const delar = utfall.buckets
      .map((b) => `${b.bucket} ${b.rows} (${b.days} d, varav ${b.utanOrganisation} utan org)`)
      .join(' · ')
    this.logger.log(`ErrorLog-gallring [${utfall.mode}]: ${utfall.total} rader — ${delar}`)
  }
}
