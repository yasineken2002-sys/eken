/**
 * KUNDSTART-001: webbens brytdatum och öppningspaket mot mockat API. Riktig webbläsare
 * (desktop och 390 px) mäts i provkedjan.
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
vi.mock('@/features/settings/api/fortnox.api', () => ({ startFortnoxRead: vi.fn() }))

const api = {
  fetchCutover: vi.fn(),
  fetchPackages: vi.fn(),
  fetchPackage: vi.fn(),
  saveCutover: vi.fn(),
  approvePackage: vi.fn(),
  executePackage: vi.fn(),
}
vi.mock('../api/kundstart.api', async (orig) => {
  const o = (await orig()) as Record<string, unknown>
  return {
    ...o,
    fetchCutover: () => api.fetchCutover(),
    fetchPackages: () => api.fetchPackages(),
    fetchPackage: (id: string) => api.fetchPackage(id),
    saveCutover: (d: string | null) => api.saveCutover(d),
    approvePackage: (id: string, b: unknown) => api.approvePackage(id, b),
    executePackage: (id: string) => api.executePackage(id),
  }
})

import { KundstartPanel } from './KundstartPanel'

const paket = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  status: 'VALIDATED',
  version: 2,
  sourceName: 'paket.csv',
  sourceSha256: 'a'.repeat(64),
  zeroOpening: false,
  reconciliationStatus: 'DIFFERENS',
  createdAt: '',
  executedAt: null,
  cutoverDate: '2026-11-01',
  orgNumber: '559999-0001',
  fortnoxReadRunId: 'r1',
  fortnoxBalance1510Ore: 3821200,
  fortnoxBalance2890Ore: 1200000,
  totals: { fordranOre: 1000000, depositionOre: 1200000, rader: 1 },
  reconciliation: {
    status: 'DIFFERENS',
    beraknad: '',
    konton: [
      {
        konto: '1510',
        paketOre: 1000000,
        fortnoxOre: 3821200,
        differensOre: 2821200,
        spec: null,
        status: 'DIFFERENS',
        text: 'Oförklarad differens på konto 1510',
      },
    ],
  },
  approvedAt: null,
  approvedVersion: null,
  invalidatedReason: null,
  felrader: 0,
  rows: [
    {
      id: 'r',
      rowNo: 1,
      sourceId: 'F1',
      kind: 'RECEIVABLE',
      tenantRef: '7771000011',
      leaseRef: 'K-1',
      propertyRef: null,
      unitRef: null,
      periodYear: 2026,
      periodMonth: 10,
      dueDate: '2026-10-31',
      receivedDate: null,
      originalAmount: '6000.00',
      openAmount: '6000.00',
      tenantId: 't',
      leaseId: 'l',
      errors: [],
    },
  ],
  ...over,
})

function rendera() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <KundstartPanel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  roll = 'OWNER'
  for (const f of Object.values(api)) f.mockReset()
  api.fetchCutover.mockResolvedValue({
    cutoverDate: '2026-11-01',
    setAt: null,
    setById: null,
    locked: false,
    lockReason: null,
  })
  api.fetchPackages.mockResolvedValue([paket()])
  api.fetchPackage.mockResolvedValue(paket())
})
afterEach(cleanup)

describe('KundstartPanel', () => {
  it('visar brytdatum och låter bara OWNER ändra det', async () => {
    rendera()
    await screen.findByText('2026-11-01')
    expect(screen.getByLabelText('Brytdatum, månad')).toBeTruthy()
    cleanup()
    roll = 'ADMIN'
    rendera()
    await screen.findByText('2026-11-01')
    expect(screen.queryByLabelText('Brytdatum, månad')).toBeNull()
    expect(screen.getByText(/Bara ägaren \(OWNER\) sätter brytdatum/)).toBeTruthy()
  })

  it('spärrat brytdatum visar skälet och ingen ändringsmöjlighet', async () => {
    api.fetchCutover.mockResolvedValue({
      cutoverDate: '2026-11-01',
      setAt: null,
      setById: null,
      locked: true,
      lockReason: 'Ett öppningspaket är verkställt — brytdatumet kan inte flyttas.',
    })
    rendera()
    await screen.findByText(/kan inte flyttas/)
    expect(screen.queryByLabelText('Brytdatum, månad')).toBeNull()
  })

  it('DIFFERENS: förklaras, ingen kvitteringsknapp finns; godkännande binds till version och sha', async () => {
    api.approvePackage.mockResolvedValue(paket({ status: 'APPROVED' }))
    rendera()
    fireEvent.click(await screen.findByText('paket.csv'))
    await screen.findByText(/kan inte godkännas bort/)
    expect(screen.queryByRole('button', { name: /kvittera|godkänn differens/i })).toBeNull()
    const knapp = screen.getByRole('button', { name: 'Godkänn paketet' }) as HTMLButtonElement
    expect(knapp.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /granskat version 2/ }))
    fireEvent.click(knapp)
    await vi.waitFor(() =>
      expect(api.approvePackage).toHaveBeenCalledWith('p1', {
        version: 2,
        sourceSha256: 'a'.repeat(64),
      }),
    )
  })

  it('ADMIN kan inte godkänna eller verkställa', async () => {
    roll = 'ADMIN'
    api.fetchPackage.mockResolvedValue(paket({ status: 'APPROVED' }))
    rendera()
    fireEvent.click(await screen.findByText('paket.csv'))
    await screen.findByText(/Bara ägaren \(OWNER\) verkställer/)
    expect(screen.queryByRole('button', { name: 'Verkställ paketet' })).toBeNull()
  })

  it('felrader visas per rad', async () => {
    api.fetchPackage.mockResolvedValue(
      paket({
        status: 'DRAFT',
        felrader: 1,
        rows: [{ ...paket().rows[0], errors: ['Perioden ligger utanför avtalets löptid.'] }],
      }),
    )
    rendera()
    fireEvent.click(await screen.findByText('paket.csv'))
    expect((await screen.findAllByText(/utanför avtalets löptid/)).length).toBeGreaterThan(0)
  })
})
