import { getConsumptionReview } from './tools/consumption-review'
import { reviewReadings } from '@eken/shared'
import {
  realisticConsumptionCases,
  syntheticConsumptionDb,
  SYNTHETIC_ORG,
} from './testing/consumption-realistic.fixtures'

describe('Agent 3: förhandsbestämt facit för fiktiva månadsavläsningar', () => {
  // Om reglerna ändras ska facit omprövas öppet, aldrig genereras från testobjektet.
  for (const variant of [
    'original',
    'omvand-ordning',
    'annan-volymenhet',
    'andra-datum',
  ] as const) {
    it.each(realisticConsumptionCases())(`${variant}: $id`, async (item) => {
      const factor = variant === 'annan-volymenhet' ? 1000 : 1
      let rows = item.rows.map((r) => ({
        ...r,
        value: String(Number(r.value) * factor),
        ...(variant === 'andra-datum'
          ? {
              periodStart: new Date(Date.parse(r.periodStart) + 7 * 86400000).toISOString(),
              periodEnd: new Date(Date.parse(r.periodEnd) + 7 * 86400000).toISOString(),
            }
          : {}),
      }))
      if (variant === 'omvand-ordning') rows = rows.reverse()
      // En annan organisations orimliga värde på SAMMA mätar-id får inte påverka.
      rows.push({
        ...rows[0]!,
        id: 'foreign-reading',
        organizationId: 'synthetic-other-org',
        value: '9999999',
      })
      const before = JSON.stringify(rows)
      const { db, queries } = syntheticConsumptionDb(rows)
      const result = await getConsumptionReview(db, SYNTHETIC_ORG, 'MANAGER', {})
      expect(result.data.summary).toMatchObject({
        readings: item.rows.length,
        trendAssessed: item.expected.trendAssessed,
        notTrendAssessed: item.rows.length - item.expected.trendAssessed,
        totalFindings: item.expected.findings.length,
      })
      const keys = (findings: { readingId: string; code: string }[]) =>
        findings.map((f) => `${f.readingId}:${f.code}`).sort()
      expect(keys(result.data.findings)).toEqual(keys(item.expected.findings))
      if (item.expected.trend) {
        const trend = result.data.findings.find((f) => f.code === 'HIGH_RATE')!.trend!
        expect(trend.current.quantity).toBeCloseTo(item.expected.trend.quantity * factor, 6)
        expect(trend.current.days).toBe(item.expected.trend.days)
        expect(trend.current.perDay).toBeCloseTo(item.expected.trend.perDay * factor, 6)
        expect(trend.median).toBeCloseTo(item.expected.trend.median * factor, 6)
        expect(trend.threshold).toBeCloseTo(item.expected.trend.threshold * factor, 6)
      }
      for (const f of result.data.findings) {
        expect(f.sourceReadings.length).toBeGreaterThan(0)
        expect(
          f.sourceReadings.every(
            (r) => r.organizationId === SYNTHETIC_ORG && r.meterId === f.meterId,
          ),
        ).toBe(true)
        expect(
          f.sourceReadings.every((source) =>
            rows.some((r) => JSON.stringify(r) === JSON.stringify(source)),
          ),
        ).toBe(true)
      }
      expect(
        queries.every(
          (q) => (q.where as { organizationId: string }).organizationId === SYNTHETIC_ORG,
        ),
      ).toBe(true)
      expect(JSON.stringify(rows)).toBe(before)
    })
  }
})

describe('exakta gränser utan avrundad tolerans', () => {
  it.each([
    ['26.999', false],
    ['27', true],
    ['27.001', true],
    // Även en representerbar skillnad mindre än en DB-tusendel behålls.
    ['26.999999999999996', false],
  ])('periodvolym %s', (value, warning) => {
    const item = realisticConsumptionCases().find((c) => c.id === 'exakt-troskel')!
    item.rows[3]!.value = value as string
    expect(reviewReadings(item.rows).findings.some((f) => f.code === 'HIGH_RATE')).toBe(warning)
    if (value === '27')
      expect(reviewReadings(item.rows).findings[0]!.trend).toMatchObject({
        current: { perDay: 0.9 },
        median: 0.3,
        threshold: 0.9,
      })
  })
  it.each([
    ['99999999854.599', false],
    ['99999999854.600', true],
    ['99999999854.601', true],
  ])('stor kumulativ ställning %s med tre decimaler', (value, warning) => {
    const item = realisticConsumptionCases().find((c) => c.id === 'kumulativ-okning')!
    const values = ['99999999800', '99999999808.4', '99999999817.7', '99999999826.7', value]
    item.rows.forEach((row, i) => {
      row.value = values[i] as string
    })
    const report = reviewReadings(item.rows)
    expect(report.trendAssessed).toBe(1)
    expect(report.findings.some((f) => f.code === 'HIGH_RATE')).toBe(warning)
    if (warning)
      expect(report.findings[0]!.trend!.current.quantity).toBeCloseTo(
        value === '99999999854.600' ? 27.9 : 27.901,
        8,
      )
  })
})
