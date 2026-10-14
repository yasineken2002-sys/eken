import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as string,
  ledgerOwner: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/stores/auth.store', () => {
  const state = () => ({
    user: { id: 'u1', role: mocks.role, firstName: 'Test', lastName: 'Person' },
    organization: { id: 'o1' },
    clearAuth: vi.fn(),
  })
  return {
    useAuthStore: Object.assign((selector: (s: unknown) => unknown) => selector(state()), {
      getState: state,
    }),
  }
})
vi.mock('@/features/accounting/api/accounting.api', () => ({
  fetchLedgerOwner: mocks.ledgerOwner,
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...(rest as object)}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('@/features/auth/api/auth.api', () => ({ logoutApi: vi.fn() }))
vi.mock('@/features/notifications/components/NotificationBell', () => ({
  NotificationBell: () => null,
}))
vi.mock('@/components/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }))
vi.mock('@/components/ViewerBanner', () => ({ ViewerBanner: () => null }))

import { AppLayout } from './AppLayout'

// Dagens Ekonomi-grupp (bas 466a7024) — M1/M9 kräver EXAKT denna lista, text och adress i ordning.
const IDAG = [
  ['Fakturor', '/invoices'],
  ['Hyresavier', '/avisering'],
  ['Efterdebitering', '/backfill'],
  ['Förbrukning', '/consumption'],
  ['Depositioner', '/deposits'],
  ['Hyreshöjningar', '/rent-increases'],
  ['Bokföring', '/accounting'],
  ['Rapporter', '/reports'],
  ['Bankavstämning', '/reconciliation'],
  ['Inkasso', '/collections'],
]
const FORTNOX = [
  ['Fakturor', '/invoices'],
  ['Hyresavier', '/avisering'],
  ['Efterdebitering', '/backfill'],
  ['Förbrukning', '/consumption'],
  ['Depositioner', '/deposits'],
  ['Hyreshöjningar', '/rent-increases'],
  ['Överföring och avstämning', '/fortnox/overforing'],
  ['Bokföringsarkiv', '/accounting'],
  ['Rapporter', '/reports'],
  ['Bankavstämning', '/reconciliation'],
  ['Inkasso', '/collections'],
]

function forbidden() {
  return Object.assign(new Error('Forbidden'), { isAxiosError: true, response: { status: 403 } })
}

// Samma regel som main.tsx: 403 toastas om frågan inte själv hanterar felet.
function renderIt() {
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        const status = (error as { response?: { status?: number } }).response?.status
        if (status !== 403) return
        if (query.meta?.['handlesOwnError']) return
        mocks.toastError(error)
      },
    }),
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AppLayout>
        <div />
      </AppLayout>
    </QueryClientProvider>,
  )
}

function ekonomi(): string[][] {
  return within(screen.getByTestId('nav-grupp-ekonomi'))
    .getAllByRole('link')
    .map((a) => [a.textContent?.trim() ?? '', a.getAttribute('href') ?? ''])
}

describe('meny-etapp 4: Ekonomi-gruppen styrs bara av verifierat huvudboksval', () => {
  beforeEach(() => {
    mocks.role = 'OWNER'
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('M1: EVENO ger exakt dagens poster och ordning', async () => {
    mocks.ledgerOwner.mockResolvedValue({ agare: 'EVENO', valdAt: null, skal: null })
    renderIt()
    await waitFor(() => expect(mocks.ledgerOwner).toHaveBeenCalled())
    await waitFor(() => expect(ekonomi()).toEqual(IDAG))
    expect(screen.queryByText('Överföring och avstämning')).toBeNull()
  })

  it('M2/M7: verifierad FORTNOX ersätter Bokföring med överföringsvyn och behåller arkivet', async () => {
    mocks.ledgerOwner.mockResolvedValue({ agare: 'FORTNOX', valdAt: '2026-10-14', skal: 'x' })
    renderIt()
    await waitFor(() => expect(ekonomi()).toEqual(FORTNOX))
  })

  it('M9: under laddning visas dagens meny', () => {
    mocks.ledgerOwner.mockReturnValue(new Promise(() => {}))
    renderIt()
    expect(ekonomi()).toEqual(IDAG)
  })

  it.each([
    ['ogiltigt värde', { agare: 'VISMA' }],
    ['saknat värde', {}],
  ])('M9: %s ger dagens meny', async (_namn, svar) => {
    mocks.ledgerOwner.mockResolvedValue(svar)
    renderIt()
    await waitFor(() => expect(mocks.ledgerOwner).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(ekonomi()).toEqual(IDAG)
  })

  it('M9: serverfel ger dagens meny', async () => {
    mocks.ledgerOwner.mockRejectedValue(
      Object.assign(new Error('boom'), { response: { status: 500 } }),
    )
    renderIt()
    await waitFor(() => expect(mocks.ledgerOwner).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(ekonomi()).toEqual(IDAG)
  })

  it('M5b/P202-1: 403 ger dagens meny och ingen 403-toast', async () => {
    mocks.role = 'MANAGER'
    mocks.ledgerOwner.mockRejectedValue(forbidden())
    renderIt()
    await waitFor(() => expect(mocks.ledgerOwner).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(ekonomi()).toEqual(IDAG)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('M5b/P202-1: VIEWER frågar inte servern alls och ser dagens meny', async () => {
    mocks.role = 'VIEWER'
    mocks.ledgerOwner.mockResolvedValue({ agare: 'FORTNOX', valdAt: '2026-10-14', skal: 'x' })
    renderIt()
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.ledgerOwner).not.toHaveBeenCalled()
    expect(ekonomi()).toEqual(IDAG)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('mobilknappen har ett tillgängligt namn', () => {
    mocks.ledgerOwner.mockResolvedValue({ agare: 'EVENO' })
    renderIt()
    expect(screen.getByRole('button', { name: 'Öppna meny' })).toBeTruthy()
  })
})
