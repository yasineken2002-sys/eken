// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateReadingInput, ReadingType } from '@eken/shared'
import { reviewReadings, type ReviewReading } from './reading-review'

const ids = vi.hoisted(() => ({
  unit: '11111111-1111-4111-8111-111111111111',
  meter: '22222222-2222-4222-8222-222222222222',
}))
vi.mock('@/features/units/hooks/useUnits', () => ({
  useUnits: () => ({
    data: [{ id: ids.unit, unitNumber: '1', property: { name: 'Syntetiskt hus' } }],
    isLoading: false,
  }),
}))
vi.mock('@/features/leases/hooks/useLeases', () => ({
  useLeases: () => ({ data: [] }),
}))
vi.mock('../hooks/useMeterQueries', () => ({
  useMeters: () => ({
    data: [
      {
        id: ids.meter,
        unitId: ids.unit,
        status: 'ACTIVE',
        type: 'ELECTRICITY',
        unitOfMeasure: 'kWh',
      },
    ],
  }),
}))
vi.mock('../hooks/useReadingQueries', () => ({
  useReadings: () => ({ data: [] }),
}))

const DAY = 86400000
const date = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Datumen hämtas ur verklig ReadingForm och passerar dess submit/schema. */
async function formPeriod(end: string, type: ReadingType, editedStart?: string) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(end + 'T12:00:00Z'))
  // today/firstOfMonth beräknas när den verkliga formulärmodulen laddas.
  vi.resetModules()
  const { ReadingForm } = await import('../components/ReadingForm')
  const submit = vi.fn<(data: CreateReadingInput) => void>()
  render(<ReadingForm onSubmit={submit} onCancel={() => {}} />)
  expect((screen.getByLabelText('Period fr.o.m.') as HTMLInputElement).value).toBe(
    end.slice(0, 8) + '01',
  )
  expect((screen.getByLabelText('Period t.o.m.') as HTMLInputElement).value).toBe(end)
  fireEvent.change(screen.getByLabelText('Enhet'), { target: { value: ids.unit } })
  fireEvent.change(screen.getByLabelText('Mätare'), { target: { value: ids.meter } })
  fireEvent.change(screen.getByLabelText('Avläsningssätt'), { target: { value: type } })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } })
  if (editedStart)
    fireEvent.change(screen.getByLabelText('Period fr.o.m.'), { target: { value: editedStart } })
  fireEvent.click(screen.getByRole('button', { name: 'Registrera avläsning' }))
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  const payload = submit.mock.calls[0]![0]
  expect(payload).toMatchObject({
    meterId: ids.meter,
    readingType: type,
    readingDate: end,
    periodEnd: end,
    periodStart: editedStart ?? end.slice(0, 8) + '01',
  })
  cleanup()
  return payload
}

/** Syntetiska värden med oberoende facit: 10 enheter/dag, sist 270 om spike. */
async function series(
  type: ReadingType,
  periods: { end: string; start?: string }[],
  spike = true,
): Promise<ReviewReading[]> {
  let cumulative = 10000
  const rows: ReviewReading[] = []
  for (const [i, period] of periods.entries()) {
    const payload = await formPeriod(period.end, type, period.start)
    const rate = spike && i === periods.length - 1 ? 270 : 10
    const days =
      type === 'PERIOD_VOLUME'
        ? (Date.parse(payload.periodEnd) - Date.parse(payload.periodStart)) / DAY + 1
        : i
          ? (Date.parse(payload.periodEnd) - Date.parse(rows[i - 1]!.periodEnd)) / DAY
          : 0
    cumulative += rate * days
    rows.push({
      id: String(i),
      organizationId: 'synthetic-org',
      meterId: ids.meter,
      readingType: type,
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      value: type === 'PERIOD_VOLUME' ? rate * days : cumulative,
    })
  }
  return rows
}

const types = ['CUMULATIVE', 'PERIOD_VOLUME'] as const
const count = (type: ReadingType) => (type === 'CUMULATIVE' ? 5 : 4)
const monthly = (type: ReadingType, day: number): { end: string; start?: string }[] =>
  Array.from({ length: count(type) }, (_, month) => ({ end: date(2026, month, day) }))

function expectSpike(rows: ReviewReading[]) {
  const before = structuredClone(rows)
  const result = reviewReadings(rows)
  expect(result.findings.map(({ readingId, code }) => ({ readingId, code }))).toEqual([
    { readingId: rows.at(-1)!.id, code: 'HIGH_RATE' },
  ])
  expect(result.trendAssessed).toBe(1)
  expect(rows).toEqual(before)
}

