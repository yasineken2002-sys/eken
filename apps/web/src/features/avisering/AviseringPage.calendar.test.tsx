import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AviseringPage } from './AviseringPage'
import type { NoticeFilter, RentNotice } from './api/avisering.api'

// Komponentprov med HTTP-liknande listkontrakt. Browser/API/DB verifieras separat.
const state = vi.hoisted(() => ({ rows: [] as RentNotice[], filter: {} as NoticeFilter }))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => vi.fn(),
}))
vi.mock('./hooks/useAvisering', async (original) => ({
  ...(await original<object>()),
  useNotices: (filter: NoticeFilter) => {
    state.filter = filter
    return { data: state.rows.filter((row) => !filter.status || row.status === filter.status) }
  },
  useNoticeStats: () => ({ data: {} }),
  useSendNotices: () => ({}),
  useSendAllNotices: () => ({}),
  useDownloadPdf: () => ({}),
  useReminderPreview: () => ({}),
  useSendOverdueReminders: () => ({}),
  useRentNoticeCreditPreview: () => ({ isLoading: true }),
  useRentNoticeCollectionStatus: () => ({}),
  useRentNoticeEvents: () => ({}),
}))

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it.each([
  ['2026-07-01T21:59:59Z', false],
  ['2026-07-01T22:00:00Z', true],
] as const)('lista, detalj och statusfilter vid %s', async (now, overdue) => {
  vi.setSystemTime(new Date(now))
  state.rows = [
    ['legacy-utc', 'OVERDUE', 5000, '2026-07-01T00:00:00Z'],
    ['legacy-stockholm', 'OVERDUE', 5000, '2026-06-30T22:00:00Z'],
    ['sent', 'SENT', 5000, '2026-07-01T00:00:00Z'],
    ['paid', 'PAID', 0, '2026-07-01T00:00:00Z'],
    ['cancelled', 'CANCELLED', 5000, '2026-07-01T00:00:00Z'],
    ['zero', 'OVERDUE', 0, '2026-07-01T00:00:00Z'],
  ].map(([id, status, payableTotal, dueDate]) => ({
    id,
    ocrNumber: id,
    noticeNumber: id,
    status,
    payableTotal,
    dueDate,
    month: 7,
    year: 2026,
    totalAmount: 9000,
    tenant: { type: 'INDIVIDUAL', firstName: 'Alva', lastName: 'Test', email: 'alva@example.test' },
  })) as RentNotice[]
  render(<AviseringPage />)
  for (const n of state.rows) {
    const row = screen.getByText(n.ocrNumber, { selector: 'span' }).closest('tr')!
    expect(within(row).queryByText('Försenad') !== null).toBe(
      overdue && ['legacy-utc', 'legacy-stockholm', 'sent'].includes(n.id),
    )
    expect(within(row).getByText('2026-07-01')).toBeTruthy()
  }
  fireEvent.click(screen.getByText('legacy-utc', { selector: 'span' }))
  const modal = screen.getByRole('dialog')
  expect(within(modal).queryByText('Försenad') !== null).toBe(overdue)
  fireEvent.click(within(modal).getByLabelText('Stäng'))
  fireEvent.click(screen.getByRole('button', { name: 'Försenade' }))
  expect(screen.queryAllByText('Försenad')).toHaveLength(overdue ? 3 : 0)
  expect(screen.queryByText('zero', { selector: 'span' })).toBeNull()
  // Serverns gamla råstatusfilter får inte förkasta en rad innan visningsregeln ser den.
  expect(state.filter.status).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: 'Skickade' }))
  expect(screen.getByText('zero', { selector: 'span' })).toBeTruthy()
  expect(screen.queryByText('legacy-utc', { selector: 'span' }) !== null).toBe(!overdue)
})
