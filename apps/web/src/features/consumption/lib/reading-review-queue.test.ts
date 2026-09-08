import { expect, it } from 'vitest'
import {
  readingReviewQueue,
  readingReviewState,
  ReadingReviewFilterSchema,
  type ReadingReviewSnapshot,
  type ReadingReviewState,
} from '@eken/shared'

function finding(id: string, state: ReadingReviewState): ReadingReviewSnapshot['findings'][number] {
  const base = {
    readingId: id,
    meterId: id,
    code: 'DATA' as const,
    explanation: 'Kontrollera värdet',
    sourceReadings: [],
    fingerprint: 'current',
    reviews: [],
  }
  return {
    ...base,
    reviews:
      state === 'UNASSESSED'
        ? []
        : [
            {
              id: `review-${id}`,
              revision: 1,
              fingerprint: state === 'CHANGED_EVIDENCE' ? 'old' : 'current',
              assessment: state === 'CHANGED_EVIDENCE' ? 'EXPLAINED' : state,
              comment: 'Mänsklig bedömning',
              reviewedByName: 'Ada',
              createdAt: '2026-09-08T12:00:00Z',
              evidence: base,
            },
          ],
  }
}
const states: ReadingReviewState[] = [
  'UNASSESSED',
  'NEEDS_INVESTIGATION',
  'CHANGED_EVIDENCE',
  'CONFIRMED',
  'EXPLAINED',
]
const rows = states.map((state) => finding(state, state))

it('behåller alla varningar och prioriterar ändrat underlag före utredning och nya bedömningar', () => {
  const before = JSON.stringify(rows)
  const queue = readingReviewQueue(rows)
  expect(queue.findings.map((f) => f.readingId)).toEqual([
    'CHANGED_EVIDENCE',
    'NEEDS_INVESTIGATION',
    'UNASSESSED',
    'CONFIRMED',
    'EXPLAINED',
  ])
  expect(queue.counts).toEqual({
    ALL: 5,
    TO_ASSESS: 3,
    UNASSESSED: 1,
    NEEDS_INVESTIGATION: 1,
    CHANGED_EVIDENCE: 1,
    CONFIRMED: 1,
    EXPLAINED: 1,
  })
  expect(JSON.stringify(rows)).toBe(before)
  for (const row of queue.findings) expect(rows).toContain(row)
})

it.each(ReadingReviewFilterSchema.options)(
  'urval %s behåller rätt medlemmar och räknar hela mängden',
  (filter) => {
    const result = readingReviewQueue(rows, filter)
    const expected =
      filter === 'ALL' ? states : filter === 'TO_ASSESS' ? states.slice(0, 3) : [filter]
    expect(result.findings.map((f) => f.readingId).sort()).toEqual([...expected].sort())
    expect(result.counts.ALL).toBe(5)
    expect(result.counts[filter]).toBe(expected.length)
  },
)

it('bedömningsstatusarna delar hela mängden exakt en gång även med flera varningskoder per avläsning', () => {
  const all = rows.flatMap((row) => [row, { ...row, code: 'OVERLAP' as const }])
  const members = states.flatMap((state) => readingReviewQueue(all, state).findings)
  expect(members).toHaveLength(10)
  expect(new Set(members.map((f) => `${f.readingId}:${f.code}`)).size).toBe(10)
  expect(readingReviewQueue([...all].reverse()).findings).toEqual(readingReviewQueue(all).findings)
})

it('använder senaste revisionen och återupplivar aldrig en äldre matchande bedömning', () => {
  const row = finding('one', 'EXPLAINED')
  const older = row.reviews[0]!
  row.reviews = [older, { ...older, id: 'newer', revision: 2, fingerprint: 'other' }]
  expect(readingReviewState(row)).toBe('CHANGED_EVIDENCE')
  expect(readingReviewQueue([row], 'TO_ASSESS').findings).toEqual([row])
  row.reviews.reverse()
  expect(readingReviewState(row)).toBe('CHANGED_EVIDENCE')
})

it('en ny källa återför en förklarad avvikelse till bedömning, utan att ändra historiken', () => {
  const explained = finding('one', 'EXPLAINED')
  expect(readingReviewQueue([explained], 'TO_ASSESS').findings).toEqual([])
  const changed = { ...explained, fingerprint: 'changed' }
  expect(readingReviewQueue([changed], 'TO_ASSESS').findings).toEqual([changed])
  expect(changed.reviews[0]!.assessment).toBe('EXPLAINED')
})

it('en tom aktuell varningsmängd har noll i alla urval', () => {
  expect(Object.values(readingReviewQueue([]).counts)).toEqual([0, 0, 0, 0, 0, 0, 0])
})
