import type { MeterReading } from '../types'
import type { SaveReadingReviewInput } from '../schemas'

export type ReviewReading = Pick<
  MeterReading,
  'id' | 'organizationId' | 'meterId' | 'value' | 'readingType' | 'periodStart' | 'periodEnd'
>
export interface ReadingFinding {
  readingId: string
  meterId: string
  code: 'DATA' | 'OVERLAP' | 'DECREASE' | 'HIGH_RATE'
  explanation: string
  sourceReadings: readonly ReviewReading[]
  trend?: {
    current: ReadingRate
    comparison: readonly ReadingRate[]
    median: number
    threshold: number
  }
}
export interface ReadingRate {
  reading: ReviewReading
  previousReading?: ReviewReading
  quantity: number
  days: number
  perDay: number
}
const DAY = 86400000
const format = (value: number) => value.toLocaleString('sv-SE', { maximumFractionDigits: 2 })

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
    const readingsByEnd = new Map<number, ReviewReading[]>()
    for (const r of sorted) {
      const end = Date.parse(r.periodEnd)
      const sameEnd = readingsByEnd.get(end) ?? []
      sameEnd.push(r)
      readingsByEnd.set(end, sameEnd)
    }
    let previous: { end: number; value: number; type: string; reading: ReviewReading } | undefined
    let rates: ReadingRate[] = []
    for (const r of sorted) {
      const start = Date.parse(r.periodStart)
      const end = Date.parse(r.periodEnd)
      const value = typeof r.value === 'string' && !r.value.trim() ? NaN : Number(r.value)
      const add = (
        code: ReadingFinding['code'],
        explanation: string,
        sourceReadings: readonly ReviewReading[] = [r],
        trend?: ReadingFinding['trend'],
      ) =>
        findings.push({
          readingId: r.id,
          meterId: r.meterId,
          code,
          explanation,
          sourceReadings,
          ...(trend ? { trend } : {}),
        })
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
      const sameEnd = readingsByEnd.get(end) ?? []
      if (sameEnd.length > 1) {
        add(
          'OVERLAP',
          'Flera avläsningar för samma mätare har samma periodslut. Det går inte att välja en säker jämförelse.',
          sameEnd,
        )
        previous = undefined
        rates = []
        continue
      }
      const current = { end, value, type: r.readingType, reading: r }
      if (
        previous &&
        (start < previous.end || (r.readingType === 'PERIOD_VOLUME' && start === previous.end))
      ) {
        add(
          'OVERLAP',
          'Mätperioden överlappar föregående period. Kontrollera perioderna innan du bedömer förbrukningen.',
          [previous.reading, r],
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
          [previous.reading, r],
        )
        previous = current
        rates = []
        continue
      }
      if (previous && (previous.type !== r.readingType || start > previous.end + DAY)) {
        // Blanda inte mätarställning med periodvolym eller jämför över luckor.
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
      const previousReading = previous?.reading
      previous = current
      if (quantity === undefined || days === undefined || days <= 0) continue
      const rate = quantity / days
      if (!Number.isFinite(rate)) {
        rates = []
        continue
      }
      const measured: ReadingRate = {
        reading: r,
        ...(r.readingType === 'CUMULATIVE' && previousReading ? { previousReading } : {}),
        quantity,
        days,
        perDay: rate,
      }
      if (rates.length >= 3) {
        const comparison = rates.slice(-3)
        const baseline = comparison.map((entry) => entry.perDay).sort((a, b) => a - b)[1]!
        if (baseline > 0) {
          trendAssessed++
          if (rate >= baseline * 3)
            add(
              'HIGH_RATE',
              `Förbrukningen per dag är ${format(rate / baseline)} gånger medianen för de tre föregående jämförbara perioderna (${format(rate)} mot ${format(baseline)} mätenheter/dag). Kontrollera avläsning och användning; ökningen kan ha en naturlig förklaring.`,
              [
                ...new Map(
                  [...comparison, measured]
                    .flatMap((entry) => [
                      ...(entry.previousReading ? [entry.previousReading] : []),
                      entry.reading,
                    ])
                    .map((reading) => [reading.id, reading]),
                ).values(),
              ],
              { current: measured, comparison, median: baseline, threshold: baseline * 3 },
            )
        }
      }
      rates.push(measured)
    }
  }
  return {
    findings,
    total: readings.length,
    trendAssessed,
    notTrendAssessed: readings.length - trendAssessed,
  }
}

/** Byt version när reglers eller underlagets betydelse ändras. */
export const READING_REVIEW_RULE_VERSION = 'consumption-review-v1'
export type ReadingReviewReport = ReturnType<typeof reviewReadings>
export interface ReadingReviewSnapshot extends Omit<ReadingReviewReport, 'findings'> {
  history: ReadingReviewDecision[]
  ruleVersion: string
  findings: (ReadingFinding & { fingerprint: string; reviews: ReadingReviewDecision[] })[]
}

export interface ReadingReviewDecision {
  id: string
  fingerprint: string
  revision: number
  assessment: SaveReadingReviewInput['assessment']
  comment: string
  reviewedByName: string
  createdAt: string
  evidence: ReadingFinding
}
export const READING_REVIEW_ASSESSMENT_LABELS: Record<
  SaveReadingReviewInput['assessment'],
  string
> = {
  NEEDS_INVESTIGATION: 'Behöver utredas',
  CONFIRMED: 'Avvikelsen bekräftad',
  EXPLAINED: 'Förklarad avvikelse',
}
