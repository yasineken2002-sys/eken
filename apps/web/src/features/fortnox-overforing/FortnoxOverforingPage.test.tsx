import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as string,
  ledgerOwner: vi.fn(),
  state: vi.fn(),
  list: vi.fn(),
  send: vi.fn(),
  verify: vi.fn(),
  reconcile: vi.fn(),
  scan: vi.fn(),
  release: vi.fn(),
}))

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: mocks.role }, organization: { id: 'o1' } }),
}))
vi.mock('@/features/accounting/api/accounting.api', () => ({
  fetchLedgerOwner: mocks.ledgerOwner,
}))
vi.mock('@/features/settings/api/fortnox-export.api', () => ({
  getFortnoxExportState: mocks.state,
  listFortnoxExportsPage: async (query: { group: string; offset: number; limit: number }) => {
    const response = (await mocks.list(query)) as Array<{ state: string }>
    const review = new Set(['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH', 'RECEIPT_IDENTIFIED'])
    const items = response.filter((row) =>
      query.group === 'NEEDS_REVIEW' ? review.has(row.state) : !review.has(row.state),
    )
    return { items, total: items.length, offset: query.offset, limit: query.limit }
  },
  sendFortnoxExport: mocks.send,
  verifyFortnoxExport: mocks.verify,
  reconcileFortnoxExport: mocks.reconcile,
  reconcileScanFortnoxExport: mocks.scan,
  releaseRejectedFortnoxExport: mocks.release,
}))
// Panelen (anslutning/återläsning) återanvänds oförändrad och provas i sina egna tester;
// här räcker att den monteras för rätt roller.
vi.mock('@/features/settings/components/FortnoxPanel', () => ({
  FortnoxPanel: () => <div data-testid="fortnox-panel" />,
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('@/lib/api', () => ({ extractApiError: () => 'Serverfel' }))

import { FortnoxOverforingPage } from './FortnoxOverforingPage'

const STATES = [
  'CONFIRMED',
  'UNKNOWN',
  'DRY_RUN_READY',
  'REJECTED',
  'BLOCKED',
  'RECEIPT_MISMATCH',
  'SENDING',
  'RECEIPT_IDENTIFIED',
  'CONFIRMED',
  'UNKNOWN',
  'DRY_RUN_READY',
  'CONFIRMED',
] as const
const rows = STATES.map((state, i) => ({
  id: `x${i}`,
  journalEntryId: `je${i}`,
  state,
  blockReason: null,
  updatedAt: '2026-10-14T12:00:00.000Z',
}))
const exportState = (status: string | null) => ({
  enabled: true,
  connection:
    status === null ? null : { status, exportVoucherSeries: 'A', exportOmitDimensions: false },
  exports: { sendingEnabled: false, sendingDisabledReason: 'IDEMPOTENCY_UNRESOLVED' },
})

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FortnoxOverforingPage />
    </QueryClientProvider>,
  )
}

const MUTATIONER = () => [mocks.send, mocks.verify, mocks.reconcile, mocks.scan, mocks.release]

describe('Fortnox › Överföring och avstämning', () => {
  beforeEach(() => {
    mocks.role = 'OWNER'
    mocks.ledgerOwner.mockResolvedValue({ agare: 'FORTNOX', valdAt: '2026-10-14', skal: 'x' })
    mocks.state.mockResolvedValue(exportState('ACTIVE'))
    mocks.list.mockResolvedValue(rows)
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('M6/M8: avstämningsrader först, alla 12 rader visas, inget skickas vid rendering', async () => {
    renderIt()
    const forst = await screen.findByTestId('att-stamma-av')
    const ovriga = screen.getByTestId('ovriga-overforingar')
    // Sektionerna syns även under laddning; kontrollera resultatet först när båda sidorna lästs.
    await within(forst).findByRole('heading', { name: 'Att stämma av (5)' })
    await within(ovriga).findByRole('heading', { name: 'Övriga överföringar (7)' })
    const tillstand = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('[data-export-state]')).map((li) =>
        li.getAttribute('data-export-state'),
      )
    expect(tillstand(forst)).toEqual([
      'UNKNOWN',
      'REJECTED',
      'RECEIPT_MISMATCH',
      'RECEIPT_IDENTIFIED',
      'UNKNOWN',
    ])
    expect(tillstand(ovriga)).toEqual([
      'CONFIRMED',
      'DRY_RUN_READY',
      'BLOCKED',
      'SENDING',
      'CONFIRMED',
      'DRY_RUN_READY',
      'CONFIRMED',
    ])
    expect(within(forst).getByText('Att stämma av (5)')).toBeTruthy()
    for (const m of MUTATIONER()) expect(m).not.toHaveBeenCalled()
    expect(screen.queryByTestId('anslutning-bruten')).toBeNull()
    expect(screen.getByTestId('fortnox-panel')).toBeTruthy()
  })

  it.each(['AUTH_LOST', 'DISCONNECTED', null])(
    'M7: anslutning %s ger banderoll, raderna står kvar och inget skickas',
    async (status) => {
      mocks.state.mockResolvedValue(exportState(status))
      renderIt()
      const banner = await screen.findByTestId('anslutning-bruten')
      expect(banner.textContent).toContain('Huvudboksvalet gäller fortfarande')
      expect(banner.textContent).toContain('Inget skickas eller skickas om automatiskt')
      await screen.findByRole('heading', { name: 'Att stämma av (5)' })
      for (const m of MUTATIONER()) expect(m).not.toHaveBeenCalled()
    },
  )

  it.each(['ADMIN'])('M6: %s ser överföringarna', async (role) => {
    mocks.role = role
    renderIt()
    await screen.findByRole('heading', { name: 'Att stämma av (5)' })
  })

  it.each(['MANAGER', 'ACCOUNTANT'])(
    'M5: %s får ingen exportlista eller knapp, och exportdata hämtas inte',
    async (role) => {
      mocks.role = role
      renderIt()
      await screen.findByTestId('overforing-roll')
      expect(mocks.state).not.toHaveBeenCalled()
      expect(mocks.list).not.toHaveBeenCalled()
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByTestId('fortnox-panel')).toBeNull()
    },
  )

  it('M5b: VIEWER frågar inte efter huvudboken, ser okänt läge och inga exportdata', async () => {
    mocks.role = 'VIEWER'
    renderIt()
    expect(screen.getByTestId('huvudbok-okand')).toBeTruthy()
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(mocks.ledgerOwner).not.toHaveBeenCalled()
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('EVENO: sidan påstår ingen Fortnox-vy och hämtar inga exportdata', async () => {
    mocks.ledgerOwner.mockResolvedValue({ agare: 'EVENO', valdAt: null, skal: null })
    renderIt()
    await screen.findByTestId('huvudbok-eveno')
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByTestId('fortnox-panel')).toBeNull()
  })

  it.each([
    ['serverfel', () => mocks.ledgerOwner.mockRejectedValue(new Error('boom'))],
    ['ogiltigt värde', () => mocks.ledgerOwner.mockResolvedValue({ agare: 'X' })],
    ['laddar', () => mocks.ledgerOwner.mockReturnValue(new Promise(() => {}))],
  ])('M9: %s ger okänt läge, inga exportdata och arkivlänkarna kvar', async (_n, setup) => {
    setup()
    renderIt()
    await waitFor(() => expect(screen.getByTestId('huvudbok-okand')).toBeTruthy())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(screen.getByTestId('huvudbok-okand')).toBeTruthy()
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Bokföringsarkiv' }).getAttribute('href')).toBe(
      '/accounting',
    )
    expect(screen.getByRole('link', { name: 'Rapporter' }).getAttribute('href')).toBe('/reports')
  })
})
