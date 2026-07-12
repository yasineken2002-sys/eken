import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { computeRentDebt } from '../avisering/rent-debt.service'

const DAY_MS = 86_400_000
const OVERDUE_AGE_DAYS = 30

/**
 * Ögonblicksbild av förfallen, OBETALD skuld för en organisation. EN
 * sanningskälla för "Försenat belopp" — läses av BÅDE dashboarden
 * (DashboardService) och månadsrapporten (MonthlyReportService). Nästa
 * DEPOSIT-/RentNotice-relaterade justering görs på ETT ställe.
 */
export interface OverdueSnapshot {
  /** Σ förfallen obetald skuld (RentNotice outstanding + OVERDUE Invoice), kr. */
  total: number
  /** Antal förfallna poster med kvarvarande skuld (>0). */
  count: number
  /** Delmängd av `count` som förfallit för mer än 30 dagar sedan. */
  over30Count: number
}

const EMPTY: OverdueSnapshot = { total: 0, count: 0, over30Count: 0 }

/**
 * Delad läsning av förfallen skuld. Reglerna (identiska med T4/#47 PR2):
 *   • RentNotice: Σ computeRentDebt(n).outstanding för OVERDUE-avier, KLAMPAT
 *     PER AVI (en överbetald avi bidrar 0, aldrig negativt) och bara det
 *     OBETALDA (outstanding, inte totalAmount). En delbetald avi räknar resten.
 *   • Invoice: OVERDUE Invoice.total. Invoice saknar allokeringsmodell → en
 *     OVERDUE-faktura är fullt obetald, så .total ÄR restskulden.
 *   • DEPOSIT exkluderas på BÅDA källorna (2890-skuld, inte hyresskuld) —
 *     symmetriskt med intäktssidan (PR1).
 *   • Ingen dubbelräkning: en manuell RENT-faktura blockeras när en RentNotice
 *     finns för perioden → källorna överlappar aldrig.
 *   • Allt org-scopat.
 *
 * computeRentDebt-logiken RÖRS INTE — dess output summeras. Ren LÄSNING; rör
 * aldrig verifikat/huvudbok. EN findMany per källa (ingen N+1).
 */
@Injectable()
export class OverdueDebtService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverdueSnapshot(organizationId: string, now = new Date()): Promise<OverdueSnapshot> {
    const cutoff30 = new Date(now.getTime() - OVERDUE_AGE_DAYS * DAY_MS)

    const [notices, invoices] = await Promise.all([
      this.prisma.rentNotice.findMany({
        where: { organizationId, status: 'OVERDUE', type: { not: 'DEPOSIT' } },
        select: {
          type: true,
          totalAmount: true,
          consumptionAmount: true,
          miscChargeAmount: true,
          reminderFeeAmount: true,
          interestAccruedAmount: true,
          dueDate: true,
          payments: { select: { amount: true } },
        },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, status: 'OVERDUE', type: { not: 'DEPOSIT' } },
        select: { total: true, dueDate: true },
      }),
    ])

    let total = 0
    let count = 0
    let over30Count = 0

    // RentNotice — klampa PER AVI (Σmax(0,x) ≠ max(0,Σx)); räkna bara poster med
    // kvarvarande skuld (en fullt betald men ännu OVERDUE-flaggad avi är ingen
    // öppen fordran och ska varken höja beloppet eller antalet).
    for (const n of notices) {
      const outstanding = computeRentDebt({
        type: n.type,
        totalAmount: n.totalAmount,
        consumptionAmount: n.consumptionAmount,
        miscChargeAmount: n.miscChargeAmount,
        reminderFeeAmount: n.reminderFeeAmount,
        interestAccruedAmount: n.interestAccruedAmount,
        allocations: n.payments.map((p) => p.amount),
      }).outstanding
      if (outstanding <= 0) continue
      total += outstanding
      count += 1
      if (n.dueDate < cutoff30) over30Count += 1
    }

    // Symmetriskt med RentNotice-loopen: räkna bara poster med reell skuld. En
    // OVERDUE Invoice med total <= 0 (inget DB-constraint hindrar) ska varken
    // höja beloppet eller antalet — annars visar "Försenat belopp" fler poster
    // än det finns öppen fordran.
    for (const inv of invoices) {
      const invTotal = Number(inv.total)
      if (invTotal <= 0) continue
      total += invTotal
      count += 1
      if (inv.dueDate < cutoff30) over30Count += 1
    }

    if (count === 0) return { ...EMPTY }
    return { total: Math.round(total * 100) / 100, count, over30Count }
  }
}
