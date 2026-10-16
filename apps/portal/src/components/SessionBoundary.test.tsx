import { StrictMode, useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { fetchDashboard, portalApi } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { useSessionMutation } from '@/lib/session-guard'
import type { PortalDashboard, PortalSessionTenant, PortalTenant } from '@/types/portal.types'
import { LoginPage } from '@/pages/LoginPage/LoginPage'
import { PortalLayout } from '@/components/PortalLayout/PortalLayout'
import { SessionBoundary } from './SessionBoundary'

const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: notifications }))

const KEY = ['portal', 'dashboard'] as const
const A: PortalTenant = {
  id: '50000000-0000-4000-8000-000000000001',
  type: 'INDIVIDUAL',
  firstName: 'Endast A',
  email: 'a@synthetic.invalid',
}
// Ett annat hyresförhållande, även hos en annan hyresvärd, har egen Tenant.id.
const B: PortalTenant = {
  id: '50000000-0000-4000-8000-000000000002',
  type: 'INDIVIDUAL',
  firstName: 'Endast B',
  email: 'b@synthetic.invalid',
}
const expires = () => new Date(Date.now() + 3_600_000).toISOString()
let sessionExpiry = expires()
let bankIdEnabled = false
const signIn = (tenant: PortalSessionTenant = A, token = 'token-a', expiry = sessionExpiry) =>
  useSessionStore.getState().setSession(token, tenant, expiry)
const dashboard = (tenant: PortalTenant): PortalDashboard => ({
  tenant,
  activeLease: null,
  upcomingInvoice: null,
  overdueInvoices: 0,
  openMaintenanceTickets: 0,
  unreadNotices: 0,
})

// Lösenords-API:ts verkliga tenantSummary, utan profilfält som type/phone.
const passwordResolution = (tenant: PortalSessionTenant, sessionToken: string) => ({
  status: 'complete',
  sessionToken,
  expiresAt: sessionExpiry,
  tenant: {
    id: tenant.id,
    email: tenant.email,
    firstName: tenant.firstName ?? null,
    lastName: tenant.lastName ?? null,
    companyName: tenant.companyName ?? null,
  },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

interface Request {
  config: InternalAxiosRequestConfig
  resolve: (value: unknown) => void
  reject: (status: number, message: string) => void
}
const requests: Request[] = []
const clients: QueryClient[] = []
const originalAdapter = portalApi.defaults.adapter
const adapter: AxiosAdapter = (config) => {
  const result = deferred<AxiosResponse>()
  const response = (data: unknown, status = 200): AxiosResponse => ({
    config,
    status,
    statusText: String(status),
    headers: {},
    data,
  })
  if (config.url === '/public/config') {
    result.resolve(response({ data: { features: { bankId: bankIdEnabled } } }))
    return result.promise
  }
  requests.push({
    config,
    resolve: (data) => result.resolve(response({ data })),
    reject: (status, message) =>
      result.reject(
        new AxiosError(
          message,
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          response({ error: { message, privateTenantData: 'bara A:s underlag' } }, status),
        ),
      ),
  })
  // Adaptern avslutar avsiktligt inte vid abort. Ett gammalt svar kan fortfarande
  // anlända; den riktiga Axios/session-/QueryClient-kedjan måste tåla det.
  return result.promise
}

async function pending(url: string, token: string) {
  let found: Request | undefined
  await waitFor(() => {
    found = requests.find(
      (r) => r.config.url === url && r.config.headers.Authorization === `Bearer ${token}`,
    )
    expect(found).toBeDefined()
  })
  return found!
}

function ObserveClient() {
  const client = useQueryClient()
  useEffect(() => {
    clients.push(client)
  }, [client])
  return null
}

function QueryProbe() {
  const authenticated = useSessionStore((s) => s.isAuthenticated)
  const tenantId = useSessionStore((s) => s.tenant?.id)
  const [draft, setDraft] = useState('')
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: fetchDashboard,
    enabled: authenticated,
    retry: false,
  })
  return (
    <>
      <ObserveClient />
      <output aria-label="inloggat konto">{tenantId ?? 'utloggad'}</output>
      <output aria-label="hämtad hyresgäst">{data?.tenant.firstName ?? 'ingen data'}</output>
      <input aria-label="lokalt utkast" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </>
  )
}

