import { describe, expect, it } from 'vitest'
import { reviewReadings, type ReviewReading } from './reading-review'

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString()
const row = (
  n: number,
  value: number | string,
  extra: Partial<ReviewReading> = {},
): ReviewReading => ({
  id: String(n),
  organizationId: 'org',
  meterId: 'meter',
  value,
  readingType: 'PERIOD_VOLUME',
  periodStart: day(n),
  periodEnd: day(n),
  ...extra,
})
const history = () => [row(1, 10), row(2, 10), row(3, 10)]

describe('reviewReadings — endast läsanalys', () => {
  it('kräver tre tidigare perioder och flaggar från tre gånger medianen', () => {
    expect(reviewReadings(history()).trendAssessed).toBe(0)
    expect(reviewReadings([...history(), row(4, 29)]).findings).toEqual([])
    const report = reviewReadings([...history(), row(4, 30)])
    expect(report.findings.map((f) => f.code)).toEqual(['HIGH_RATE'])
    expect(report.trendAssessed).toBe(1)
    expect(report.notTrendAssessed).toBe(3)
  })
  it('normaliserar periodvolym per dag', () => {
    expect(reviewReadings([...history(), row(6, 30, { periodStart: day(4) })]).findings).toEqual([])
  })
  it('jämför kumulativa differenser, inte höga mätarställningar', () => {
    const rows = [10000, 10010, 10020, 10030, 10040].map((v, i) =>
      row(i + 1, v, { readingType: 'CUMULATIVE' }),
    )
    expect(reviewReadings(rows)).toMatchObject({ findings: [], trendAssessed: 1 })
    rows[4]!.value = 10060
    expect(reviewReadings(rows).findings[0]?.code).toBe('HIGH_RATE')
  })
  it('visar minskande mätarställning även utan trendhistorik', () => {
    expect(
      reviewReadings([
        row(1, 100, { readingType: 'CUMULATIVE' }),
        row(2, 90, { readingType: 'CUMULATIVE' }),
      ]).findings[0]?.code,
    ).toBe('DECREASE')
  })
  it('ger ingen trendbedömning efter nollbaslinje', () => {
    expect(reviewReadings([row(1, 0), row(2, 0), row(3, 0), row(4, 100)])).toMatchObject({
      findings: [],
      trendAssessed: 0,
    })
  })
  it.each([
    { meterId: 'other' },
    { organizationId: 'other' },
    { readingType: 'CUMULATIVE' as const },
  ])('blandar inte historik: %j', (extra) => {
    expect(reviewReadings([...history(), row(4, 100, extra)]).trendAssessed).toBe(0)
  })
  it('jämför dagsmedel över luckor och redovisar täckningen separat', () => {
    expect(reviewReadings([...history(), row(8, 100)])).toMatchObject({
      trendAssessed: 1,
      findings: [{ code: 'HIGH_RATE' }],
      coverageGaps: [{ periodStart: '2026-01-04', periodEnd: '2026-01-07', days: 4 }],
    })
  })
  it('visar överlappning och använder den inte för trend', () => {
    expect(reviewReadings([...history(), row(4, 100, { periodStart: day(2) })])).toMatchObject({
      trendAssessed: 0,
      findings: [{ code: 'OVERLAP' }],
    })
  })
  it('flaggar båda läsningarna med samma periodslut', () => {
    expect(
      reviewReadings([row(1, 10), row(1, 20, { id: 'duplicate' })]).findings.map((f) => f.code),
    ).toEqual(['OVERLAP', 'OVERLAP'])
  })
  it.each(['', ' ', 'Infinity', 'NaN', -1])('visar ogiltigt värde %s', (value) => {
    expect(reviewReadings([row(1, value)]).findings[0]?.code).toBe('DATA')
  })
  it.each([{ periodEnd: 'invalid' }, { periodStart: day(2) }])(
    'visar ogiltig period %j',
    (extra) => {
      expect(reviewReadings([row(1, 10, extra)]).findings[0]?.code).toBe('DATA')
    },
  )
  it('sorterar tidsstämplar kronologiskt och ändrar inte indata', () => {
    const rows = [
      row(2, 110, {
        readingType: 'CUMULATIVE',
        periodStart: '2026-01-01T23:00:00Z',
        periodEnd: '2026-01-02T00:00:00Z',
      }),
      row(1, 100, {
        readingType: 'CUMULATIVE',
        periodStart: '2026-01-01T22:00:00Z',
        periodEnd: '2026-01-02T01:00:00+02:00',
      }),
    ]
    const before = structuredClone(rows)
    expect(reviewReadings(rows).findings).toEqual([])
    expect(rows).toEqual(before)
  })
})
it('upptäcker minskande ställning även efter en lucka', () => {
  expect(
    reviewReadings([
      row(1, 100, { readingType: 'CUMULATIVE' }),
      row(10, 90, { readingType: 'CUMULATIVE' }),
    ]).findings[0]?.code,
  ).toBe('DECREASE')
})
it('periodvolym räknar delad gränsdag som överlappning', () => {
  expect(reviewReadings([row(1, 10), row(2, 20, { periodStart: day(1) })]).findings[0]?.code).toBe(
    'OVERLAP',
  )
})
