// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { CreateReadingSchema, type CreateReadingInput, type ReadingType } from '@eken/shared'
import { reviewReadings, type ReviewReading } from './reading-review'
import { reviewReadings as before } from './date-space-fixtures/before.test-helpers'
import { reviewReadings as firstFix } from './date-space-fixtures/first-fix.test-helpers'

const ids = vi.hoisted(() => ({
  unit: '11111111-1111-4111-8111-111111111111',
  meter: '22222222-2222-4222-8222-222222222222',
}))
vi.mock('@/features/units/hooks/useUnits', () => ({
  useUnits: () => ({
    data: [{ id: ids.unit, unitNumber: '1', property: { name: 'Syntetiskt hus' } }],
  }),
}))
vi.mock('@/features/leases/hooks/useLeases', () => ({ useLeases: () => ({ data: [] }) }))
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
vi.mock('../hooks/useReadingQueries', () => ({ useReadings: () => ({ data: [] }) }))

const DAY = 86400000
const date = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
const contexts = [
  { id: 'jan20', year: 2026, month: 0, today: 20 },
  { id: 'jan02', year: 2026, month: 0, today: 2 },
  { id: 'nov28', year: 2027, month: 10, today: 28 },
] as const
const starts = ['first', 'middle', 'last'] as const
const ends = ['today', 'last', 'same', 'next'] as const
const spacings = ['successive', 'skip-month', 'same-month'] as const
const types = ['CUMULATIVE', 'PERIOD_VOLUME'] as const
const versions = { before, firstFix, current: reviewReadings }
type Result = ReturnType<typeof reviewReadings>
type Reading = ReturnType<typeof inputFor>
type Observation = {
  id: string
  type: ReadingType
  periods: string
  accepted: string
  results?: Record<string, { trendAssessed: number; findings: string[]; gaps?: unknown }>
}
const observations: Observation[] = []
const receipts = new Map<string, CreateReadingInput | null>()
let instrumentReady = false

function inputFor(
  start: string,
  end: string,
  readingDate: string,
  type: ReadingType,
  value: number,
) {
  return {
    meterId: ids.meter,
    source: 'MANUAL' as const,
    readingType: type,
    value,
    readingDate,
    periodStart: start,
    periodEnd: end,
  }
}

/** Ett kvitto kommer från verkliga datumfält, knapp, resolver och handleClean. */
async function submit(input: Reading, now: string): Promise<CreateReadingInput | null> {
  const key = JSON.stringify([input, now])
  if (receipts.has(key)) return receipts.get(key)!
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(now + 'T12:00:00Z'))
  vi.resetModules()
  const { ReadingForm } = await import('../components/ReadingForm')
  const onSubmit = vi.fn<(value: CreateReadingInput) => void>()
  render(<ReadingForm onSubmit={onSubmit} onCancel={() => {}} />)
  for (const label of ['Period fr.o.m.', 'Period t.o.m.', 'Avläsningsdatum']) {
    const field = screen.getByLabelText(label) as HTMLInputElement
    expect(field.type).toBe('date')
    expect(field.min).toBe('')
    expect(field.max).toBe('')
  }
  expect((screen.getByLabelText('Period fr.o.m.') as HTMLInputElement).value).toBe(
    now.slice(0, 8) + '01',
  )
  expect((screen.getByLabelText('Period t.o.m.') as HTMLInputElement).value).toBe(now)
  fireEvent.change(screen.getByLabelText('Enhet'), { target: { value: ids.unit } })
  fireEvent.change(screen.getByLabelText('Mätare'), { target: { value: ids.meter } })
  fireEvent.change(screen.getByLabelText('Avläsningssätt'), {
    target: { value: input.readingType },
  })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(input.value) } })
  for (const [label, value] of [
    ['Period fr.o.m.', input.periodStart],
    ['Period t.o.m.', input.periodEnd],
    ['Avläsningsdatum', input.readingDate],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Registrera avläsning' }))
  const valid = CreateReadingSchema.safeParse(input).success
  if (valid) {
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toEqual(input)
  } else {
    await waitFor(() =>
      expect(screen.getByText('Periodens slut får inte vara före periodens start')).toBeTruthy(),
    )
    expect(onSubmit).not.toHaveBeenCalled()
  }
  const receipt = valid ? onSubmit.mock.calls[0]![0] : null
  receipts.set(key, receipt)
  cleanup()
  return receipt
}

async function actualRows(
  periods: { start: string; end: string; now: string; readingDate?: string }[],
  type: ReadingType,
) {
  let value = 10000
  const accepted: boolean[] = []
  const rows: ReviewReading[] = []
  for (const [i, p] of periods.entries()) {
    const rate = i === periods.length - 1 ? 270 : 10
    const days =
      type === 'PERIOD_VOLUME'
        ? (Date.parse(p.end) - Date.parse(p.start)) / DAY + 1
        : i
          ? (Date.parse(p.end) - Date.parse(periods[i - 1]!.end)) / DAY
          : 0
    value = type === 'PERIOD_VOLUME' ? rate * Math.max(1, days) : value + rate * Math.max(0, days)
    const payload = await submit(
      inputFor(p.start, p.end, p.readingDate ?? p.now, type, value),
      p.now,
    )
    accepted.push(payload !== null)
    if (payload)
      rows.push({
        id: String(i + 1),
        organizationId: 'synthetic-org',
        meterId: ids.meter,
        ...payload,
        readingType: type,
      })
  }
  return { rows, accepted }
}
function positive(report: Pick<Result, 'findings' | 'trendAssessed'>, lastId: string) {
  expect(report.trendAssessed).toBe(1)
  expect(report.findings.map((f) => [f.code, f.readingId])).toEqual([['HIGH_RATE', lastId]])
}
function measured(rows: ReviewReading[]) {
  const original = structuredClone(rows)
  const results = Object.fromEntries(
    Object.entries(versions).map(([name, run]) => {
      const result = run(rows)
      expect(rows).toEqual(original)
      expect(result.trendAssessed + result.notTrendAssessed).toBe(rows.length)
      return [
        name,
        {
          trendAssessed: result.trendAssessed,
          findings: result.findings.map((f) => f.code + '@' + f.readingId),
          gaps: 'coverageGaps' in result ? result.coverageGaps : undefined,
        },
      ]
    }),
  )
  return results
}
beforeAll(async () => {
  for (const [file, hash] of [
    ['before.test-helpers.ts', 'bbea5274dbe835968792fc8b581804c44dbb52737a825e228f4614bf25866547'],
    [
      'first-fix.test-helpers.ts',
      '6d71bd4e51af82885a71733a575ef725d0db3bec0df41af8fc4bde984e693f37',
    ],
  ])
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./date-space-fixtures/' + file, import.meta.url)))
        .digest('hex'),
    ).toBe(hash)
  for (const type of types) {
    const count = type === 'CUMULATIVE' ? 5 : 4
    const { rows, accepted } = await actualRows(
      Array.from({ length: count }, (_, i) => ({
        start: date(2026, 0, i + 2),
        end: date(2026, 0, i + 2),
        now: date(2026, 0, i + 2),
      })),
      type,
    )
    expect(accepted.every(Boolean)).toBe(true)
    for (const run of Object.values(versions)) positive(run(rows), String(count))
  }
  instrumentReady = true
}, 60000)
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('kanarie: noll från instrumentet avvisas, efter verkliga positiva formulärkontroller', () => {
  expect(instrumentReady).toBe(true)
  expect(() => positive({ findings: [], trendAssessed: 0 }, '4')).toThrow()
})