function LocalProbe() {
  const tenantId = useSessionStore((s) => s.tenant?.id)
  const [draft, setDraft] = useState('')
  return (
    <>
      <ObserveClient />
      <output aria-label="inloggat konto">{tenantId ?? 'utloggad'}</output>
      <input aria-label="lokalt utkast" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </>
  )
}

function boundary(children: ReactNode) {
  return render(<SessionBoundary>{children}</SessionBoundary>)
}

async function showA() {
  signIn()
  const view = boundary(<QueryProbe />)
  const request = await pending('/portal/dashboard', 'token-a')
  await act(async () => request.resolve(dashboard(A)))
  await waitFor(() =>
    expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast A'),
  )
  return view
}

beforeEach(() => {
  sessionExpiry = expires()
  bankIdEnabled = false
  requests.length = 0
  clients.length = 0
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  clients.forEach((client) => client.clear())
  useSessionStore.getState().clearSession()
  if (originalAdapter === undefined) delete portalApi.defaults.adapter
  else portalApi.defaults.adapter = originalAdapter
  localStorage.clear()
  vi.useRealTimers()
})

describe('portalens sessiongräns med riktig cache och riktiga Axios-interceptorer', () => {
  it('negativ kontroll: den gamla gemensamma providern visar A:s färska cache för B', async () => {
    signIn()
    const shared = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, retry: false } },
    })
    clients.push(shared)
    shared.setQueryData(KEY, dashboard(A))
    render(
      <QueryClientProvider client={shared}>
        <QueryProbe />
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast A')
    act(() => {
      useSessionStore.getState().clearSession()
      signIn(B, 'token-b')
    })
    expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(B.id)
    expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast A')
    expect(requests).toHaveLength(0)
  })

  it.each([
    'logout till B',
    'ny hyresgäst hos annan hyresvärd',
    'logout till samma konto och token',
  ] as const)(
    'tömmer cache och lokal UI vid %s, även när querynycklarna är identiska',
    async (kind) => {
      await showA()
      const oldClient = clients.at(-1)!
      oldClient.setQueryData(['portal', 'documents'], ['A:s dokument'])
      fireEvent.change(screen.getByLabelText('lokalt utkast'), {
        target: { value: 'A:s privata utkast' },
      })
      const sameAccount = kind === 'logout till samma konto och token'
      const next = sameAccount ? A : B
      const token = sameAccount ? 'token-a' : 'token-b'
      const requestCount = requests.length
      act(() => {
        if (kind.startsWith('logout')) useSessionStore.getState().clearSession()
        signIn(next, token)
      })
      expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('ingen data')
      expect(screen.getByLabelText('lokalt utkast')).toHaveValue('')
      await waitFor(() => expect(requests.length).toBeGreaterThan(requestCount))
      expect(clients.at(-1)).not.toBe(oldClient)
      expect(oldClient.getQueryCache().getAll()).toHaveLength(0)
      expect(clients.at(-1)!.getQueryData(['portal', 'documents'])).toBeUndefined()
      await act(async () => requests.at(-1)!.resolve(dashboard(next)))
      await waitFor(() =>
        expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent(next.firstName!),
      )
    },
  )

  it('behåller klient och lokalt utkast när token, hyresgäst och utgångstid är oförändrade', async () => {
    await showA()
    const client = clients.at(-1)!
    const generation = useSessionStore.getState().sessionGeneration
    fireEvent.change(screen.getByLabelText('lokalt utkast'), {
      target: { value: 'Pågående utkast' },
    })
    act(() => signIn({ ...A }, 'token-a', sessionExpiry))
    expect(useSessionStore.getState().sessionGeneration).toBe(generation)
    expect(clients.at(-1)).toBe(client)
    expect(screen.getByLabelText('lokalt utkast')).toHaveValue('Pågående utkast')
    expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast A')
    expect(requests).toHaveLength(1)
  })

  it('StrictMode behåller en aktiv cache som refetchar efter invalidateQueries', async () => {
    signIn()
    render(
      <StrictMode>
        <SessionBoundary>
          <QueryProbe />
        </SessionBoundary>
      </StrictMode>,
    )
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    await act(async () => {
      for (const request of requests) request.resolve(dashboard(A))
    })
    await waitFor(() =>
      expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast A'),
    )
    const client = clients.at(-1)!
    expect(client.getQueryData(KEY)).toEqual(dashboard(A))
    const before = requests.length
    act(() => {
      void client.invalidateQueries({ queryKey: KEY })
    })
    await waitFor(() => expect(requests.length).toBeGreaterThan(before))
    const fresh = dashboard({ ...A, firstName: 'Uppdaterad A' })
    await act(async () => requests.at(-1)!.resolve(fresh))
    await waitFor(() =>
      expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Uppdaterad A'),
    )
    expect(client.getQueryData(KEY)).toEqual(fresh)
  })

  it('ett sent lyckat A-svar kan inte återfylla någon cache efter att B fått sitt svar', async () => {
    signIn()
    boundary(<QueryProbe />)
    const a = await pending('/portal/dashboard', 'token-a')
    const oldClient = clients.at(-1)!
    act(() => {
      useSessionStore.getState().clearSession()
      signIn(B, 'token-b')
    })
    const b = await pending('/portal/dashboard', 'token-b')
    await act(async () => b.resolve(dashboard(B)))
    await waitFor(() =>
      expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast B'),
    )
    await act(async () => a.resolve(dashboard(A)))
    expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('Endast B')
    expect(clients.at(-1)!.getQueryData(KEY)).toEqual(dashboard(B))
    expect(oldClient.getQueryCache().getAll()).toHaveLength(0)
    expect(notifications.error).not.toHaveBeenCalled()
  })

  it('ett gammalt 401 loggar inte ut B och kastar inga gamla feldata vidare', async () => {
    signIn()
    boundary(<LocalProbe />)
    const result = portalApi.get('/portal/private').catch((error: unknown) => error)
    const a = await pending('/portal/private', 'token-a')
    act(() => signIn(B, 'token-b'))
    await act(async () => a.reject(401, 'A:s privata feltext'))
    const error = await result
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
    expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(B.id)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('response')
    expect(error).not.toHaveProperty('config')
    expect(JSON.stringify(error)).not.toContain('privata')
    expect(notifications.error).not.toHaveBeenCalled()
  })

  it('ett 401 för den aktuella skyddade sessionen rensar även cache och lokal UI', async () => {
    await showA()
    const client = clients.at(-1)!
    fireEvent.change(screen.getByLabelText('lokalt utkast'), { target: { value: 'A:s utkast' } })
    const result = portalApi.get('/portal/private').catch((error: unknown) => error)
    const request = await pending('/portal/private', 'token-a')
    await act(async () => request.reject(401, 'Session expired'))
    await result
    expect(useSessionStore.getState().isAuthenticated).toBe(false)
    expect(screen.getByLabelText('hämtad hyresgäst')).toHaveTextContent('ingen data')
    expect(screen.getByLabelText('lokalt utkast')).toHaveValue('')
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('ett anrop som startas i A får aldrig B:s Authorization genom en senare interceptor', async () => {
    signIn()
    const result = portalApi
      .post('/portal/maintenance', { title: 'A:s ärende' })
      .catch((error: unknown) => error)
    signIn(B, 'token-b')
    await act(async () => {
      await Promise.resolve()
    })
    expect(requests).toHaveLength(1)
    for (const request of requests) {
      expect(request.config.headers.Authorization).toBe('Bearer token-a')
      request.resolve({ id: 'old-ticket' })
    }
    await result
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
  })

  it('sessionens timer loggar ut utan navigation och tar bort cache och UI', async () => {
    vi.useFakeTimers()
    signIn(A, 'token-a', new Date(Date.now() + 1000).toISOString())
    boundary(<LocalProbe />)
    const oldClient = clients.at(-1)!
    oldClient.setQueryData(KEY, dashboard(A))
    fireEvent.change(screen.getByLabelText('lokalt utkast'), { target: { value: 'Privat A' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001)
    })
    expect(useSessionStore.getState().isAuthenticated).toBe(false)
    expect(screen.getByLabelText('inloggat konto')).toHaveTextContent('utloggad')
    expect(screen.getByLabelText('lokalt utkast')).toHaveValue('')
    expect(oldClient.getQueryCache().getAll()).toHaveLength(0)
  })
})

