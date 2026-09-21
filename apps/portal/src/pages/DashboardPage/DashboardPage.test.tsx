import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DashboardPage } from './DashboardPage'

/**
 * #913 — VAD TALET PÅ "AVIER"-KORTET FAKTISKT ÄR.
 *
 * `overdueInvoices` är `prisma.invoice.count({ tenantId, status: 'OVERDUE' })`.
 * Bara fakturor, bara statusen OVERDUE. Underraden sa `${n} obetalda` och
 * `else`-grenen sa "Inga förfallna".
 *
 * Båda var fel, och på olika sätt:
 *   • "obetalda" påstår något om betalning. Talet vet bara något om förfall,
 *     och en förfallen rad kan vara betald utan att betalningen registrerats.
 *   • "Inga förfallna" är DIREKT FALSKT för den som har en förfallen AVI men
 *     ingen förfallen faktura — avier räknas aldrig in i talet.
 *
 * Proven låser ordet "fakturor" i båda grenarna. Talet och länkmålet är
 * oförändrade och mäts inte här.
 */

const api = vi.hoisted(() => ({ fetchDashboard: vi.fn() }))

vi.mock('@/api/portal.api', () => ({
  ...api,
  extractApiError: (_err: unknown, fallback = 'Något gick fel') => fallback,
}))

const BAS = {
  tenant: { id: 't1', firstName: 'Yasin', lastName: 'Eken', email: 'y@example.com' },
  activeLease: null,
  upcomingInvoice: null,
  openMaintenanceTickets: 0,
  unreadNotices: 0,
}

function rendera(overdueInvoices: number) {
  api.fetchDashboard.mockResolvedValue({ ...BAS, overdueInvoices })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <DashboardPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('#913 — Avier-kortets underrad säger vad talet är', () => {
  it('ORDET "obetalda" FINNS INTE KVAR', async () => {
    rendera(2)
    await screen.findByText('2 förfallna fakturor')
    expect(screen.queryByText(/obetalda/i)).toBeNull()
  })

  it('flera → "N förfallna fakturor", inte "N obetalda"', async () => {
    rendera(3)
    expect(await screen.findByText('3 förfallna fakturor')).toBeTruthy()
  })

  it('en → korrekt singular', async () => {
    rendera(1)
    expect(await screen.findByText('1 förfallen faktura')).toBeTruthy()
  })

  it('NOLL → "Inga förfallna FAKTUROR", inte bara "Inga förfallna"', async () => {
    // Skillnaden är inte kosmetisk: talet vet ingenting om avier, och kortet
    // heter "Avier". Den som har en förfallen avi fick förut veta att inget var
    // förfallet.
    rendera(0)
    expect(await screen.findByText('Inga förfallna fakturor')).toBeTruthy()
    expect(screen.queryByText('Inga förfallna')).toBeNull()
  })
})
