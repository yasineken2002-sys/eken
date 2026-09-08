import { reviewReadings, type ReviewReading } from '@eken/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReadingReview, ReadingReviewContent as ReportContent } from './ReadingReview'
const state = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../hooks/useReadingReview', () => ({ useReadingReview: state.query }))
vi.mock('@/hooks/useCanWrite', () => ({ useCurrentRole: () => 'VIEWER' }))
afterEach(cleanup)
beforeEach(() => state.query.mockReset())
const label = () => 'Vatten – Lägenhet 101'
it('visar laddning och hämtar ofiltrerad historik', () => {
  state.query.mockReturnValue({ isLoading: true })
  render(<ReadingReview meterLabel={label} />)
  expect(screen.getByRole('status').textContent).toContain('Hämtar')
  expect(state.query).toHaveBeenCalledWith()
})
it('visar tomhet först efter lyckad hämtning', () => {
  state.query.mockReturnValue({ data: reviewReadings([]) })
  render(<ReadingReview meterLabel={label} />)
  expect(screen.getByText('Inga avläsningar att granska ännu.')).toBeTruthy()
})
it('ger omläsning vid fel, även när tidigare data finns', () => {
  const refetch = vi.fn()
  state.query.mockReturnValue({ isError: true, error: new Error('offline'), data: [], refetch })
  render(<ReadingReview meterLabel={label} />)
  expect(screen.queryByText('Inga avläsningar att granska ännu.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
  expect(refetch).toHaveBeenCalledOnce()
})
it('ger inget falskt klartecken när historiken är kort och har inga skrivknappar', () => {
  render(
    <ReadingReviewContent
      meterLabel={label}
      readings={[
        {
          id: '1',
          organizationId: 'o',
          meterId: 'm',
          value: 10,
          readingType: 'CUMULATIVE',
          periodStart: '2026-01-01',
          periodEnd: '2026-01-01',
        },
      ]}
    />,
  )
  expect(
    screen.getByText(/Avläsningar utan tillräcklig historik har inte trendbedömts/),
  ).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})
it('visar mätare, period och orsak för avvikelsen', () => {
  render(
    <ReadingReviewContent
      meterLabel={label}
      readings={[
        {
          id: '1',
          organizationId: 'o',
          meterId: 'm',
          value: -1,
          readingType: 'CUMULATIVE',
          periodStart: '2026-01-01',
          periodEnd: '2026-01-01',
        },
      ]}
    />,
  )
  expect(screen.getByRole('heading', { name: label() })).toBeTruthy()
  expect(screen.getByText(/ogiltigt värde/)).toBeTruthy()
  expect(screen.getByText('Period: 2026-01-01 – 2026-01-01')).toBeTruthy()
})
it('skiljer behörighetsfel från tom data och serverfel', () => {
  state.query.mockReturnValue({
    isError: true,
    error: { isAxiosError: true, response: { status: 403 } },
  })
  render(<ReadingReview meterLabel={label} />)
  expect(screen.getByText('Du har inte behörighet')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByText('Inga avläsningar att granska ännu.')).toBeNull()
})

function ReadingReviewContent({
  readings,
  meterLabel,
}: {
  readings: readonly ReviewReading[]
  meterLabel: (id: string) => string
}) {
  return <ReportContent report={reviewReadings(readings)} meterLabel={meterLabel} />
}
