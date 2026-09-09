import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReadingReviewFollowUpStatus } from '@eken/shared'
import { ReadingReviewFollowUp } from './ReadingReviewFollowUp'
import { readingReviewFollowUpState as followUpState } from '@eken/shared'
import {
  getReadingReviewFollowUp,
  updateReadingReviewFollowUp,
} from '../api/reading-review-follow-up.api'

vi.mock('../api/reading-review-follow-up.api', () => ({
  getReadingReviewFollowUp: vi.fn(),
  updateReadingReviewFollowUp: vi.fn(),
}))
const role = vi.hoisted(() => ({ value: 'OWNER' }))
vi.mock('@/hooks/useCanWrite', () => ({ useCurrentRole: () => role.value }))
const off: ReadingReviewFollowUpStatus = {
  enabled: false,
  enabledAt: null,
  lastCheckedAt: null,
  lastFailedAt: null,
}
const on: ReadingReviewFollowUpStatus = {
  ...off,
  enabled: true,
  enabledAt: new Date().toISOString(),
}
let client: QueryClient
function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ReadingReviewFollowUp />
    </QueryClientProvider>,
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  role.value = 'OWNER'
  vi.mocked(getReadingReviewFollowUp).mockResolvedValue(off)
})
afterEach(() => {
  cleanup()
  client?.clear()
  vi.useRealTimers()
})
it('visar inte påslaget förrän servern har bekräftat och stoppar dubbelklick', async () => {
  let resolve!: (value: ReadingReviewFollowUpStatus) => void
  vi.mocked(updateReadingReviewFollowUp).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mount()
  expect(screen.getByText(/Kontrollerar granskningskön/).textContent).toContain('07.15 svensk tid')
  fireEvent.click(await screen.findByRole('button', { name: 'Slå på automatisk uppföljning' }))
  await waitFor(() => expect(updateReadingReviewFollowUp).toHaveBeenCalledOnce())
  expect(updateReadingReviewFollowUp).toHaveBeenCalledWith({ enabled: true }, expect.anything())
  expect((screen.getByRole('button', { name: 'Sparar…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('status').textContent).toContain('avstängd')
  fireEvent.click(screen.getByRole('button', { name: 'Sparar…' }))
  expect(updateReadingReviewFollowUp).toHaveBeenCalledOnce()
  vi.mocked(getReadingReviewFollowUp).mockResolvedValue(on)
  resolve(on)
  expect(
    await screen.findByRole('button', { name: 'Stäng av automatisk uppföljning' }),
  ).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('väntar på första')
})
it('ett nekande lämnar reglaget av och visar felet', async () => {
  vi.mocked(updateReadingReviewFollowUp).mockRejectedValue(new Error('403'))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Slå på automatisk uppföljning' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Ändringen kunde inte bekräftas')
  expect(screen.getByRole('status').textContent).toContain('avstängd')
})
it.each(['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'])(
  '%s kan läsa status men har inget reglage',
  async (value) => {
    role.value = value
    mount()
    await screen.findByText('Automatisk uppföljning är avstängd.')
    expect(screen.queryByRole('button')).toBeNull()
    expect(updateReadingReviewFollowUp).not.toHaveBeenCalled()
  },
)
it('hämtfel döljer tidigare reglage och ger omläsning utan falskt av/på-besked', async () => {
  vi.mocked(getReadingReviewFollowUp).mockRejectedValue(new Error('network'))
  mount()
  expect((await screen.findByRole('alert')).textContent).toContain('kunde inte hämtas')
  expect(screen.queryByText('Automatisk uppföljning är avstängd.')).toBeNull()
  vi.mocked(getReadingReviewFollowUp).mockResolvedValue(off)
  fireEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
  expect(await screen.findByRole('button', { name: 'Slå på automatisk uppföljning' })).toBeTruthy()
})
it('skiljer av, väntande, genomförd, misslyckad och försenad kontroll', () => {
  const now = Date.parse('2026-10-26T07:00:00Z')
  expect(followUpState(off, now)).toBe('off')
  expect(followUpState({ ...on, enabledAt: '2026-10-26T06:00:00Z' }, now)).toBe('waiting')
  expect(
    followUpState(
      { ...on, enabledAt: '2026-10-01T06:00:00Z', lastCheckedAt: '2026-10-25T06:00:00Z' },
      now,
    ),
  ).toBe('checked')
  expect(
    followUpState(
      { ...on, enabledAt: '2026-10-01T06:00:00Z', lastCheckedAt: '2026-10-24T06:00:00Z' },
      now,
    ),
  ).toBe('overdue')
  expect(followUpState({ ...on, enabledAt: '2026-10-01T06:00:00Z' }, now)).toBe('overdue')
  expect(
    followUpState(
      { ...on, lastCheckedAt: '2026-10-24T06:00:00Z', lastFailedAt: '2026-10-25T06:00:00Z' },
      now,
    ),
  ).toBe('failed')
  expect(
    followUpState(
      { ...on, lastCheckedAt: '2026-10-26T06:00:00Z', lastFailedAt: '2026-10-25T06:00:00Z' },
      now,
    ),
  ).toBe('checked')
})
it('visar försenad kontroll och förklarar att den inte godkänner debitering', async () => {
  vi.mocked(getReadingReviewFollowUp).mockResolvedValue({
    ...on,
    enabledAt: '2020-01-01T00:00:00Z',
  })
  mount()
  expect((await screen.findByText(/Den automatiska kontrollen är försenad/)).textContent).toContain(
    'inaktuellt',
  )
  expect(screen.getByText(/inget godkännande av mätvärden/)).toBeTruthy()
})

it('en öppen sida blir försenad även om status-pollningen ger identiska svar', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-09-10T07:14:30Z'))
  vi.mocked(getReadingReviewFollowUp).mockResolvedValue({
    ...on,
    enabledAt: '2026-09-09T05:15:00Z',
  })
  mount()
  await screen.findByText('Påslagen – väntar på första automatiska kontrollen.')
  await act(async () => {
    vi.advanceTimersByTime(60_000)
  })
  expect(screen.getByRole('status').textContent).toContain('försenad')
})
