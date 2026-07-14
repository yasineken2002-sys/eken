import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma/prisma.service'
import { runCronSafely } from '../common/cron/cron-safety'
import { AviseringService } from './avisering.service'

/**
 * Schemalagd generering av månatliga hyresavier. Körs 1:a varje månad
 * kl 07:00 lokal serverintid och skapar nästa månads avier för alla
 * aktiva kontrakt — proportionellt vid in-/utflyttning. Mejl skickas
 * direkt så hyresgästerna har god marginal till sista vardagen i samma
 * månad (Hyreslagen 12 kap. 20 § JB).
 *
 * Idempotens: AviseringService.generateMonthlyNotices använder
 * @@unique(leaseId, year, month, type=RENT) — körs cron två gånger
 * eller manuellt triggas igen så hoppas redan skapade avier över.
 */
@Injectable()
export class AviseringScheduler {
  private readonly logger = new Logger(AviseringScheduler.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisering: AviseringService,
  ) {}

  // 1:a varje månad kl 07:00. För maj-avi ⇒ kör 1 maj. Förfallodag
  // beräknas av AviseringService till sista vardagen i april (= månad
  // FÖRE den hyran avser, enligt 12 kap. 20 § JB).
  @Cron('0 7 1 * *')
  async generateForCurrentMonth(): Promise<void> {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1

    // T5 B1b — MÅNADS-cadence: ett fel (t.ex. DB-blipp på org-findMany i
    // runForMonth) = hela månadens avier uteblir, nästa cron-försök först om
    // ~30 dagar. Därför HÖGRE larmnivå ('fatal') än de dagliga cron:en. Cronet
    // är självläkande i teorin — runForMonth kan köras om manuellt (admin/AI via
    // avisering.controller) eller täckas av T1.4-backfill — MEN någon måste
    // larmas inom dagar; fatal säkerställer det. Endast cron-vägen lindas;
    // runForMonth lämnas orörd så det manuella anropet fortfarande kastar till
    // sin anropare (UI ska se felet direkt).
    await runCronSafely('avisering-generate-monthly', () => this.runForMonth(year, month), {
      logger: this.logger,
      level: 'fatal',
    })
  }

  // Manuell trigger för admin / test. Körs av AI-tools eller "kör cron nu"-
  // knappen i UI. Returnerar en sammanställning per organisation.
  async runForMonth(
    year: number,
    month: number,
  ): Promise<{
    year: number
    month: number
    organizations: number
    created: number
    skipped: number
    failed: number
    queued: number
  }> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
    })

    let created = 0
    let skipped = 0
    let failed = 0
    let queued = 0

    for (const org of orgs) {
      try {
        const result = await this.avisering.generateMonthlyNotices(org.id, month, year)
        created += result.created
        skipped += result.skipped
        failed += result.failed

        if (result.notices.length > 0) {
          // Köa utskicket direkt så hyresgästerna har max tid på sig.
          const sendRes = await this.avisering.sendNotices(
            org.id,
            result.notices.map((n) => n.id),
          )
          queued += sendRes.queued
        }

        // T5 A1 (#54): per-lease-fel (failed>0) betyder att enskilda leases
        // hoppades men resten av orgen fortsatte. Lyft som WARN så det syns —
        // full Sentry-täckning för alla cron kommer i T5 B1.
        const level = result.failed > 0 ? 'warn' : 'log'
        this.logger[level](
          `[avisering-cron] org=${org.name} created=${result.created} skipped=${result.skipped} failed=${result.failed}`,
        )
      } catch (err) {
        this.logger.error(
          `[avisering-cron] org=${org.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    this.logger.log(
      `[avisering-cron] done year=${year} month=${month} orgs=${orgs.length} created=${created} skipped=${skipped} failed=${failed} queued=${queued}`,
    )

    return {
      year,
      month,
      organizations: orgs.length,
      created,
      skipped,
      failed,
      queued,
    }
  }
}
