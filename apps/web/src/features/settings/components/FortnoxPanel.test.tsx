import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FortnoxReadView, FortnoxStatusResponse } from '../api/fortnox.api'

const mocks = vi.hoisted(() => ({
  role: 'OWNER',
  useFortnox: vi.fn(),
  refetch: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: { id: 'user-A', role: mocks.role },
      organization: { id: 'org-A' },
    }),
}))
vi.mock('../hooks/useFortnox', () => ({ useFortnox: mocks.useFortnox }))
vi.mock('./FortnoxReadSetup', () => ({
  FortnoxReadSetup: ({ onAccessDenied }: { onAccessDenied: () => void }) => (
    <button onClick={onAccessDenied}>Simulera nekad katalog</button>
  ),
}))
vi.mock('@/lib/api', () => ({
  isForbidden: (error: { status?: number } | null) => error?.status === 403,
  isUnavailable: (error: { status?: number } | null) => error?.status === 503,
}))

import { FortnoxPanel } from './FortnoxPanel'

const read = (): FortnoxReadView => ({
  id: 'read-A',
  status: 'COMPLETE_WITH_UNCERTAINTY',
  financialYearId: 9,
  selectedAccounts: [4010, 5070],
  periodFrom: '2026-09-01',
  periodTo: '2026-09-30',
  startedAt: '2026-10-01T10:00:00Z',
  completedAt: '2026-10-01T10:02:00Z',
  reason: null,
  uncertainties: ['En dimension saknar koppling.'],
  coverage: {
    vouchers: { pages: 2, totalPages: 2, totalResources: 31, itemsSeen: 31 },
  },
  summary: {
    currency: 'SEK',
    totalOre: 2300000,
    byProperty: [{ propertyId: 'p-A', propertyName: 'Eken 1', amountOre: 1900000 }],
    unmappedDimensions: [{ dimensionType: 'PROJECT', code: 'P22', amountOre: 200000 }],
    unallocatedOre: 200000,
    uncertainRemovedOre: 50000,
    evenoExportOre: 1200000,
  },
})
const data = (): FortnoxStatusResponse => ({
  enabled: true,
  connection: {
    status: 'ACTIVE',
    company: {
      name: 'Testbolaget',
      orgNumber: '556000-0000',
      databaseNumber: 42,
    },
    connectedAt: '2026-09-30T10:00:00Z',
    disconnectedAt: null,
    lastErrorClass: null,
    lastErrorAt: null,
  },
  mappings: [],
  latestRead: read(),
  latestCompleteRead: read(),
  exports: {
    counts: { DRY_RUN_READY: 1, BLOCKED: 2, UNKNOWN: 1, CONFIRMED: 0 },
    needsReconciliation: 1,
    sendingEnabled: false,
    sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED',
  },
})
function setup(over: Record<string, unknown> = {}) {
  mocks.useFortnox.mockReturnValue({
    status: {
      data: data(),
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      refetch: mocks.refetch,
      ...over,
    },
    connect: { isPending: false, error: null, mutateAsync: mocks.connect },
    disconnect: {
      isPending: false,
      error: null,
      mutateAsync: mocks.disconnect,
    },
  })
  return render(<FortnoxPanel />)
}
beforeEach(() => {
  mocks.role = 'OWNER'
  vi.clearAllMocks()
})
afterEach(cleanup)

