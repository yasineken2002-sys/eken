/**
 * HUVUDBOK-STEG1 (154) F9: huvudboksvalet i kundaktiveringspanelen, mot mockat API.
 * Servern är spärren; här mäts bara att ytan visar valet och att bara OWNER kan välja,
 * bundet till den AKTIVA aktiveringens id och efter en uttrycklig kryssruta.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let roll = 'OWNER'
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: 'u', role: roll }, organization: { id: 'o' } }),
}))
vi.mock('@/features/settings/api/fortnox-export.api', () => ({
  getFortnoxSeriesCatalog: async () => ({ ready: true, financialYears: [], voucherSeries: [] }),
}))

const api = { fetchActivation: vi.fn(), chooseLedgerOwner: vi.fn() }
vi.mock('../api/kundstart.api', async (orig) => {
  const o = (await orig()) as Record<string, unknown>
  return {
    ...o,
    fetchActivation: (fy: number | null) => api.fetchActivation(fy),
    chooseLedgerOwner: (b: unknown) => api.chooseLedgerOwner(b),
  }
})

import { FortnoxCustomerActivationPanel } from './FortnoxCustomerActivationPanel'

const status = (agare: 'EVENO' | 'FORTNOX') => ({
  flaggaPa: false,
  huvudbok: {
    agare,
    valdAt: agare === 'FORTNOX' ? '2026-10-13T22:00:00.000Z' : null,
    fortnoxDatabasnummer: agare === 'FORTNOX' ? 900154 : null,
  },
  aktiv: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', giltig: true },
  aktivHinder: null,
  forslag: { ok: false, hinder: [], text: null, textSha256: null },
  historik: [],
})

const visa = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FortnoxCustomerActivationPanel />
    </QueryClientProvider>,
  )

describe('huvudboksval i kundaktiveringspanelen', () => {
  beforeEach(() => {
    roll = 'OWNER'
    api.fetchActivation.mockReset()
    api.chooseLedgerOwner.mockReset()
  })
  afterEach(cleanup)

  it('EVENO + OWNER: knappen kräver kryssrutan och skickar den aktiva aktiveringens id', async () => {
    api.fetchActivation.mockResolvedValue(status('EVENO'))
    api.chooseLedgerOwner.mockResolvedValue({ agare: 'FORTNOX', valdAt: '' })
    visa()
    expect(await screen.findByText(/Huvudbok:/)).toBeTruthy()
    const knapp = screen.getByRole('button', { name: 'Välj Fortnox som huvudbok' })
    expect((knapp as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Fortnox blir huvudbok/))
    expect((knapp as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(knapp)
    await vi.waitFor(() =>
      expect(api.chooseLedgerOwner).toHaveBeenCalledWith({
        activationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      }),
    )
  })

  it('EVENO + ADMIN: valet visas men kan inte göras', async () => {
    roll = 'ADMIN'
    api.fetchActivation.mockResolvedValue(status('EVENO'))
    visa()
    expect(await screen.findByText(/Huvudbok:/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Välj Fortnox som huvudbok' })).toBeNull()
  })

  it('FORTNOX: visar valet och förklaringen, ingen knapp', async () => {
    api.fetchActivation.mockResolvedValue(status('FORTNOX'))
    visa()
    expect(await screen.findByText(/Fortnox \(vald 2026-10-13, företag 900154\)/)).toBeTruthy()
    expect(screen.getByText(/Valet ändras inte av att anslutningen bryts/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Välj Fortnox som huvudbok' })).toBeNull()
  })
})
