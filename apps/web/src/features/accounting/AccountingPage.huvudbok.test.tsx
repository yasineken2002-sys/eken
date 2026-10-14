/**
 * HUVUDBOK-STEG1 (154) F9: Bokföring visar serverns skäl och döljer de fria skrivknapparna
 * när Fortnox är huvudbok. Vid EVENO (och medan valet ännu inte är läst) är vyn oförändrad.
 * Servern är spärren; detta mäter bara ytan, mot mockat API.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: 'u', role: 'ACCOUNTANT' }, organization: { id: 'o' } }),
}))

const api = { fetchLedgerOwner: vi.fn() }
vi.mock('./api/accounting.api', async (orig) => {
  const o = (await orig()) as Record<string, unknown>
  return {
    ...o,
    fetchAccounts: async () => [],
    fetchJournalPage: async () => ({ entries: [], total: 0, offset: 0, limit: 100 }),
    fetchLedgerOwner: () => api.fetchLedgerOwner(),
  }
})

import { AccountingPage } from './AccountingPage'

const SKAL =
  'Organisationen har Fortnox som huvudbok. Fria verifikat, utgifter, leverantörsfakturor, rättelser av verifikat och årsbokslut görs i Fortnox, inte i Eveno.'

// En klient per prov som RENSAS efteråt (logg 21/22: utan detta hängde laddningsfallet och
// felfallet gav en ohanterad avvisning; diagnosen i logg 23 med samma livscykel gick igenom).
let klient: QueryClient | null = null
const visa = () => {
  klient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={klient}>
      <AccountingPage />
    </QueryClientProvider>,
  )
}

describe('Bokföring och huvudboksvalet', () => {
  afterEach(() => {
    cleanup()
    klient?.clear()
    klient = null
    api.fetchLedgerOwner.mockReset()
  })

  it('EVENO: skrivknapparna finns, ingen informationsruta', async () => {
    api.fetchLedgerOwner.mockResolvedValue({
      agare: 'EVENO',
      valdAt: null,
      fortnoxDatabasnummer: null,
      skal: null,
    })
    visa()
    expect(await screen.findByTestId('new-journal-entry')).toBeTruthy()
    expect(screen.getByTestId('record-expense')).toBeTruthy()
    expect(screen.queryByTestId('extern-huvudbok')).toBeNull()
  })

  it('FORTNOX: serverns skäl visas och de fria skrivknapparna döljs', async () => {
    api.fetchLedgerOwner.mockResolvedValue({
      agare: 'FORTNOX',
      valdAt: '2026-10-13T22:00:00.000Z',
      fortnoxDatabasnummer: 900154,
      skal: SKAL,
    })
    visa()
    expect((await screen.findByTestId('extern-huvudbok')).textContent).toBe(SKAL)
    expect(screen.queryByTestId('new-journal-entry')).toBeNull()
    expect(screen.queryByTestId('record-expense')).toBeNull()
  })

  it('valet är ännu inte läst: vyn är oförändrad (servern är spärren)', async () => {
    api.fetchLedgerOwner.mockImplementation(() => new Promise(() => undefined))
    visa()
    expect(await screen.findByTestId('new-journal-entry')).toBeTruthy()
    expect(screen.queryByTestId('extern-huvudbok')).toBeNull()
  })

  it('valet går inte att läsa: vyn är oförändrad (servern är spärren)', async () => {
    api.fetchLedgerOwner.mockImplementation(async () => {
      throw new Error('nät')
    })
    visa()
    expect(await screen.findByTestId('new-journal-entry')).toBeTruthy()
    expect(screen.queryByTestId('extern-huvudbok')).toBeNull()
  })
})