describe('FortnoxPanel', () => {
  it('C2 U-1: sändningsläget visas som det är — aldrig "inte aktiverad" när sändning är på', () => {
    setup()
    expect(screen.getByText('Sändning är inte aktiverad')).toBeTruthy()
    cleanup()
    const on = data()
    on.exports = {
      ...on.exports,
      sendingEnabled: true,
      sendingDisabledReason: null,
    }
    setup({ data: on })
    expect(screen.getByText('Sändning är aktiverad endast för testföretaget')).toBeTruthy()
    expect(screen.queryByText('Sändning är inte aktiverad')).toBeNull()
  })
  it('never presents a net amount without its saved account provenance', () => {
    const value = data()
    value.latestCompleteRead = { ...read(), selectedAccounts: [] }
    setup({ data: value })
    expect(screen.getByText(/Sparat kontourval saknas/)).toBeTruthy()
    expect(screen.queryByText('Nettobelopp för valda konton')).toBeNull()
    expect(screen.queryByText(/23\s*000/)).toBeNull()
  })
  it('shows the saved account set with the net amount and hides all data on catalog denial', () => {
    setup()
    expect(screen.getByText('Nettobelopp för valda konton')).toBeTruthy()
    expect(screen.getAllByText('4010, 5070').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Simulera nekad katalog' }))
    expect(screen.getByText('Du har inte behörighet')).toBeTruthy()
    expect(screen.queryByText('Testbolaget')).toBeNull()
  })
  it('hides cached financial data when a mutation returns 403', () => {
    const view = setup()
    const state = mocks.useFortnox.mock.results[0]?.value
    state.connect.error = { status: 403 }
    view.rerender(<FortnoxPanel />)
    expect(screen.getByText('Du har inte behörighet')).toBeTruthy()
    expect(screen.queryByText('Testbolaget')).toBeNull()
  })
  it.each(['MANAGER', 'ACCOUNTANT', 'VIEWER'])('stops %s before the status hook', (role) => {
    mocks.role = role
    setup()
    expect(mocks.useFortnox).not.toHaveBeenCalled()
    expect(screen.getByText('Du har inte behörighet')).toBeTruthy()
  })
  it('renders loading without a zero amount or connection action', () => {
    setup({ data: undefined, isLoading: true })
    expect(screen.getByRole('status').textContent).toContain('Hämtar')
    expect(screen.queryByText(/0,00/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Anslut Fortnox' })).toBeNull()
  })
  it('inert module has no connect button', () => {
    const value = data()
    value.enabled = false
    value.connection = null
    setup({ data: value })
    expect(screen.getByText('Inte aktiverat')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Anslut Fortnox' })).toBeNull()
  })
  it('403 hides already cached financial data', () => {
    setup({ isError: true, error: { status: 403 } })
    expect(screen.getByText('Du har inte behörighet')).toBeTruthy()
    expect(screen.queryByText('Testbolaget')).toBeNull()
    expect(screen.queryByText(/23\s*000/)).toBeNull()
  })
  it('a load error offers a retry without treating missing data as zero', () => {
    setup({ data: undefined, isError: true, error: { status: 500 } })
    fireEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/0,00/)).toBeNull()
  })
  it('missing data is not a successful empty state', () => {
    setup({ data: undefined })
    expect(screen.getByRole('button', { name: 'Försök igen' })).toBeTruthy()
    expect(screen.queryByText('Inga fastighetskopplingar registrerade.')).toBeNull()
  })
  it('separates failed latest attempt from older completed amounts and coverage', () => {
    const value = data()
    value.latestRead = {
      ...read(),
      id: 'read-B',
      status: 'FAILED',
      startedAt: '2026-10-01T12:00:00Z',
      completedAt: '2026-10-01T12:01:00Z',
      summary: null,
      reason: 'Kunde inte läsa nästa sida.',
    }
    setup({ data: value })
    expect(screen.getByText('Läsningen misslyckades')).toBeTruthy()
    expect(screen.getByText('Ingen aktuell summa')).toBeTruthy()
    expect(screen.getByText(/Tidigare underlag/)).toBeTruthy()
    expect(screen.getByText(/23\s*000,00/)).toBeTruthy()
    expect(screen.getAllByText(/2 av 2 sidor/).length).toBe(2)
  })
  it('does not add Eveno exports to total or offer send for UNKNOWN', () => {
    setup()
    expect(screen.getByText(/23\s*000,00/)).toBeTruthy()
    expect(screen.queryByText(/35\s*000,00/)).toBeNull()
    expect(screen.getByText('Varav Eveno-exporter, redan inräknade')).toBeTruthy()
    expect(screen.getByText(/kräver avstämning i Fortnox/)).toBeTruthy()
    expect(screen.getByText('Sändning är inte aktiverad')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /skicka|sänd|exportera/i })).toBeNull()
  })
  it('shows unmapped, excluded and uncertainty as their own facts', () => {
    setup()
    expect(screen.getByText('Saknar fastighetskoppling')).toBeTruthy()
    expect(screen.getByText(/Projekt P22/)).toBeTruthy()
    expect(screen.getByText('Uteslutna osäkra rader')).toBeTruthy()
    expect(screen.getByText('Underlaget innehåller osäkerheter')).toBeTruthy()
  })
  it('a partial read never exposes a nonnull accidental summary as current', () => {
    const value = data()
    value.latestRead = { ...read(), status: 'PARTIAL' }
    value.latestCompleteRead = null
    setup({ data: value })
    expect(screen.getByText('Ingen aktuell summa')).toBeTruthy()
    expect(screen.queryByText(/23\s*000,00/)).toBeNull()
  })
  it('requires local disconnect confirmation and supports cancelling', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Koppla från' }))
    expect(mocks.disconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Bekräfta frånkoppling' })).toBeNull()
  })
  it('ADMIN gets connection action when enabled and disconnected', () => {
    mocks.role = 'ADMIN'
    const value = data()
    value.connection = null
    setup({ data: value })
    expect(screen.getByRole('button', { name: 'Anslut Fortnox' })).toBeTruthy()
  })
})
