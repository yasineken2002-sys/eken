import { stockholmFiscalYear, stockholmMonthBounds } from '../common/time/stockholm-period'
import type { PeriodKey } from './closed-period'

/**
 * RÄKENSKAPSÅRETS GRÄNSER — en härledning, delad av alla som behöver dem.
 *
 * Uträkningen fanns förut inbakad i `ConsumptionService.runYearEndAccrual`
 * (bokslutsposten för omätt förbrukning). #704 PR 2 behöver exakt samma gränser
 * för årsstängningen, och två kopior av "när slutar räkenskapsåret" är två
 * kopior som förr eller senare svarar olika på ett brutet år. Funktionen är
 * flyttad hit; consumption anropar den.
 *
 * ── ÅRET ÄR EXAKT SINA TOLV MÅNADER, PER KONSTRUKTION ──────────────────────
 *
 * `months` räknas upp först, och fönstret (`from`/`to`) härleds ur den FÖRSTA
 * och SISTA månadens `stockholmMonthBounds`. Det är inte en bekvämlighet utan
 * invarianten: årsstängningen kräver att månad 1–11 är stängda och stänger
 * månad 12, och den frågan blir meningslös om årsfönstret kan innehålla ett
 * ögonblick som ingen av de tolv månaderna gör. Med härledningen ur samma
 * hjälpare som månadsstängningen använder kan de inte glida isär.
 *
 * ── VARFÖR DATUMEN RÄKNAS I UTC MEN PERIODERNA I SVENSK CIVIL TID ──────────
 *
 * `fiscalStart`, `yearEndDate` och `reversalDate` är DAGAR, inte ögonblick —
 * de landar i `JournalEntry.date`, som är `@db.Date` och saknar tid. Midnatt
 * UTC har samma civila datum i Sverige (offset +1/+2), så en dag uttryckt som
 * `Date.UTC(...)` tillhör samma svenska kalendermånad som den ser ut att göra.
 * Fönstret `from`/`to` är däremot ÖGONBLICK och måste därför komma från
 * `stockholmMonthBounds` — en post 22:30 UTC den 31 december är 00:30 svensk
 * tid den 1 januari och tillhör nästa månad, alltså nästa räkenskapsår.
 */
export interface FiscalYearBounds {
  fiscalYear: number
  startMonth: number
  /** Räkenskapsårets första dag (`@db.Date`-form: midnatt UTC). */
  fiscalStart: Date
  /** Räkenskapsårets SISTA dag — dateringen för årsavslutsverifikatet. */
  yearEndDate: Date
  /** Nästa räkenskapsårs första dag — där en bokslutspost återförs. */
  reversalDate: Date
  /** Årets tolv kalendermånader i ordning, äldst först. */
  months: PeriodKey[]
  /** Fönstrets början som ÖGONBLICK (svensk civil tid), inklusive. */
  from: Date
  /** Fönstrets slut som ÖGONBLICK (svensk civil tid), exklusive. */
  to: Date
}

const DAY_MS = 86_400_000

export function fiscalYearBounds(fiscalYear: number, startMonth: number): FiscalYearBounds {
  const fiscalStart = new Date(Date.UTC(fiscalYear, startMonth - 1, 1))
  const reversalDate = new Date(Date.UTC(fiscalYear + 1, startMonth - 1, 1))
  const yearEndDate = new Date(reversalDate.getTime() - DAY_MS)

  const months: PeriodKey[] = []
  for (let i = 0; i < 12; i++) {
    // Date.UTC normaliserar månadsöverflödet åt oss: månad 16 blir år+1 månad 4.
    const d = new Date(Date.UTC(fiscalYear, startMonth - 1 + i, 1))
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  }

  const first = months[0] as PeriodKey
  const last = months[11] as PeriodKey
  const { from } = stockholmMonthBounds(first.year, first.month)
  const { to } = stockholmMonthBounds(last.year, last.month)

  return { fiscalYear, startMonth, fiscalStart, yearEndDate, reversalDate, months, from, to }
}

/**
 * Räkenskapsåret ett datum tillhör. Tunn omslagning av `stockholmFiscalYear` —
 * finns för att anropare i bokföringen ska slippa importera tidsmodulen direkt
 * och för att härledningen ska ha EN adress i den här domänen.
 */
export function fiscalYearOf(date: Date, startMonth: number): number {
  return stockholmFiscalYear(date, startMonth)
}