describe.each(types)('luckregel med verkliga formulärdatum: %s', (type) => {
  it.each([2, 10, 15, 28])('upptäcker 27× hopp med orörda datumfält den %i:e', async (day) => {
    expectSpike(await series(type, monthly(type, day)))
  })

  it.each(['dagliga', 'hela kalendermånader'] as const)('bevarar %s serier', async (cadence) => {
    const periods = Array.from({ length: count(type) }, (_, i) =>
      cadence === 'dagliga'
        ? { start: date(2026, 0, i + 2), end: date(2026, 0, i + 2) }
        : { end: date(2026, i + 1, 0) },
    )
    expectSpike(await series(type, periods))
  })

  it('jämför dygnstakt även när formulärdag och fönsterlängd varierar', async () => {
    const days = [2, 28, 10, 15, 28]
    const periods = Array.from({ length: count(type) }, (_, i) => ({
      end: date(2026, i, days[i]!),
    }))
    expect(reviewReadings(await series(type, periods, false))).toMatchObject({
      findings: [],
      trendAssessed: 1,
    })
    expectSpike(await series(type, periods))
  })

  it('hanterar årsskifte och skottårsdag med UTC-kalender', async () => {
    const periods = Array.from({ length: count(type) }, (_, i) => ({
      end: date(2027, 10 + i + 1, 0),
    }))
    expect(periods.some(({ end }) => end === '2028-02-29')).toBe(true)
    expectSpike(await series(type, periods))
  })

  it('når kalenderundantaget med månadsprefix över årsskifte och skottdag', async () => {
    const days = [10, 10, 10, 29, 10]
    const periods = Array.from({ length: count(type) }, (_, i) => ({
      end: date(2027, 10 + i, days[i]!),
    }))
    expect(periods.some(({ end }) => end === '2028-02-29')).toBe(true)
    expectSpike(await series(type, periods))
  })

  it('jämför dagsmedel även när en hel månad saknas', async () => {
    const periods = monthly(type, 10)
    periods[periods.length - 1] = { end: date(2026, count(type), 10) }
    const result = reviewReadings(await series(type, periods))
    expect(result.trendAssessed).toBe(1)
    expect(result.findings.map((f) => f.code)).toEqual(['HIGH_RATE'])
  })

  it('behåller överlappningsspärren för upprepade månadsfönster inom samma månad', async () => {
    const rows = await series(type, [{ end: '2026-01-10' }, { end: '2026-01-15' }])
    expect(reviewReadings(rows)).toMatchObject({
      trendAssessed: 0,
      findings: [{ code: 'OVERLAP' }],
    })
  })
})

it('periodvolym: jämför enstaka registrerade dagar i olika månader', async () => {
  expectSpike(await series('PERIOD_VOLUME', monthly('PERIOD_VOLUME', 1)))
})

it('periodvolym: en lucka i en daglig serie tystar inte dagsmedlet', async () => {
  const periods = [2, 3, 4, 8].map((day) => ({
    start: date(2026, 0, day),
    end: date(2026, 0, day),
  }))
  expectSpike(await series('PERIOD_VOLUME', periods))
})

it.each(['annan startdag', 'flera månader'] as const)(
  'periodvolym: dagsmedlet fungerar även med %s',
  async (kind) => {
    const periods = monthly('PERIOD_VOLUME', 10)
    periods[3] =
      kind === 'annan startdag'
        ? { start: '2026-04-02', end: '2026-04-10' }
        : { start: '2026-04-01', end: '2026-05-10' }
    expectSpike(await series('PERIOD_VOLUME', periods))
  },
)

it('periodvolym: klockslaget är inte längre en trendspärr (utanför formulärets datumform)', async () => {
  const rows = await series('PERIOD_VOLUME', monthly('PERIOD_VOLUME', 10))
  rows[3]!.periodStart = '2026-04-01T01:00:00Z'
  expect(reviewReadings(rows)).toMatchObject({
    findings: [{ code: 'HIGH_RATE' }],
    trendAssessed: 1,
  })
})

it('kumulativ minskning är fortfarande ett fel även efter en hel saknad månad', async () => {
  const rows = await series('CUMULATIVE', [{ end: '2026-01-10' }, { end: '2026-03-10' }], false)
  rows[1]!.value = Number(rows[0]!.value) - 1
  expect(reviewReadings(rows)).toMatchObject({ trendAssessed: 0, findings: [{ code: 'DECREASE' }] })
})

it('periodvolym: tidigare dagsmedel kan jämföras med ett senare månadsfönster', async () => {
  const periods = [
    { start: '2026-02-08', end: '2026-02-08' },
    { start: '2026-02-09', end: '2026-02-09' },
    { start: '2026-02-10', end: '2026-02-10' },
    { end: '2026-03-10' },
  ]
  expectSpike(await series('PERIOD_VOLUME', periods))
})
