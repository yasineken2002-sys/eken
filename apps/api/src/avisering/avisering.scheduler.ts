import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma/prisma.service'
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

    await this.runForMonth(year, month)
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
    mailed: number
    mailFailed: number
  }> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
    })

    let created = 0
    let skipped = 0
    let mailed = 0
    let mailFailed = 0

    for (const org of orgs) {
      try {
        const result = await this.avisering.generateMonthlyNotices(org.id, month, year)
        created += result.created
        skipped += result.skipped

        if (result.notices.length > 0) {
          // Skicka direkt så hyresgästerna har max tid på sig.
          const sendRes = await this.avisering.sendNotices(
            org.id,
            result.notices.map((n) => n.id),
          )
          mailed += sendRes.sent
          mailFailed += sendRes.failed
        }

        this.logger.log(
          `[avisering-cron] org=${org.name} created=${result.created} skipped=${result.skipped}`,
        )
      } catch (err) {
        this.logger.error(
          `[avisering-cron] org=${org.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    this.logger.log(
      `[avisering-cron] done year=${year} month=${month} orgs=${orgs.length} created=${created} skipped=${skipped} mailed=${mailed} mailFailed=${mailFailed}`,
    )

    return {
      year,
      month,
      organizations: orgs.length,
      created,
      skipped,
      mailed,
      mailFailed,
    }
  }
}
