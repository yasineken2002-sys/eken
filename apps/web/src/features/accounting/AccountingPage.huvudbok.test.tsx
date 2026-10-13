/**
 * HUVUDBOK-STEG1 (154) F9: Bokföring visar serverns skäl och döljer de fria skrivknapparna
 * när Fortnox är huvudbok. Vid EVENO (och medan valet ännu inte är läst) är vyn oförändrad.
 * Servern är spärren; detta mäter bara ytan, mot mockat API.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const visa = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccountingPage />
    </QueryClientProvider>,
  )

describe('Bokföring och huvudboksvalet', () => {
  beforeEach(() => api.fetchLedgerOwner.mockReset())
  afterEach(cleanup)

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

  it('valet går inte att läsa: vyn är oförändrad (servern är spärren)', async () => {
    api.fetchLedgerOwner.mockRejectedValue(new Error('nät'))
    visa()
    expect(await screen.findByTestId('new-journal-entry')).toBeTruthy()
    expect(screen.queryByTestId('extern-huvudbok')).toBeNull()
  })
})
