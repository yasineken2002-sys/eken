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

export interface ReadingCoverageGap {
  readingId: string
  meterId: string
  periodStart: string
  periodEnd: string
  days: number
}

// Den här jämför periodvolym per kalenderdag respektive ställningsförändring per förfluten dag, oavsett datumluckor.
// Den kan inte se förbrukningen mellan periodvolymer eller förklara skillnader från säsong, beläggning eller ändrad användning.
/** Läsanalys, aldrig debiteringsunderlag. Inga ändringar av indata eller sparade belopp. */
export function reviewReadings(readings: readonly ReviewReading[]) {
  const findings: ReadingFinding[] = []
  const coverageGaps: ReadingCoverageGap[] = []
  let trendAssessed = 0
  const groups = new Map<string, ReviewReading[]>()
  for (const r of readings) {
    const key = JSON.stringify([r.organizationId, r.meterId])
    const group = groups.get(key) ?? []
    group.push(r)
    groups.set(key, group)
  }
  for (const rows of groups.values()) {
    const findingOffset = findings.length
    const gapOffset = coverageGaps.length
    const sorted = [...rows].sort(
      (a, b) =>
        (Date.parse(a.periodEnd) || 0) - (Date.parse(b.periodEnd) || 0) || a.id.localeCompare(b.id),
    )
    const endCounts = new Map<number, number>()
    for (const r of sorted) {
      const end = Date.parse(r.periodEnd)
      endCounts.set(end, (endCounts.get(end) ?? 0) + 1)
    }
    let previous: { end: number; value: number; type: string } | undefined
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
      const current = { end, value, type: r.readingType }
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
      // Täckning är en separat upplysning, aldrig ett stopp för normaliserad rate.
      // Bara hela UTC-dagar mellan två registrerade periodvolymer kan härledas här.
      if (
        previous?.type === 'PERIOD_VOLUME' &&
        r.readingType === 'PERIOD_VOLUME' &&
        start % DAY === 0 &&
        previous.end % DAY === 0 &&
        start > previous.end + DAY
      ) {
        coverageGaps.push({
          readingId: r.id,
          meterId: r.meterId,
          periodStart: new Date(previous.end + DAY).toISOString().slice(0, 10),
          periodEnd: new Date(start - DAY).toISOString().slice(0, 10),
          days: (start - previous.end) / DAY - 1,
        })
      }
      if (previous && previous.type !== r.readingType) {
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
    // En senare överlappande period kan täcka en tidigare skenbar lucka.
    // Vid ogiltigt/överlappande underlag avstår hela mätargruppen från täckningsbesked; strukturfynden kvarstår.
    if (findings.slice(findingOffset).some((f) => f.code === 'DATA' || f.code === 'OVERLAP'))
      coverageGaps.splice(gapOffset)
  }
  return {
    findings,
    coverageGaps,
    total: readings.length,
    trendAssessed,
    notTrendAssessed: readings.length - trendAssessed,
  }
}
