import { describe, expect, it } from 'vitest'
import { reviewReadings, type ReviewReading } from './reading-review'
const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString()
const row = (
  n: number,
  value: number | string,
  extra: Partial<ReviewReading> = {},
): ReviewReading => ({
  id: `r${n}`,
  organizationId: 'org',
  meterId: 'meter',
  value,
  readingType: 'PERIOD_VOLUME',
  periodStart: day(n),
  periodEnd: day(n),
  ...extra,
})

describe('varningens underlag', () => {
  it('bevarar exakt de tre senaste perioderna och uträkningen utan att ändra indata', () => {
    const readings = [
      row(1, 100),
      row(2, 10),
      row(3, 20),
      row(4, 30),
      row(6, 120, { periodStart: day(5) }),
    ]
    const before = structuredClone(readings)
    const finding = reviewReadings(readings).findings.find((f) => f.readingId === 'r6')!
    expect(finding.trend).toMatchObject({
      median: 20,
      threshold: 60,
      current: { quantity: 120, days: 2, perDay: 60 },
    })
    expect(finding.trend?.comparison.map((r) => r.reading.id)).toEqual(['r2', 'r3', 'r4'])
    expect(finding.sourceReadings.map((r) => r.id)).toEqual(['r2', 'r3', 'r4', 'r6'])
    expect(readings).toEqual(before)
  })
  it('tar med öppningsställningen som behövs för att kontrollera första differensen', () => {
    const readings = [100, 110, 120, 130, 190].map((v, i) =>
      row(i + 1, v, { readingType: 'CUMULATIVE' }),
    )
    const finding = reviewReadings(readings).findings[0]!
    expect(finding.sourceReadings.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
    expect(finding.trend?.comparison[0]).toMatchObject({
      previousReading: { id: 'r1', value: 100 },
      reading: { id: 'r2', value: 110 },
      quantity: 10,
      days: 1,
      perDay: 10,
    })
    expect(finding.trend?.current).toMatchObject({
      previousReading: { id: 'r4', value: 130 },
      reading: { id: 'r5', value: 190 },
      quantity: 60,
      days: 1,
      perDay: 60,
    })
  })
  it('behåller originalvärden som strängar även när jämförelsen är numerisk', () => {
    const finding = reviewReadings([
      row(1, '100.000', { readingType: 'CUMULATIVE' }),
      row(2, '99.500', { readingType: 'CUMULATIVE' }),
    ]).findings[0]!
    expect(finding.sourceReadings.map((r) => r.value)).toEqual(['100.000', '99.500'])
    expect(finding.trend).toBeUndefined()
  })
  it('tar med alla dubbletter men aldrig andra mätare eller organisationer', () => {
    const finding = reviewReadings([
      row(1, 10),
      row(1, 11, { id: 'duplicate' }),
      row(1, 12, { id: 'other-meter', meterId: 'other' }),
      row(1, 13, { id: 'other-org', organizationId: 'other' }),
    ]).findings[0]!
    expect(finding.sourceReadings.map((r) => r.id).sort()).toEqual(['duplicate', 'r1'])
  })
  it('visar båda perioderna vid överlappning', () => {
    const finding = reviewReadings([
      row(2, 10, { periodStart: day(1) }),
      row(3, 20, { periodStart: day(2) }),
    ]).findings[0]!
    expect(finding.sourceReadings.map((r) => [r.periodStart, r.periodEnd])).toEqual([
      [day(1), day(2)],
      [day(2), day(3)],
    ])
    expect(finding.trend).toBeUndefined()
  })
  it('isolerar även trendunderlaget mellan organisationer', () => {
    const mine = [10, 10, 10, 40].map((v, i) => row(i + 1, v))
    const other = [1, 1, 1, 1].map((v, i) =>
      row(i + 1, v, { id: `other${i}`, organizationId: 'other' }),
    )
    const finding = reviewReadings([...other, ...mine]).findings[0]!
    expect(finding.sourceReadings.every((r) => r.organizationId === 'org')).toBe(true)
    expect(finding.trend?.median).toBe(10)
  })
  it('behåller ogiltigt underlag utan att skapa påhittade beräkningar', () => {
    const finding = reviewReadings([row(1, '', { periodEnd: 'fel' })]).findings[0]!
    expect(finding.sourceReadings[0]).toMatchObject({ value: '', periodEnd: 'fel' })
    expect(finding.trend).toBeUndefined()
  })
})
