import type { VatReportingPeriod } from '@prisma/client'

/**
 * T1.4 PR3 — namnger vilka MOMSPERIODER en bakdaterad debitering berör.
 *
 * Ren funktion, ingen bokföringspåverkan. MONTHLY/QUARTERLY är alltid
 * kalenderbaserade (SFL 26 kap), oberoende av brutet räkenskapsår. YEARLY
 * (helårsmoms) redovisas däremot per BESKATTNINGSÅR (SFL 26 kap 11 §) = samma
 * som räkenskapsåret → härleds ur `fiscalYearStartMonth` (vid kalenderår, fym=1,
 * blir etiketten "2026"; vid brutet år t.ex. "maj 2025–apr 2026").
 *
 * Avgör MEDVETET INTE om en period är "redan deklarerad" — det kräver faktiska
 * deklarationsdatum som systemet inte har, och att koda inlämningsfrister vore
 * att skriva lagrum i produktionskod. Vi NAMNGER bara perioderna; människan
 * bedömer om deklarationen lämnats och om en rättelse (SFL 26 kap) behövs.
 */

const MONTH_NAMES = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
]

/**
 * Distinkt, kronologiskt sorterad lista av momsperiod-etiketter för de givna
 * (år, månad)-paren, givet organisationens redovisningsperiod.
 *
 *   MONTHLY   → "mars 2026"
 *   QUARTERLY → "Q1 2026" (Q = kalenderkvartal, jan–mar = Q1)
 *   YEARLY    → "2026" (kalenderår) ELLER "maj 2025–apr 2026" (brutet räkenskapsår)
 *
 * `fiscalYearStartMonth` (1–12, default 1 = kalenderår) används ENDAST för YEARLY
 * (helårsmoms redovisas per beskattningsår, SFL 26 kap 11 §). MONTHLY/QUARTERLY
 * ignorerar den (alltid kalenderbaserade).
 */
export function vatPeriodLabelsForMonths(
  months: ReadonlyArray<{ year: number; month: number }>,
  periodicity: VatReportingPeriod,
  fiscalYearStartMonth = 1,
): string[] {
  // key (numeriskt, för sortering) → etikett (för visning). Dedupar automatiskt.
  const byKey = new Map<number, string>()

  for (const { year, month } of months) {
    let key: number
    let label: string
    if (periodicity === 'MONTHLY') {
      key = year * 12 + (month - 1)
      label = `${MONTH_NAMES[month - 1]} ${year}`
    } else if (periodicity === 'QUARTERLY') {
      const quarter = Math.floor((month - 1) / 3) + 1
      key = year * 4 + (quarter - 1)
      label = `Q${quarter} ${year}`
    } else {
      // YEARLY = beskattningsår. Vid brutet räkenskapsår startar året i
      // fiscalYearStartMonth; en månad före den hör till föregående beskattningsår.
      const fym = fiscalYearStartMonth
      const startYear = month >= fym ? year : year - 1
      key = startYear
      if (fym === 1) {
        label = `${startYear}`
      } else {
        const endMonth = fym - 1 // 1–12
        label = `${MONTH_NAMES[fym - 1]} ${startYear}–${MONTH_NAMES[endMonth - 1]} ${startYear + 1}`
      }
    }
    byKey.set(key, label)
  }

  return [...byKey.entries()].sort(([a], [b]) => a - b).map(([, label]) => label)
}
