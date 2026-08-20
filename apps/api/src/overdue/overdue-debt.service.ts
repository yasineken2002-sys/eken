import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { computeRentDebt } from '../avisering/rent-debt.service'
import { invoiceOutstanding } from '../invoices/invoice-debt'

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
 *   • Invoice: Σ invoiceOutstanding(inv) för OVERDUE-fakturor, KLAMPAT PER
 *     FAKTURA och bara det OBETALDA — exakt samma regel som RentNotice-grenen
 *     ovan. Se #325-blocket nedan för vad som stod här förut och varför.
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
          // #518 — utan krediteringarna hade en krediterad AVI fortsatt räknas
          // som öppen fordran här, precis som en krediterad faktura gjorde före
          // #517. Samma defekt, andra modellen.
          credits: { select: { amount: true } },
        },
      }),
      this.prisma.invoice.findMany({
        // `where` ORÖRT — #325 ändrar vad som SUMMERAS, inte vilka fakturor
        // som hämtas. Urvalskriteriet är fortfarande "OVERDUE, ej deposition".
        where: { organizationId, status: 'OVERDUE', type: { not: 'DEPOSIT' } },
        // #325 — allokeringarna går inte att räkna restskuld utan. Typen på
        // `invoiceOutstanding` är spärren: utan `payments` typcheckar det inte.
        select: {
          total: true,
          dueDate: true,
          payments: { select: { amount: true } },
          // #517 — utan kreditnotorna hade en krediterad faktura fortsatt
          // räknas som öppen fordran här, och eskalerat i kravtrappan.
          creditNotes: { select: { total: true } },
        },
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
        credits: n.credits.map((c) => c.amount),
      }).outstanding
      if (outstanding <= 0) continue
      total += outstanding
      count += 1
      if (n.dueDate < cutoff30) over30Count += 1
    }

    // ── #325: RESTSKULDEN, INTE URSPRUNGSBELOPPET ───────────────────────────
    //
    // HÄR STOD `Number(inv.total)`, på det uttryckliga antagandet att "Invoice
    // saknar allokeringsmodell → en OVERDUE-faktura är fullt obetald". Det var
    // sant när raden skrevs. Det är det inte längre: `InvoicePayment` (#307) gav
    // fakturan samma granulära allokering som RentNotice redan hade, och
    // `PARTIAL → OVERDUE` är en giltig kant (INVOICE_TRANSITIONS) som når hit
    // via PATCH /invoices/:id/status. En faktura på 10 000 med 9 000 allokerat
    // bidrog därför med 10 000 till "Försenat belopp" i stället för 1 000.
    //
    // ANTAGANDET SKYDDADES INTE — DET GJORDES SANT. Alternativet (blockera
    // kanten) hade lagat ETT sätt att bryta invarianten och lämnat siffran
    // beroende av att ingen hittar ett annat; att räkna rätt gör påståendet sant
    // oavsett hur fakturan hamnade i OVERDUE. (FAR-granskat, #325.)
    //
    // Samma klampning PER POST som RentNotice-loopen ovan: Σmax(0,x) ≠ max(0,Σx)
    // — en överbetald faktura bidrar 0, den kvittar aldrig mot en ANNAN fakturas
    // fordran (varje faktura är en egen verifikationskedja; en kvittning kräver
    // en bokförd kvittningshandling).
    //
    // `outstanding <= 0` hoppas, precis som på avi-sidan: en fullt reglerad men
    // ännu OVERDUE-flaggad faktura är ingen öppen fordran och ska varken höja
    // beloppet ELLER antalet. Statusfältet är då en förlegad etikett, inte ett
    // skuldpåstående. Detta ändrar alltså `count`/`over30Count`, inte bara
    // `total` — avsiktligt, och symmetriskt med raden ovan.
    for (const inv of invoices) {
      const outstanding = invoiceOutstanding(inv)
      if (outstanding <= 0) continue
      total += outstanding
      count += 1
      if (inv.dueDate < cutoff30) over30Count += 1
    }

    if (count === 0) return { ...EMPTY }
    return { total: Math.round(total * 100) / 100, count, over30Count }
  }
}
