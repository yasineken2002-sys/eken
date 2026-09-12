import type { MeterReading } from '@eken/shared'

export type ReviewReading = Pick<
  MeterReading,
  'id' | 'organizationId' | 'meterId' | 'value' | 'readingType' | 'periodStart' | 'periodEnd'
>
export interface ReadingFinding {
  readingId: string
  meterId: string
  code: 'DATA' | 'OVERLAP' | 'DECREASE' | 'HIGH_RATE'
  explanation: string
}
const DAY = 86400000
const format = (value: number) => value.toLocaleString('sv-SE', { maximumFractionDigits: 2 })

// Formuläret registrerar första→idag. Detta jämför observerade månadsfönster,
// inte förbrukning under de omätta mellandagarna (även första→första är ett fönster).
function monthWindowIndex({ start, end }: { start: number; end: number }) {
  const from = new Date(start)
  const to = new Date(end)
  if (
    start % DAY !== 0 ||
    end % DAY !== 0 ||
    from.getUTCDate() !== 1 ||
    from.getUTCFullYear() !== to.getUTCFullYear() ||
    from.getUTCMonth() !== to.getUTCMonth()
  )
    return undefined
  return from.getUTCFullYear() * 12 + from.getUTCMonth()
}

function consecutiveMonthWindows(
  previous: { start: number; end: number },
  current: { start: number; end: number },
) {
  const month = monthWindowIndex(previous)
  return month !== undefined && monthWindowIndex(current) === month + 1
}

/** Läsanalys, aldrig debiteringsunderlag. Inga ändringar av indata eller sparade belopp. */
export function reviewReadings(readings: readonly ReviewReading[]) {
  const findings: ReadingFinding[] = []
  let trendAssessed = 0
  const groups = new Map<string, ReviewReading[]>()
  for (const r of readings) {
    const key = JSON.stringify([r.organizationId, r.meterId])
    const group = groups.get(key) ?? []
    group.push(r)
    groups.set(key, group)
  }
  for (const rows of groups.values()) {
    const sorted = [...rows].sort(
      (a, b) =>
        (Date.parse(a.periodEnd) || 0) - (Date.parse(b.periodEnd) || 0) || a.id.localeCompare(b.id),
    )
    const endCounts = new Map<number, number>()
    for (const r of sorted) {
      const end = Date.parse(r.periodEnd)
      endCounts.set(end, (endCounts.get(end) ?? 0) + 1)
    }
    let previous: { start: number; end: number; value: number; type: string } | undefined
    let rates: number[] = []
    for (const r of sorted) {
      const start = Date.parse(r.periodStart)
      const end = Date.parse(r.periodEnd)
      const value = typeof r.value === 'string' && !r.value.trim() ? NaN : Number(r.value)
      const add = (code: ReadingFinding['code'], explanation: string) =>
        findings.push({ readingId: r.id, meterId: r.meterId, code, explanation })
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end < start ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        add(
          'DATA',
          'Avläsningen har ett ogiltigt värde eller en ogiltig period. Kontrollera underlaget.',
        )
        previous = undefined
        rates = []
        continue
      }
      if ((endCounts.get(end) ?? 0) > 1) {
        add(
          'OVERLAP',
          'Flera avläsningar för samma mätare har samma periodslut. Det går inte att välja en säker jämförelse.',
        )
        previous = undefined
        rates = []
        continue
      }
      const current = { start, end, value, type: r.readingType }
      if (
        previous &&
        (start < previous.end || (r.readingType === 'PERIOD_VOLUME' && start === previous.end))
      ) {
        add(
          'OVERLAP',
          'Mätperioden överlappar föregående period. Kontrollera perioderna innan du bedömer förbrukningen.',
        )
        previous = current
        rates = []
        continue
      }
      if (
        previous?.type === 'CUMULATIVE' &&
        r.readingType === 'CUMULATIVE' &&
        value < previous.value
      ) {
        add(
          'DECREASE',
          'Mätarställningen är lägre än föregående avläsning. Kontrollera värdet och om mätaren har bytts.',
        )
        previous = current
        rates = []
        continue
      }
      if (
        previous &&
        (previous.type !== r.readingType ||
          (r.readingType === 'PERIOD_VOLUME' &&
            start > previous.end + DAY &&
            !consecutiveMonthWindows(previous, current)))
      ) {
        // Typbyte bryter alltid. Ställningsdifferenser täcker däremot hela tidsavståndet.
        previous = undefined
        rates = []
      }
      let quantity: number | undefined
      let days: number | undefined
      if (r.readingType === 'PERIOD_VOLUME') {
        quantity = value
        days = (end - start) / DAY + 1
      } else if (previous) {
        quantity = value - previous.value
        days = (end - previous.end) / DAY
      }
      previous = current
      if (quantity === undefined || days === undefined || days <= 0) continue
      const rate = quantity / days
      if (!Number.isFinite(rate)) {
        rates = []
        continue
      }
      if (rates.length >= 3) {
        const baseline = [...rates.slice(-3)].sort((a, b) => a - b)[1]!
        if (baseline > 0) {
          trendAssessed++
          if (rate >= baseline * 3)
            add(
              'HIGH_RATE',
              `Förbrukningen per dag är ${format(rate / baseline)} gånger medianen för de tre föregående jämförbara perioderna (${format(rate)} mot ${format(baseline)} mätenheter/dag). Kontrollera avläsning och användning; ökningen kan ha en naturlig förklaring.`,
            )
        }
      }
      rates.push(rate)
    }
  }
  return {
    findings,
    total: readings.length,
    trendAssessed,
    notTrendAssessed: readings.length - trendAssessed,
  }
}