const cases = contexts.flatMap((context) =>
  types.flatMap((type) =>
    starts.flatMap((start) =>
      ends.flatMap((end) =>
        spacings.map((spacing) => ({
          context,
          type,
          start,
          end,
          spacing,
          id: [context.id, type, start, end, spacing].join('/'),
        })),
      ),
    ),
  ),
)
it.each(cases)(
  '$id',
  async ({ context, type, start, end, spacing, id }) => {
    expect(instrumentReady).toBe(true)
    const count = type === 'CUMULATIVE' ? 5 : 4
    const periods = Array.from({ length: count }, (_, i) => {
      const offset =
        i === count - 1 && spacing !== 'successive' ? i + (spacing === 'skip-month' ? 1 : -1) : i
      const month = context.month + offset
      const first = date(context.year, month, 1)
      const last = date(context.year, month + 1, 0)
      const now = date(context.year, month, context.today)
      const from =
        start === 'first' ? first : start === 'middle' ? date(context.year, month, 15) : last
      const to =
        end === 'today'
          ? now
          : end === 'last'
            ? last
            : end === 'same'
              ? from
              : date(context.year, month + 1, 10)
      return { start: from, end: to, now }
    })
    const { rows, accepted } = await actualRows(periods, type)
    observations.push({
      id,
      type,
      periods: periods.map((p) => p.start + '..' + p.end).join('; '),
      accepted: accepted.map((v) => (v ? 'Y' : 'N')).join(''),
      results: accepted.every(Boolean) ? measured(rows) : undefined,
    })
  },
  30000,
)

it.each(types)('avläsningsdatum kan ligga före/efter perioden: %s', async (type) => {
  const count = type === 'CUMULATIVE' ? 5 : 4
  const periods = Array.from({ length: count }, (_, i) => ({
    start: date(2026, i, 15),
    end: date(2026, i, 20),
    now: date(2026, i, 20),
  }))
  const a = await actualRows(
    periods.map((p) => ({ ...p, readingDate: '2025-01-01' })),
    type,
  )
  const b = await actualRows(
    periods.map((p) => ({ ...p, readingDate: '2029-01-01' })),
    type,
  )
  expect(a.accepted.every(Boolean) && b.accepted.every(Boolean)).toBe(true)
  expect(measured(a.rows)).toEqual(measured(b.rows))
  observations.push({
    id: 'readingDate-before-after/' + type,
    type,
    periods: periods.map((p) => p.start + '..' + p.end).join('; '),
    accepted: 'Y'.repeat(count),
    results: measured(a.rows),
  })
})
it.each(types)('två olika periodslut i samma månad: %s', async (type) => {
  const { rows, accepted } = await actualRows(
    [
      { start: '2026-01-15', end: '2026-01-20', now: '2026-01-20' },
      { start: '2026-01-15', end: '2026-01-28', now: '2026-01-28' },
    ],
    type,
  )
  expect(accepted.every(Boolean)).toBe(true)
  for (const run of Object.values(versions))
    expect(run(rows)).toMatchObject({ trendAssessed: 0, findings: [{ code: 'OVERLAP' }] })
  observations.push({
    id: 'same-month-distinct-ends/' + type,
    type,
    periods: rows.map((p) => p.periodStart + '..' + p.periodEnd).join('; '),
    accepted: 'YY',
    results: measured(rows),
  })
})
afterAll(() => {
  const out = process.env.DATE_SPACE_REPORT
  if (out && instrumentReady)
    writeFileSync(
      out,
      JSON.stringify(
        { cases: cases.length, receipts: receipts.size, instrumentReady, observations },
        null,
        2,
      ) + '\n',
    )
})
