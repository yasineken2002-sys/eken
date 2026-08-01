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

/** `mars 2026` — periodens namn så som operatören tänker på den. */
export function periodLabel(p: { year: number; month: number }): string {
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`
}
