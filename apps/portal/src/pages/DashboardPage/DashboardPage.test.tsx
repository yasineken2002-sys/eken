import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DashboardPage } from './DashboardPage'
import { NoticesPage } from '../NoticesPage/NoticesPage'

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

const api = vi.hoisted(() => ({
  fetchDashboard: vi.fn(),
  fetchInvoices: vi.fn(),
  fetchRentNotices: vi.fn(),
  fetchMiscCharges: vi.fn(),
  downloadInvoicePdf: vi.fn(),
  downloadRentNoticePdf: vi.fn(),
}))

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


// ── #915 — KORTET SOM VISADE FAKTUROR OCH HETTE AVIER ──────────────────────
//
// Talet är `invoice.count({ status: 'OVERDUE' })`. Kortet hette "Avier" och
// länkade till `/notices`, vilket öppnar AVI-fliken — den som klickade på talet
// kom alltså till en lista där talet inte fanns.
//
// Proven nedan prövar KLICK → RÄTT FLIK på riktigt: hela routern monteras och
// `NoticesPage` renderas efter navigeringen. Att bara kontrollera att
// `navigate` anropades med en sträng hade prövat mitt eget argument, inte att
// vägen fungerar.

function renderaMedRouter(overdueInvoices: number) {
  api.fetchDashboard.mockResolvedValue({ ...BAS, overdueInvoices })
  api.fetchInvoices.mockResolvedValue([])
  api.fetchRentNotices.mockResolvedValue([])
  api.fetchMiscCharges.mockResolvedValue([])
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/notices" element={<NoticesPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('#915 — kortet heter Fakturor och går till fakturafliken', () => {
  it('RUBRIKEN är "Fakturor", inte "Avier"', async () => {
    renderaMedRouter(2)
    expect(await screen.findByText('Fakturor')).toBeTruthy()
    // "Avier" ska inte längre stå som kortrubrik. (Bottennavigeringen och
    // "Senaste avi" ligger utanför den här vyn och rörs inte.)
    expect(screen.queryByText('Avier')).toBeNull()
  })

  it('TALET ÄR OFÖRÄNDRAT — rubriken följde talet, inte tvärtom', async () => {
    renderaMedRouter(2)
    expect(await screen.findByText('2 förfallna fakturor')).toBeTruthy()
  })

  it('KLICK PÅ KORTET ÖPPNAR FAKTURAFLIKEN — mätt, inte antaget', async () => {
    renderaMedRouter(2)
    fireEvent.click(await screen.findByText('Fakturor'))
    // NoticesPage har renderats. Fakturafliken ska vara den valda.
    const fakturafliken = await screen.findByRole('tab', { name: 'Fakturor' })
    await waitFor(() => expect(fakturafliken.getAttribute('aria-selected')).toBe('true'))
    // Och avifliken ska INTE vara vald — annars hade provet varit grönt för att
    // båda råkade se valda ut.
    expect(screen.getByRole('tab', { name: 'Avier' }).getAttribute('aria-selected')).toBe('false')
  })

  it('KANARIEFÅGEL: utan ?tab=invoices öppnas avifliken', async () => {
    // Om det här provet faller betyder det att flikvalet inte längre styrs av
    // sökparametern — och då mäter provet ovan ingenting.
    api.fetchRentNotices.mockResolvedValue([])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter initialEntries={['/notices']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/notices" element={<NoticesPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    )
    const avifliken = await screen.findByRole('tab', { name: 'Avier' })
    expect(avifliken.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Fakturor' }).getAttribute('aria-selected')).toBe(
      'false',
    )
  })
})
