import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: 'OWNER',
  state: vi.fn(),
  catalog: vi.fn(),
  save: vi.fn(),
  dryRun: vi.fn(),
  list: vi.fn(),
  entries: vi.fn(),
}))

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: mocks.role }, organization: { id: 'o1' } }),
}))
vi.mock('../api/fortnox-export.api', () => ({
  getFortnoxExportState: mocks.state,
  getFortnoxSeriesCatalog: mocks.catalog,
  saveFortnoxExportSettings: mocks.save,
  startFortnoxDryRun: mocks.dryRun,
  listFortnoxExports: mocks.list,
}))
vi.mock('../../accounting/api/accounting.api', () => ({ fetchJournalEntries: mocks.entries }))
vi.mock('@/lib/api', () => ({ extractApiError: () => 'Serverfel' }))

import { FortnoxExportSetup } from './FortnoxExportSetup'

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FortnoxExportSetup />
    </QueryClientProvider>,
  )
}

const ACTIVE = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  connection: { status: 'ACTIVE', exportVoucherSeries: null, exportOmitDimensions: false, ...over },
  exports: { sendingEnabled: false, sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED' },
})

describe('FortnoxExportSetup', () => {
  beforeEach(() => {
    mocks.role = 'OWNER'
    mocks.state.mockResolvedValue(ACTIVE())
    mocks.catalog.mockImplementation(async (id: number | null) => ({
      ready: true,
      reason: null,
      financialYears: [{ id: 1, from: '2026-01-01', to: '2026-12-31' }],
      voucherSeries: id === 1 ? [{ code: 'A', description: 'Redovisning' }] : [],
    }))
    mocks.list.mockResolvedValue([])
    mocks.entries.mockResolvedValue([
      { id: 'je1', date: '2026-10-02', description: 'Reparation', series: 'A', verNumber: 7 },
    ])
    mocks.save.mockResolvedValue(undefined)
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('visas inte för roller utan integrationsadministration', () => {
    mocks.role = 'MANAGER'
    renderIt()
    expect(screen.queryByText(/förhandskontroll/i)).toBeNull()
    expect(mocks.state).not.toHaveBeenCalled()
  })

  it('saknat dimensionsbeslut är ett synligt stopp, inget väljs automatiskt', async () => {
    renderIt()
    expect(await screen.findByText(/inget beslut – förhandskontrollen spärras/)).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Spara beslut' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ omitDimensions: true }))
  })

  it('serie väljs ur Fortnox-katalogen för valt år, inte fritext', async () => {
    renderIt()
    await screen.findByRole('option', { name: '2026-01-01 – 2026-12-31' })
    fireEvent.change(screen.getByLabelText('Räkenskapsår i Fortnox'), { target: { value: '1' } })
    await waitFor(() => expect(mocks.catalog).toHaveBeenCalledWith(1))
    const serie = await screen.findByLabelText('Serie i Fortnox')
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'A – Redovisning' })).toBeTruthy(),
    )
    fireEvent.change(serie, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Spara serie' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ voucherSeries: 'A' }))
  })

  it('READY visas aldrig som skickat; BLOCKED visar skäl', async () => {
    mocks.state.mockResolvedValue(ACTIVE({ exportVoucherSeries: 'A', exportOmitDimensions: true }))
    mocks.dryRun.mockResolvedValueOnce({
      id: 'x',
      journalEntryId: 'je1',
      state: 'DRY_RUN_READY',
      blockReason: null,
      updatedAt: 'now',
    })
    renderIt()
    await screen.findByRole('option', { name: /A7 · 2026-10-02 · Reparation/ })
    fireEvent.change(screen.getByLabelText('Verifikat (senaste 90 dagarna)'), {
      target: { value: 'je1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Förhandskontrollera' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/INTE skickat eller bokfört/)
    mocks.dryRun.mockResolvedValueOnce({
      id: 'x',
      journalEntryId: 'je1',
      state: 'BLOCKED',
      blockReason: 'ACCOUNT_UNVERIFIED: Konto 5999',
      updatedAt: 'now',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Förhandskontrollera' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Skäl: ACCOUNT_UNVERIFIED/),
    )
  })

  it('serverfel vid sparande ger fel, aldrig framgång', async () => {
    mocks.save.mockRejectedValueOnce(new Error('409'))
    renderIt()
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Spara beslut' }))
    expect(await screen.findByText('Serverfel')).toBeTruthy()
  })
})
