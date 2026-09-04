import { stockholmFiscalYear } from '../common/time/stockholm-period'
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
 * `months` räknas upp ur samma `startMonth` som `fiscalStart`, och fönstret är
 * årets första dag t.o.m. dagen före nästa års första. Det är inte en
 * bekvämlighet utan invarianten: årsstängningen kräver att månad 1–11 är
 * stängda och stänger månad 12, och den frågan blir meningslös om årsfönstret
 * kan innehålla en dag som ingen av de tolv månaderna gör.
 *
 * ── FÖNSTRET ÄR DAGAR, INTE ÖGONBLICK — OCH DET ÄR MÄTT ───────────────────
 *
 * Första versionen härledde `from`/`to` ur `stockholmMonthBounds`, med
 * motiveringen att en post 22:30 UTC den 31 december är 00:30 svensk tid den
 * 1 januari. Den motiveringen är RÄTT för en tidsstämpel och FEL här — och
 * felet var inte teoretiskt.
 *
 * `JournalEntry.date` är `@db.Date`, en dag utan tid. Prisma TRUNKERAR då
 * jämförelseparametern till ett datum, så ett ögonblick 22:00 UTC blir den
 * dagen. Mätt mot riktig Postgres med fyra verifikat och räkenskapsåret
 * maj 2026–april 2027:
 *
 *   Prisma  gte 2026-04-30T22:00Z · lt 2027-04-30T22:00Z → 2026-04-30 · 2026-05-01
 *   rå SQL  samma gränser som ::timestamptz              → 2026-05-01 · 2027-04-30
 *
 * Fönstret sköt alltså in FÖREGÅENDE räkenskapsårs sista dag och tappade sin
 * EGEN. Den tappade dagen är precis den `runYearEndAccrual` daterar sin
 * bokslutspost på, så årsstängningen hade räknat resultatet utan
 * periodiseringen — tyst, och bara hos dem som faktiskt använder den.
 *
 * Rätt fönster för en datumkolumn är DAGARNA själva: `[fiscalStart,
 * reversalDate)`. Det finns ingen tidszonssubtilitet att hantera, eftersom
 * kolumnen inte bär någon tid — det lagrade värdet ÄR det civila datumet.
 *
 * VIKTIGT OM RÄCKVIDDEN: samma fälla gäller varje `gte/lt`-fråga mot
 * `JournalEntry.date` med gränser ur `stockholmMonthBounds`. Den finns kvar i
 * `buildSummary` och i månadsprecheckens kontroller — inte införd av #704 och
 * inte åtgärdad här; se följdärendet.
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
  /** Fönstrets början — räkenskapsårets FÖRSTA DAG, inklusive. Se docblocket. */
  from: Date
  /** Fönstrets slut — NÄSTA räkenskapsårs första dag, exklusive. */
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

  return {
    fiscalYear,
    startMonth,
    fiscalStart,
    yearEndDate,
    reversalDate,
    months,
    from: fiscalStart,
    to: reversalDate,
  }
}

/**
 * Räkenskapsåret ett datum tillhör. Tunn omslagning av `stockholmFiscalYear` —
 * finns för att anropare i bokföringen ska slippa importera tidsmodulen direkt
 * och för att härledningen ska ha EN adress i den här domänen.
 */
export function fiscalYearOf(date: Date, startMonth: number): number {
  return stockholmFiscalYear(date, startMonth)
}