function MutationProbe({
  operation,
  callbacks,
}: {
  operation: () => Promise<string>
  callbacks: {
    success: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
    settled: ReturnType<typeof vi.fn>
    callSuccess: ReturnType<typeof vi.fn>
    callError: ReturnType<typeof vi.fn>
    callSettled: ReturnType<typeof vi.fn>
  }
}) {
  const client = useQueryClient()
  const mutation = useSessionMutation({
    mutationFn: operation,
    onSuccess: (value) => {
      callbacks.success(value)
      client.setQueryData(['portal', 'mutation'], value)
    },
    onError: callbacks.error,
    onSettled: callbacks.settled,
  })
  return (
    <>
      <LocalProbe />
      <button
        onClick={() =>
          mutation.mutate(undefined, {
            onSuccess: callbacks.callSuccess,
            onError: callbacks.callError,
            onSettled: callbacks.callSettled,
          })
        }
      >
        Ändra
      </button>
    </>
  )
}

describe('sena mutationer och andra flikar', () => {
  it.each(['success', 'error'] as const)(
    'ignorerar gamla %s-callbacks även utan Axios',
    async (outcome) => {
      signIn()
      const old = deferred<string>()
      const operation = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('B:s resultat')
      const callbacks = {
        success: vi.fn(),
        error: vi.fn(),
        settled: vi.fn(),
        callSuccess: vi.fn(),
        callError: vi.fn(),
        callSettled: vi.fn(),
      }
      boundary(<MutationProbe operation={operation} callbacks={callbacks} />)
      fireEvent.click(screen.getByRole('button', { name: 'Ändra' }))
      await waitFor(() => expect(operation).toHaveBeenCalledTimes(1))
      act(() => signIn(B, 'token-b'))
      await act(async () => {
        if (outcome === 'success') old.resolve('A:s privata resultat')
        else old.reject(new Error('A:s privata feltext'))
      })
      for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled()
      expect(notifications.error).not.toHaveBeenCalled()
      expect(clients.at(-1)!.getQueryData(['portal', 'mutation'])).toBeUndefined()
      fireEvent.click(screen.getByRole('button', { name: 'Ändra' }))
      await waitFor(() => expect(callbacks.success).toHaveBeenCalledWith('B:s resultat'))
      expect(callbacks.callSuccess).toHaveBeenCalledTimes(1)
      expect(clients.at(-1)!.getQueryData(['portal', 'mutation'])).toBe('B:s resultat')
    },
  )

  it('behåller den globala feltoasten för ett verkligt fel i aktuell session', async () => {
    signIn()
    const operation = vi.fn().mockRejectedValue(new Error('Aktuellt fel'))
    const callbacks = {
      success: vi.fn(),
      error: vi.fn(),
      settled: vi.fn(),
      callSuccess: vi.fn(),
      callError: vi.fn(),
      callSettled: vi.fn(),
    }
    boundary(<MutationProbe operation={operation} callbacks={callbacks} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ändra' }))
    await waitFor(() => expect(notifications.error).toHaveBeenCalledWith('Aktuellt fel'))
    expect(callbacks.error).toHaveBeenCalledTimes(1)
  })

  it.each(['removeItem', 'clear'] as const)(
    'utloggning i annan flik via %s rensar den här flikens UI och cache',
    (kind) => {
      signIn()
      boundary(<LocalProbe />)
      const client = clients.at(-1)!
      client.setQueryData(KEY, dashboard(A))
      fireEvent.change(screen.getByLabelText('lokalt utkast'), { target: { value: 'A:s utkast' } })
      act(() => {
        if (kind === 'clear') localStorage.clear()
        else localStorage.removeItem('tenant_session')
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: kind === 'clear' ? null : 'tenant_session',
            newValue: null,
            storageArea: localStorage,
          }),
        )
      })
      expect(useSessionStore.getState().isAuthenticated).toBe(false)
      expect(screen.getByLabelText('lokalt utkast')).toHaveValue('')
      expect(client.getQueryCache().getAll()).toHaveLength(0)
    },
  )

  it('läser senaste lagrade konto vid fördröjt storage-event och återupplivar inte A', () => {
    signIn()
    const oldStorage = localStorage.getItem('tenant_session')!
    boundary(<LocalProbe />)
    const client = clients.at(-1)!
    client.setQueryData(KEY, dashboard(A))
    fireEvent.change(screen.getByLabelText('lokalt utkast'), { target: { value: 'A:s utkast' } })
    const newest = JSON.stringify({
      state: { sessionToken: 'token-b', tenant: B, expiresAt: expires(), isAuthenticated: true },
      version: 0,
    })
    act(() => {
      localStorage.setItem('tenant_session', newest)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'tenant_session',
          oldValue: null,
          newValue: oldStorage,
          storageArea: localStorage,
        }),
      )
    })
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
    expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(B.id)
    expect(screen.getByLabelText('lokalt utkast')).toHaveValue('')
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })
})

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output aria-label="aktuell sida">{location.pathname}</output>
      <button onClick={() => navigate('/dashboard')}>B:s startsida</button>
    </>
  )
}

