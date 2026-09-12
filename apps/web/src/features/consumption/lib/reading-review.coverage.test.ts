import { expect, it } from 'vitest'
import { reviewReadings, type ReviewReading } from './reading-review'
const r = (
  id: string,
  start: string,
  end: string,
  type: ReviewReading['readingType'] = 'PERIOD_VOLUME',
): ReviewReading => ({
  id,
  organizationId: 'o',
  meterId: 'm',
  periodStart: start,
  periodEnd: end,
  readingType: type,
  value: id === '1' ? 10 : 20,
})
it.each([
  ['2026-01-01', '2026-01-03', '2026-01-02', '2026-01-02', 1],
  ['2027-12-31', '2028-01-02', '2028-01-01', '2028-01-01', 1],
  ['2028-02-28', '2028-03-01', '2028-02-29', '2028-02-29', 1],
  ['2026-01-01', '2027-01-02', '2026-01-02', '2027-01-01', 365],
] as const)('täcker exakt saknade kalenderdagar mellan %s och %s', (a, b, start, end, days) => {
  const result = reviewReadings([r('1', a, a), r('2', b, b)])
  expect(result.coverageGaps).toEqual([
    { readingId: '2', meterId: 'm', periodStart: start, periodEnd: end, days },
  ])
  expect(result.findings).toEqual([])
  expect(result.trendAssessed).toBe(0)
})
it('påstår ingen lucka före första eller efter sista perioden', () => {
  expect(reviewReadings([r('1', '2026-01-15', '2026-01-20')]).coverageGaps).toEqual([])
})
it('dygnsadjacens och kumulativa differenser har ingen periodvolymslucka', () => {
  expect(
    reviewReadings([r('1', '2026-01-01', '2026-01-01'), r('2', '2026-01-02', '2026-01-02')])
      .coverageGaps,
  ).toEqual([])
  expect(
    reviewReadings([
      r('1', '2026-01-01', '2026-01-01', 'CUMULATIVE'),
      r('2', '2026-03-01', '2026-03-01', 'CUMULATIVE'),
    ]).coverageGaps,
  ).toEqual([])
})
it.each([
  { meterId: 'annan' },
  { organizationId: 'annan' },
  { readingType: 'CUMULATIVE' as const },
])('kopplar inte luckor över %j', (extra) => {
  expect(
    reviewReadings([
      r('1', '2026-01-01', '2026-01-01'),
      { ...r('2', '2026-03-01', '2026-03-01'), ...extra },
    ]).coverageGaps,
  ).toEqual([])
})
it('överlapp ger avvikelse, inte uppdiktad negativ lucka', () => {
  const result = reviewReadings([
    r('1', '2026-01-01', '2026-01-20'),
    r('2', '2026-01-15', '2026-01-25'),
  ])
  expect(result.coverageGaps).toEqual([])
  expect(result.findings.map((f) => f.code)).toEqual(['OVERLAP'])
})
it('tidsstämplar utanför @db.Date ger inte påhittade hela luckdagar', () => {
  expect(
    reviewReadings([
      r('1', '2026-01-01', '2026-01-01'),
      r('2', '2026-01-03T01:00:00Z', '2026-01-04'),
    ]).coverageGaps,
  ).toEqual([])
})
