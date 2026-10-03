import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  org: 'org-A',
  user: 'owner-A',
  role: 'OWNER',
  state: vi.fn(),
  catalog: vi.fn(),
  save: vi.fn(),
  dryRun: vi.fn(),
  list: vi.fn(),
  entries: vi.fn(),
}))
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: unknown) => unknown) =>
    select({ user: { id: mocks.user, role: mocks.role }, organization: { id: mocks.org } }),
}))
vi.mock('../api/fortnox-export.api', () => ({
  getFortnoxExportState: mocks.state,
  getFortnoxSeriesCatalog: mocks.catalog,
  saveFortnoxExportSettings: mocks.save,
  startFortnoxDryRun: mocks.dryRun,
  listFortnoxExports: mocks.list,
}))
// F-LIST-1: väljaren hämtar hela urvalet sidvis; provet styr samma lista som förut.
vi.mock('../../accounting/api/accounting.api', () => ({
  fetchAllJournalEntries: async (...args: unknown[]) => {
    const entries = (await mocks.entries(...args)) as unknown[]
    return { entries, total: (mocks as { total?: number }).total ?? entries.length }
  },
}))
vi.mock('@/lib/api', () => ({ extractApiError: () => 'Serverfel' }))
import { FortnoxExportSetup } from './FortnoxExportSetup'
const active = (enabled = true) => ({
  enabled,
  connection: { status: 'ACTIVE', exportVoucherSeries: 'A', exportOmitDimensions: false },
  exports: { sendingEnabled: false, sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED' },
})
const row = (state = 'DRY_RUN_READY', id = 'je-A1') => ({
  id: 'export-' + id,
  journalEntryId: id,
  state,
  blockReason: null,
  updatedAt: '2026-10-01T12:00:00Z',
})
let client: QueryClient
beforeEach(() => {
  vi.clearAllMocks()
  mocks.org = 'org-A'
  mocks.user = 'owner-A'
  mocks.role = 'OWNER'
  mocks.state.mockImplementation(async () => active())
  mocks.catalog.mockImplementation(async (id: number | null) => ({
    ready: true,
    reason: null,
    financialYears: [{ id: 1, from: '2026-01-01', to: '2026-12-31' }],
    voucherSeries: id === 1 ? [{ code: 'A', description: 'Serie A' }] : [],
  }))
  mocks.entries.mockImplementation(async () => [
    {
      id: `je-${mocks.org}1`,
      date: '2026-10-01',
      description: `Verifikat ${mocks.org} 1`,
      series: 'A',
      verNumber: 1,
    },
    {
      id: `je-${mocks.org}2`,
      date: '2026-10-01',
      description: `Verifikat ${mocks.org} 2`,
      series: 'A',
      verNumber: 2,
    },
  ])
  mocks.list.mockResolvedValue([])
  mocks.save.mockResolvedValue(undefined)
  mocks.dryRun.mockImplementation(async ({ journalEntryId }: { journalEntryId: string }) =>
    row('DRY_RUN_READY', journalEntryId),
  )
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
})
afterEach(() => {
  cleanup()
  client.clear()
})
function component() {
  return (
    <QueryClientProvider client={client}>
      <FortnoxExportSetup />
    </QueryClientProvider>
  )
}
async function show() {
  const view = render(component())
  await screen.findByRole('option', { name: /Verifikat org-A 1/ })
  return view
}
function choose(id = 'je-org-A1') {
  fireEvent.change(screen.getByLabelText('Verifikat (senaste 90 dagarna)'), {
    target: { value: id },
  })
}
async function run() {
  fireEvent.click(screen.getByRole('button', { name: 'Förhandskontrollera' }))
  await screen.findByRole('status')
}

describe('Independent export UI effects', () => {
  it('R1 scope switch requires a fresh dimension decision before a write in the new organization', async () => {
    const view = await show()
    fireEvent.click(screen.getByRole('checkbox'))
    const effects: string[] = []
    mocks.save.mockImplementation(async () => {
      effects.push(mocks.org)
    })
    mocks.org = 'org-B'
    mocks.user = 'owner-B'
    view.rerender(component())
    await screen.findByRole('option', { name: /Verifikat org-B 1/ })
    fireEvent.click(screen.getByRole('button', { name: 'Spara beslut' }))
    await act(async () => {})
    expect(effects).toEqual([])
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
  it('R1 previous-organization result must disappear after scoped query caches change', async () => {
    const view = await show()
    choose()
    await run()
    mocks.org = 'org-B'
    mocks.user = 'owner-B'
    view.rerender(component())
    await screen.findByRole('option', { name: /Verifikat org-B 1/ })
    expect(screen.queryByRole('status')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Förhandskontrollera' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('R2 an old response must not appear as the outcome of a newly selected journal entry', async () => {
    let resolve!: (value: ReturnType<typeof row>) => void
    mocks.dryRun.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    await show()
    choose()
    fireEvent.click(screen.getByRole('button', { name: 'Förhandskontrollera' }))
    await waitFor(() => expect(mocks.dryRun).toHaveBeenCalledWith({ journalEntryId: 'je-org-A1' }))
    if ((screen.getByLabelText('Verifikat (senaste 90 dagarna)') as HTMLSelectElement).disabled) {
      await act(async () => resolve(row('DRY_RUN_READY', 'je-org-A1')))
      expect(
        (screen.getByLabelText('Verifikat (senaste 90 dagarna)') as HTMLSelectElement).value,
      ).toBe('je-org-A1')
      return
    }
    choose('je-org-A2')
    await act(async () => resolve(row('DRY_RUN_READY', 'je-org-A1')))
    expect(
      (screen.getByLabelText('Verifikat (senaste 90 dagarna)') as HTMLSelectElement).value,
    ).toBe('je-org-A2')
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('R3 failed recheck does not retain an unlabelled previous successful result', async () => {
    await show()
    choose()
    await run()
    mocks.dryRun.mockRejectedValueOnce(new Error('server rejected'))
    fireEvent.click(screen.getByRole('button', { name: 'Förhandskontrollera' }))
    await screen.findByText('Serverfel')
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('R4 inert module has no export actions or provider catalog request even with stored ACTIVE connection', async () => {
    mocks.state.mockResolvedValue(active(false))
    render(component())
    await waitFor(() => expect(mocks.state).toHaveBeenCalled())
    await act(async () => {})
    expect(mocks.catalog).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Spara beslut' })).toBeNull()
  })
  it('R5 a failed year/series catalog is visible and offers a way to retry', async () => {
    mocks.catalog.mockRejectedValue(new Error('503'))
    await show()
    await waitFor(() =>
      expect(
        client.getQueryState(['fortnox', 'export-years', 'org-A', 'owner-A', 'OWNER'])?.status,
      ).toBe('error'),
    )
    expect(screen.queryByText(/kunde inte.*(?:hämtas|verifieras)/i)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /igen|hämta om|försök/i })).not.toBeNull()
  })
  it.each(['UNKNOWN', 'CONFIRMED'])(
    'terminal %s remains labelled and provides no send action',
    async (state) => {
      mocks.dryRun.mockResolvedValue(row(state, 'je-org-A1'))
      await show()
      choose()
      await run()
      expect(screen.getByRole('status').textContent).toContain(
        state === 'UNKNOWN' ? 'Okänt utfall' : 'Bekräftad i Fortnox',
      )
      expect(screen.queryByRole('button', { name: /^skicka|^sänd|omsänd/i })).toBeNull()
      expect(mocks.dryRun).toHaveBeenCalledTimes(1)
    },
  )
})