describe('riktiga in- och utloggningsvyer', () => {
  it('röjer lokalt direkt vid logout och låter inte sen återkallelse rensa B', async () => {
    signIn()
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <SessionBoundary>
          <Routes>
            <Route path="/dashboard" element={<PortalLayout />} />
            <Route path="/login" element={<p>Inloggningssida</p>} />
          </Routes>
          <LocationProbe />
        </SessionBoundary>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Logga ut' }))
    await waitFor(() => expect(useSessionStore.getState().isAuthenticated).toBe(false))
    expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/login')
    const revoke = requests.find((r) => r.config.url === '/tenant-portal/logout')!
    expect(revoke).toBeDefined()
    act(() => signIn(B, 'token-b'))
    fireEvent.click(screen.getByRole('button', { name: 'B:s startsida' }))
    await act(async () => revoke.resolve(null))
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
    expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/dashboard')
  })

  it('ett gammalt lösenordslogin får inte ersätta en redan inloggad B-session', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <SessionBoundary>
          <LoginPage />
        </SessionBoundary>
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('E-postadress'), { target: { value: A.email } })
    fireEvent.change(screen.getByLabelText('Lösenord'), {
      target: { value: 'syntetiskt-losenord' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Logga in' }))
    await waitFor(() =>
      expect(requests.some((r) => r.config.url === '/tenant-portal/login/resolve')).toBe(true),
    )
    const old = requests.find((r) => r.config.url === '/tenant-portal/login/resolve')!
    act(() => signIn(B, 'token-b'))
    await act(async () => old.resolve(passwordResolution(A, 'token-a')))
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
    expect(useSessionStore.getState().tenant?.id).toBe(B.id)
    expect(notifications.error).not.toHaveBeenCalled()
  })

  it.each([
    { ...A, firstName: 'Anna', lastName: 'Test', companyName: null, phone: null },
    {
      ...B,
      type: 'COMPANY' as const,
      firstName: null,
      lastName: null,
      companyName: 'Testbolaget AB',
      phone: null,
    },
  ])('loggar in $type med serverns legitima nullable person-/företagsfält', async (tenant) => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <SessionBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<LocalProbe />} />
          </Routes>
          <LocationProbe />
        </SessionBoundary>
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('E-postadress'), { target: { value: tenant.email } })
    fireEvent.change(screen.getByLabelText('Lösenord'), {
      target: { value: 'syntetiskt-losenord' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Logga in' }))
    await waitFor(() =>
      expect(
        requests.some((request) => request.config.url === '/tenant-portal/login/resolve'),
      ).toBe(true),
    )
    const login = requests.find((request) => request.config.url === '/tenant-portal/login/resolve')!
    await act(async () => login.resolve(passwordResolution(tenant, 'new-session')))
    await waitFor(() =>
      expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/dashboard'),
    )
    expect(useSessionStore.getState().isAuthenticated).toBe(true)
    expect(useSessionStore.getState().tenant?.id).toBe(tenant.id)
    expect(useSessionStore.getState().tenant?.type).toBeUndefined()
    expect(useSessionStore.getState().tenant?.firstName).toBe(tenant.firstName ?? undefined)
    expect(useSessionStore.getState().tenant?.lastName).toBe(tenant.lastName ?? undefined)
    expect(useSessionStore.getState().tenant?.companyName).toBe(tenant.companyName ?? undefined)
    expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(tenant.id)
    expect(notifications.error).not.toHaveBeenCalled()
  })

  it.each(['BankID', 'lösenord'] as const)(
    'behåller %s som vinnare när den andra verkliga inloggningsvägen svarar senare',
    async (winner) => {
      bankIdEnabled = true
      render(
        <MemoryRouter initialEntries={['/login']}>
          <SessionBoundary>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/dashboard" element={<LocalProbe />} />
            </Routes>
            <LocationProbe />
          </SessionBoundary>
        </MemoryRouter>,
      )
      fireEvent.change(screen.getByLabelText('E-postadress'), { target: { value: A.email } })
      fireEvent.change(screen.getByLabelText('Lösenord'), {
        target: { value: 'syntetiskt-losenord' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Logga in' }))
      await waitFor(() =>
        expect(
          requests.some((request) => request.config.url === '/tenant-portal/login/resolve'),
        ).toBe(true),
      )
      const password = requests.find(
        (request) => request.config.url === '/tenant-portal/login/resolve',
      )!
      fireEvent.click(await screen.findByRole('button', { name: 'Logga in med BankID' }))
      await waitFor(() =>
        expect(
          requests.some((request) => request.config.url === '/tenant-portal/auth/bankid/start'),
        ).toBe(true),
      )
      const start = requests.find(
        (request) => request.config.url === '/tenant-portal/auth/bankid/start',
      )!
      // Endast BankID:s pollintervall styrs. Båda inloggningsanropen går genom
      // verkliga komponenter, API-funktioner och Axios-/sessionsgrindar.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        await act(async () => start.resolve({ orderRef: 'synthetic-competing-order' }))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        const collect = requests.find(
          (request) => request.config.url === '/tenant-portal/auth/bankid/collect',
        )!
        expect(collect).toBeDefined()
        expect(useSessionStore.getState().isAuthenticated).toBe(false)
        const bankIdResult = passwordResolution(B, 'bankid-winner-session')
        const passwordResult = passwordResolution(A, 'password-winner-session')

        await act(async () => {
          if (winner === 'BankID') collect.resolve(bankIdResult)
          else password.resolve(passwordResult)
        })
        const expected = winner === 'BankID' ? bankIdResult : passwordResult
        expect(useSessionStore.getState().sessionToken).toBe(expected.sessionToken)
        expect(useSessionStore.getState().tenant?.id).toBe(expected.tenant.id)
        expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(expected.tenant.id)
        expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/dashboard')
        const generation = useSessionStore.getState().sessionGeneration
        const storedSession = localStorage.getItem('tenant_session')

        // Adaptern levererar även efter eventuell abort; förlorarens riktiga
        // complete-svar får inte ersätta vinnaren eller återstarta pollningen.
        await act(async () => {
          if (winner === 'BankID') password.resolve(passwordResult)
          else collect.resolve(bankIdResult)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        expect(useSessionStore.getState().sessionGeneration).toBe(generation)
        expect(useSessionStore.getState().sessionToken).toBe(expected.sessionToken)
        expect(useSessionStore.getState().tenant?.id).toBe(expected.tenant.id)
        expect(localStorage.getItem('tenant_session')).toBe(storedSession)
        expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(expected.tenant.id)
        expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/dashboard')
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(notifications.error).not.toHaveBeenCalled()
        expect(
          requests.filter((request) => request.config.url === '/tenant-portal/auth/bankid/collect'),
        ).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('tar emot BankID:s verkliga sessionssammanfattning utan type och med nullfält', async () => {
    bankIdEnabled = true
    render(
      <MemoryRouter initialEntries={['/login']}>
        <SessionBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<LocalProbe />} />
          </Routes>
          <LocationProbe />
        </SessionBoundary>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Logga in med BankID' }))
    const start = requests.find(
      (request) => request.config.url === '/tenant-portal/auth/bankid/start',
    )!
    expect(start).toBeDefined()
    // Timern är riktig fram till startsvaret. Därefter styr testet endast pollklockan.
    vi.useFakeTimers()
    await act(async () => start.resolve({ orderRef: 'synthetic-order' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    const collect = requests.find(
      (request) => request.config.url === '/tenant-portal/auth/bankid/collect',
    )!
    expect(collect).toBeDefined()
    await act(async () =>
      collect.resolve({
        status: 'complete',
        sessionToken: 'bankid-session',
        expiresAt: sessionExpiry,
        tenant: {
          id: A.id,
          firstName: 'Anna',
          lastName: 'Test',
          companyName: null,
          email: A.email,
        },
      }),
    )
    expect(useSessionStore.getState().isAuthenticated).toBe(true)
    expect(useSessionStore.getState().sessionToken).toBe('bankid-session')
    expect(useSessionStore.getState().tenant?.type).toBeUndefined()
    expect(screen.getByLabelText('inloggat konto')).toHaveTextContent(A.id)
    expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/dashboard')
  })
})
