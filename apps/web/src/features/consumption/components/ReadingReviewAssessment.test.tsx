import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { reviewReadings, READING_REVIEW_RULE_VERSION } from '@eken/shared'
import type { ReadingReviewSnapshot, ReadingReviewDecision } from '@eken/shared'
import { ReadingReviewContent } from './ReadingReview'
const api = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../api/reading-review.api', () => ({ saveReadingReview: api.save }))
afterEach(() => {
  cleanup()
  api.save.mockReset()
})
const label = () => 'Vatten · Lägenhet 101'
function report(): ReadingReviewSnapshot {
  const base = reviewReadings(
    [10, 10, 10, 40].map((value, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      organizationId: 'org',
      meterId: 'meter',
      value,
      readingType: 'PERIOD_VOLUME',
      periodStart: `2026-01-0${i + 1}`,
      periodEnd: `2026-01-0${i + 1}`,
    })),
  )
  return {
    ...base,
    ruleVersion: READING_REVIEW_RULE_VERSION,
    history: [],
    findings: base.findings.map((f) => ({ ...f, fingerprint: 'a'.repeat(64), reviews: [] })),
  }
}
function decision(r = report()): ReadingReviewDecision {
  return {
    id: 'decision',
    fingerprint: r.findings[0]!.fingerprint,
    revision: 1,
    assessment: 'EXPLAINED',
    comment: 'Kontrollerat mot original',
    reviewedByName: 'Ada Test',
    createdAt: '2026-09-08T12:00:00Z',
    evidence: r.findings[0]!,
  }
}
function mount(r = report(), canAssess = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = (data: ReadingReviewSnapshot) => (
    <QueryClientProvider client={qc}>
      <ReadingReviewContent report={data} meterLabel={label} canAssess={canAssess} />
    </QueryClientProvider>
  )
  const result = render(view(r))
  return { ...result, update: (data: ReadingReviewSnapshot) => result.rerender(view(data)), qc }
}
it('öppning och avbryt sparar inget', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
  expect(api.save).not.toHaveBeenCalled()
})
it('tom motivering stoppas av det delade schemat', async () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.click(screen.getByRole('button', { name: 'Spara bedömning' }))
  await screen.findByText('Ange en motivering')
  expect(api.save).not.toHaveBeenCalled()
})
it('sparar explicit bedömning med exakt underlag och revision', async () => {
  const r = report()
  api.save.mockResolvedValue(decision(r))
  const { qc } = mount(r)
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.change(screen.getByLabelText('Bedömning'), { target: { value: 'EXPLAINED' } })
  fireEvent.change(screen.getByLabelText('Motivering'), {
    target: { value: 'Kontrollerat mot original' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Spara bedömning' }))
  await screen.findByText('Bedömningen har sparats.')
  expect(api.save.mock.calls[0]![0]).toEqual({
    readingId: r.findings[0]!.readingId,
    findingCode: 'HIGH_RATE',
    fingerprint: 'a'.repeat(64),
    expectedRevision: 0,
    assessment: 'EXPLAINED',
    comment: 'Kontrollerat mot original',
  })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['readings', 'review'] })
})
it('visar sparfel och behåller motiveringen', async () => {
  api.save.mockRejectedValue(new Error('offline'))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.change(screen.getByLabelText('Motivering'), { target: { value: 'Behåll denna text' } })
  fireEvent.click(screen.getByRole('button', { name: 'Spara bedömning' }))
  await screen.findByText(/Bedömningen kunde inte sparas/)
  expect((screen.getByLabelText('Motivering') as HTMLTextAreaElement).value).toBe(
    'Behåll denna text',
  )
})
it('409 kräver omläsning och sparar inte igen i samma formulär', async () => {
  api.save.mockRejectedValue({ isAxiosError: true, response: { status: 409 } })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.change(screen.getByLabelText('Motivering'), { target: { value: 'Min text' } })
  fireEvent.click(screen.getByRole('button', { name: 'Spara bedömning' }))
  await screen.findByText(/Underlaget eller bedömningen har ändrats/)
  expect(
    (screen.getByRole('button', { name: 'Spara bedömning' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Läs om granskningen' }))
  await waitFor(() => expect(screen.queryByLabelText('Motivering')).toBeNull())
  expect(api.save).toHaveBeenCalledTimes(1)
})
it('bakgrundsuppdatering låter inte ett öppet formulär skriva över ny bedömning', () => {
  const r = report()
  const { update } = mount(r)
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.change(screen.getByLabelText('Motivering'), { target: { value: 'Osparad text' } })
  const saved = decision(r)
  update({ ...r, findings: r.findings.map((f) => ({ ...f, reviews: [saved] })), history: [saved] })
  expect(
    (screen.getByRole('button', { name: 'Spara bedömning' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect((screen.getByLabelText('Motivering') as HTMLTextAreaElement).value).toBe('Osparad text')
  expect(api.save).not.toHaveBeenCalled()
})
it('läsbehörighet visar historik även utan aktuell varning, men ingen skrivknapp', () => {
  const r = report()
  const saved = decision(r)
  mount({ ...r, findings: [], history: [saved] }, false)
  fireEvent.click(screen.getByText('Bedömningshistorik (1)'))
  expect(screen.getByText('Kontrollerat mot original')).toBeTruthy()
  expect(screen.getByText(/Ada Test/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})
it('gammal bedömning får inget klartecken för ändrat underlag', () => {
  const r = report()
  const saved = decision(r)
  mount({
    ...r,
    findings: r.findings.map((f) => ({ ...f, fingerprint: 'b'.repeat(64), reviews: [saved] })),
    history: [saved],
  })
  expect(screen.getByText('Ändrat underlag – behöver bedömas på nytt')).toBeTruthy()
  expect(screen.queryByText('Senaste bedömning: Förklarad avvikelse')).toBeNull()
})

it('urval räknar varningar och döljer aldrig historiken eller likställer bedömt med åtgärdat', () => {
  const r = report()
  const saved = decision(r)
  mount(
    { ...r, findings: r.findings.map((f) => ({ ...f, reviews: [saved] })), history: [saved] },
    false,
  )
  fireEvent.change(screen.getByLabelText('Visa varningar'), { target: { value: 'TO_ASSESS' } })
  expect(screen.getByText(/Inga varningar i detta urval/)).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Visar 0 av 1 varningar')
  expect(screen.getByText(/En bedömd avvikelse är inte automatiskt åtgärdad/)).toBeTruthy()
  expect(screen.getByText('Bedömningshistorik (1)')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  fireEvent.change(screen.getByLabelText('Visa varningar'), { target: { value: 'EXPLAINED' } })
  expect(screen.getByText('Senaste bedömning: Förklarad avvikelse')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Visar 1 av 1 varningar')
  expect(api.save).not.toHaveBeenCalled()
})

it('ändrat underlag återkommer automatiskt i bedömningskön utan att en ny bedömning skrivs', () => {
  const r = report()
  const saved = decision(r)
  const { update } = mount(
    { ...r, findings: r.findings.map((f) => ({ ...f, reviews: [saved] })) },
    false,
  )
  fireEvent.change(screen.getByLabelText('Visa varningar'), { target: { value: 'TO_ASSESS' } })
  expect(screen.getByText(/Inga varningar i detta urval/)).toBeTruthy()
  update({
    ...r,
    findings: r.findings.map((f) => ({ ...f, fingerprint: 'b'.repeat(64), reviews: [saved] })),
  })
  expect(screen.getByText('Ändrat underlag – behöver bedömas på nytt')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Visar 1 av 1 varningar')
  expect(api.save).not.toHaveBeenCalled()
})

it('bevarar en öppen motivering när ny bedömning flyttar raden ut ur urvalet', () => {
  const r = report()
  const { update } = mount(r)
  fireEvent.change(screen.getByLabelText('Visa varningar'), { target: { value: 'TO_ASSESS' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.change(screen.getByLabelText('Motivering'), {
    target: { value: 'Min osparade utredning' },
  })
  const saved = decision(r)
  update({ ...r, findings: r.findings.map((f) => ({ ...f, reviews: [saved] })), history: [saved] })
  expect(screen.getByText(/Utanför urvalet – formuläret är kvar/)).toBeTruthy()
  expect((screen.getByLabelText('Motivering') as HTMLTextAreaElement).value).toBe(
    'Min osparade utredning',
  )
  expect(
    (screen.getByRole('button', { name: 'Spara bedömning' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
  expect(screen.queryByLabelText('Motivering')).toBeNull()
  expect(screen.getByText(/Inga varningar i detta urval/)).toBeTruthy()
  expect(api.save).not.toHaveBeenCalled()
})

it('behåller formuläret även vid användarens eget filterbyte', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Bedöm varningen' }))
  fireEvent.change(screen.getByLabelText('Motivering'), { target: { value: 'Behåll' } })
  fireEvent.change(screen.getByLabelText('Visa varningar'), { target: { value: 'EXPLAINED' } })
  expect((screen.getByLabelText('Motivering') as HTMLTextAreaElement).value).toBe('Behåll')
  expect(api.save).not.toHaveBeenCalled()
})
