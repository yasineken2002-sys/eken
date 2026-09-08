import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { READING_REVIEW_RULE_VERSION, reviewReadings } from '@eken/shared'
import { ReadingReview } from '../components/ReadingReview'
const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', () => ({ get: api.get, isForbidden: () => false }))
afterEach(() => {
  cleanup()
  api.get.mockReset()
})
it('hämtar API-rapporten och invalideras tillsammans med nya avläsningar', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const data = { ...reviewReadings([]), ruleVersion: READING_REVIEW_RULE_VERSION }
  api.get.mockResolvedValue(data)
  render(
    <QueryClientProvider client={qc}>
      <ReadingReview meterLabel={() => 'Mätare'} />
    </QueryClientProvider>,
  )
  await screen.findByText('Inga avläsningar att granska ännu.')
  expect(api.get).toHaveBeenCalledWith('/consumption/reading-review')
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['readings'] })
  })
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  qc.clear()
})
it('visar API:ts varning och räknare utan en ny klientberäkning', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Skilda räknare och en förklaring som inte kan skapas av webbläsarens regler.
  api.get.mockResolvedValue({
    total: 123,
    trendAssessed: 7,
    notTrendAssessed: 116,
    ruleVersion: READING_REVIEW_RULE_VERSION,
    findings: [
      {
        readingId: 'r',
        meterId: 'm',
        code: 'DATA',
        fingerprint: 'a'.repeat(64),
        explanation: 'Förklaring från API',
        sourceReadings: [
          {
            id: 'r',
            organizationId: 'o',
            meterId: 'm',
            value: 1,
            readingType: 'PERIOD_VOLUME',
            periodStart: '2026-01-01',
            periodEnd: '2026-01-01',
          },
        ],
      },
    ],
  })
  render(
    <QueryClientProvider client={qc}>
      <ReadingReview meterLabel={() => 'Mätare'} />
    </QueryClientProvider>,
  )
  await screen.findByText('Förklaring från API')
  expect(screen.getByText('123')).toBeTruthy()
  expect(screen.getByText('116')).toBeTruthy()
  qc.clear()
})
