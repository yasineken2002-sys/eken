/**
 * Riktig LoginPage, Axios, schema, sessionstore och QueryClient. Endast nätets
 * svar och notifieringarnas visning är testgränser. Sena svar pausas EFTER
 * Axios egna kontroller: transportens abort får inte ensam göra proven gröna.
 * JSDOM prövar formulärsemantik/fokus, inte Tab-navigation eller 320 px-geometri.
 */
import { StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import {
  AxiosError,
  isAxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { TenantLoginResolveResult } from '@eken/shared'
import { portalApi } from '@/api/portal.api'
import { SessionBoundary } from '@/components/SessionBoundary'
import { useSessionStore } from '@/store/session.store'
import { LoginPage } from './LoginPage'

const notifications = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notifications }))

const EMAIL = 'gemensam@example.invalid'
const PASSWORD = 'Syntetiskt-Losenord-93!'
const NEXT_EMAIL = 'nytt-forsok@example.invalid'
const NEXT_PASSWORD = 'Ett-Annat-Losenord-57!'
const PRIVATE_ERROR = 'SENTINEL som aldrig får visas från ett gammalt svar'
const RESOLVE = '/tenant-portal/login/resolve'
const TENANT_A = {
  id: '50000000-0000-4000-8000-000000000001',
  email: EMAIL,
  firstName: 'Syntetisk',
  lastName: 'Hyresgäst',
  companyName: null,
}
const TENANT_B = {
  id: '50000000-0000-4000-8000-000000000002',
  email: EMAIL,
  firstName: null,
  lastName: null,
  companyName: 'Syntetisk hyresgäst AB',
}
const CANDIDATES = [
  { organizationId: '40000000-0000-4000-8000-000000000001', organizationName: 'Hyresvärd Alpha' },
  { organizationId: '40000000-0000-4000-8000-000000000002', organizationName: 'Hyresvärd Beta' },
]
const NEXT_CANDIDATES = [
  {
    organizationId: '40000000-0000-4000-8000-000000000003',
    organizationName: 'Ny hyresvärd Gamma',
  },
  {
    organizationId: '40000000-0000-4000-8000-000000000004',
    organizationName: 'Ny hyresvärd Delta',
  },
]
let expiresAt: string
type Complete = Extract<TenantLoginResolveResult, { status: 'complete' }>
const complete = (
  tenant: Complete['tenant'] = TENANT_A,
  sessionToken = 'syntetisk-session-a',
): Complete => ({
  status: 'complete',
  sessionToken,
  expiresAt,
  tenant,
})
const choose = (candidates = CANDIDATES) => ({ status: 'choose', candidates })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

interface PendingRequest {
  config: InternalAxiosRequestConfig
  settled: boolean
  hold: boolean
  arrived: boolean
  gate: ReturnType<typeof deferred<void>>
  respond: (data: unknown) => void
  fail: (status: number) => void
}
const requests: PendingRequest[] = []
const owners = new WeakMap<object, PendingRequest>()
const clients = new Set<QueryClient>()
const originalAdapter = portalApi.defaults.adapter
let responseInterceptor: number

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
    return Promise.resolve(response({ success: true, data: { features: { bankId: false } } }))
  }
  if (config.url !== RESOLVE) throw new Error(`Oväntat nätanrop i loginprovet: ${config.url}`)
  const request: PendingRequest = {
    config,
    settled: false,
    hold: false,
    arrived: false,
    gate: deferred<void>(),
    respond: (data) => {
      request.settled = true
      result.resolve(response({ success: true, data }))
    },
    fail: (status) => {
      request.settled = true
      result.reject(
        new AxiosError(
          PRIVATE_ERROR,
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          response({ success: false, error: { message: PRIVATE_ERROR } }, status),
        ),
      )
    },
  }
  owners.set(config, request)
  requests.push(request)
  return result.promise
}

async function stopAfterAxios(config: object) {
  const request = owners.get(config)
  if (!request?.hold) return
  request.arrived = true
  await request.gate.promise
}

function Observe() {
  const client = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const tenantId = useSessionStore((state) => state.tenant?.id)
  useEffect(() => {
    clients.add(client)
  }, [client])
  return (
    <>
      <output aria-label="aktuell adress">
        {location.pathname + location.search + location.hash}
      </output>
      <output aria-label="inloggat konto">{tenantId ?? 'utloggad'}</output>
      <button type="button" onClick={() => navigate('/annan-sida')}>
        Lämna inloggningen
      </button>
    </>
  )
}

function showPage() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={['/login']}>
        <SessionBoundary>
          <Observe />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<h1>Inloggad startsida</h1>} />
            <Route path="/forgot-password" element={<h1>Återställ lösenord</h1>} />
            <Route path="/annan-sida" element={<h1>Annan sida</h1>} />
          </Routes>
        </SessionBoundary>
      </MemoryRouter>
    </StrictMode>,
  )
}

function fill(email = EMAIL, password = PASSWORD) {
  fireEvent.change(screen.getByLabelText('E-postadress'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Lösenord'), { target: { value: password } })
}

function submit(label = 'Logga in') {
  const button = screen.getByRole('button', { name: label })
  expect(button).toHaveAttribute('type', 'submit')
  const form = button.closest('form')
  if (!form) throw new Error('Loginhandlingen måste vara ett riktigt formulär')
  fireEvent.submit(form)
}

async function requestAt(index = 0) {
  await waitFor(() => expect(requests.length).toBe(index + 1))
  const request = requests[index]
  if (!request) throw new Error('Det förväntade Axios-anropet saknas')
  return request
}

function body(request: PendingRequest): unknown {
  if (typeof request.config.data !== 'string') throw new Error('JSON-kroppen saknas')
  return JSON.parse(request.config.data)
}

function expectAnonymous() {
  expect(useSessionStore.getState().isAuthenticated).toBe(false)
  expect(useSessionStore.getState().sessionToken).toBeNull()
  expect(useSessionStore.getState().tenant).toBeNull()
}

function expectEphemeral() {
  expect(clients.size).toBeGreaterThan(0)
  const cache = [...clients].map((client) => {
    expect(client.getMutationCache().getAll()).toHaveLength(0)
    return client
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, state: query.state }))
  })
  const storage = [localStorage, sessionStorage].map((store) =>
    Array.from({ length: store.length }, (_, index) => {
      const key = store.key(index)
      return key ? [key, store.getItem(key)] : null
    }),
  )
  const persisted = JSON.stringify({
    cache,
    storage,
    address: screen.getByLabelText('aktuell adress').textContent,
    browserAddress: window.location.href,
  })
  for (const secret of [
    PASSWORD,
    NEXT_PASSWORD,
    ...CANDIDATES.flatMap((candidate) => [candidate.organizationId, candidate.organizationName]),
    ...NEXT_CANDIDATES.flatMap((candidate) => [
      candidate.organizationId,
      candidate.organizationName,
    ]),
  ]) {
    expect(persisted).not.toContain(secret)
  }
}

beforeEach(() => {
  requests.length = 0
  clients.clear()
  localStorage.clear()
  sessionStorage.clear()
  useSessionStore.getState().clearSession()
  expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  portalApi.defaults.adapter = adapter
  // Registreras efter produktionsinterceptorerna. Här är generation och abort
  // redan kontrollerade av Axios; sidans egen sista kontroll måste fortfarande gälla.
  responseInterceptor = portalApi.interceptors.response.use(
    async (response) => {
      await stopAfterAxios(response.config)
      return response
    },
    async (error: unknown) => {
      if (isAxiosError(error) && error.config) await stopAfterAxios(error.config)
      throw error
    },
  )
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => {
    cleanup()
    for (const request of requests) {
      request.gate.resolve()
      if (!request.settled) request.respond({})
    }
  })
  portalApi.interceptors.response.eject(responseInterceptor)
  for (const client of clients) client.clear()
  useSessionStore.getState().clearSession()
  if (originalAdapter === undefined) delete portalApi.defaults.adapter
  else portalApi.defaults.adapter = originalAdapter
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('lösenordslogin och hyresvärdsval med riktig klientkedja', () => {
  it('en träff skapar session direkt och skickar normaliserad e-post utan organisationsgissning', async () => {
    showPage()
    fill(`  ${EMAIL.toUpperCase()}  `)
    submit()
    const request = await requestAt()
    expect(body(request)).toEqual({ email: EMAIL, password: PASSWORD })
    expect(request.config.method).toBe('post')
    expect(request.config.headers.Authorization).toBeUndefined()
    expect(request.config.signal).toBeInstanceOf(AbortSignal)
    expectEphemeral()

    await act(async () => request.respond(complete()))

    await screen.findByRole('heading', { name: 'Inloggad startsida' })
    expect(useSessionStore.getState().sessionToken).toBe('syntetisk-session-a')
    expect(useSessionStore.getState().tenant?.id).toBe(TENANT_A.id)
    expect(screen.queryByRole('group', { name: 'Välj hyresvärd' })).not.toBeInTheDocument()
    expectEphemeral()
  })

  it('två träffar kräver aktivt radioval och ny lösenordsverifiering för exakt vald organisation', async () => {
    showPage()
    fill()
    submit()
    const first = await requestAt()
    await act(async () => first.respond(choose()))

    const group = await screen.findByRole('group', { name: 'Välj hyresvärd' })
    expect(group).toHaveFocus()
    const a = screen.getByRole('radio', { name: CANDIDATES[0]!.organizationName })
    const b = screen.getByRole('radio', { name: CANDIDATES[1]!.organizationName })
    expect(a).not.toBeChecked()
    expect(b).not.toBeChecked()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Fortsätt' })).toBeDisabled()
    expectAnonymous()
    expectEphemeral()
    submit('Fortsätt')
    expect(requests).toHaveLength(1)

    b.focus()
    expect(b).toHaveFocus()
    fireEvent.click(b)
    expect(b).toBeChecked()
    expect(a).not.toBeChecked()
    submit('Fortsätt')
    const selected = await requestAt(1)
    expect(body(selected)).toEqual({
      email: EMAIL,
      password: PASSWORD,
      organizationId: CANDIDATES[1]!.organizationId,
    })
    expectAnonymous()
    expectEphemeral()
    await act(async () => selected.respond(complete(TENANT_B, 'vald-hyresvard-session')))
    await screen.findByRole('heading', { name: 'Inloggad startsida' })
    expect(useSessionStore.getState().sessionToken).toBe('vald-hyresvard-session')
    expect(useSessionStore.getState().tenant?.id).toBe(TENANT_B.id)
    expect(requests).toHaveLength(2)
    expectEphemeral()
  })

  it('Tillbaka glömmer val och lösenord, fokuserar lösenordsfältet och låter ett nytt försök börja utan gammalt orgval', async () => {
    showPage()
    fill()
    submit()
    const first = await requestAt()
    await act(async () => first.respond(choose()))
    fireEvent.click(screen.getByRole('radio', { name: CANDIDATES[0]!.organizationName }))
    fireEvent.click(screen.getByRole('button', { name: 'Tillbaka' }))

    expect(screen.getByLabelText('Lösenord')).toHaveValue('')
    expect(screen.getByLabelText('Lösenord')).toHaveFocus()
    expect(screen.getByLabelText('E-postadress')).toHaveValue(EMAIL)
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expectEphemeral()
    fill(NEXT_EMAIL, NEXT_PASSWORD)
    submit()
    expect(body(await requestAt(1))).toEqual({ email: NEXT_EMAIL, password: NEXT_PASSWORD })
  })

  it.each(['401', '429', 'ogiltigt complete', 'ogiltigt choose'] as const)(
    '%s ger tillgängligt, sanerat fel utan session, kvarlämnat lösenord eller automatisk retry',
    async (kind) => {
      showPage()
      fill()
      submit()
      const request = await requestAt()
      await act(async () => {
        if (kind === '401' || kind === '429') request.fail(Number(kind))
        else if (kind === 'ogiltigt complete') {
          request.respond({ ...complete(), tenant: { ...TENANT_A, passwordHash: PRIVATE_ERROR } })
        } else request.respond(choose([CANDIDATES[0]!]))
      })
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(
        kind === '401'
          ? 'Felaktig e-post eller lösenord.'
          : kind === '429'
            ? 'Inloggning är tillfälligt begränsad. Vänta en stund och försök igen.'
            : 'Något gick fel. Försök igen.',
      )
      expect(alert).toHaveFocus()
      expect(document.body).not.toHaveTextContent(PRIVATE_ERROR)
      expect(screen.getByLabelText('Lösenord')).toHaveValue('')
      expect(screen.queryByRole('radio')).not.toBeInTheDocument()
      expectAnonymous()
      expect(requests).toHaveLength(1)
      expect(notifications.error).not.toHaveBeenCalled()
      expectEphemeral()
    },
  )

  it('Glömt lösenord är frivilligt och lämnar inget lösenord eller kontoval i adress eller cache', async () => {
    showPage()
    fill()
    submit()
    const request = await requestAt()
    await act(async () => request.respond(choose()))
    fireEvent.click(screen.getByRole('link', { name: 'Glömt lösenord?' }))
    await screen.findByRole('heading', { name: 'Återställ lösenord' })
    expect(screen.getByLabelText('aktuell adress')).toHaveTextContent(/^\/forgot-password$/)
    expectAnonymous()
    expect(requests).toHaveLength(1)
    expectEphemeral()
  })

  it('lösenordsändring ensam gör ett redan mottaget complete inaktuellt', async () => {
    showPage()
    fill()
    submit()
    const old = await requestAt()
    old.hold = true
    old.respond(complete())
    await waitFor(() => expect(old.arrived).toBe(true))

    expect(screen.getByLabelText('Lösenord')).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText('Lösenord'), { target: { value: NEXT_PASSWORD } })
    expect(old.config.signal?.aborted).toBe(true)
    await act(async () => old.gate.resolve())

    expectAnonymous()
    expect(screen.getByLabelText('E-postadress')).toHaveValue(EMAIL)
    expect(screen.getByLabelText('Lösenord')).toHaveValue(NEXT_PASSWORD)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('aktuell adress')).toHaveTextContent(/^\/login$/)
    expectEphemeral()
  })

  it('ett nytt hyresvärdsval under verifieringen hindrar det gamla valet från att öppna session', async () => {
    showPage()
    fill()
    submit()
    const first = await requestAt()
    await act(async () => first.respond(choose()))
    fireEvent.click(screen.getByRole('radio', { name: CANDIDATES[0]!.organizationName }))
    const form = screen.getByRole('button', { name: 'Fortsätt' }).closest('form')
    if (!form) throw new Error('Kontovalet saknar formulär')
    submit('Fortsätt')
    const oldChoice = await requestAt(1)
    expect(body(oldChoice)).toEqual({
      email: EMAIL,
      password: PASSWORD,
      organizationId: CANDIDATES[0]!.organizationId,
    })
    // Även en ny submit-händelse medan knappen är disabled ska stanna lokalt.
    fireEvent.submit(form)
    expect(requests).toHaveLength(2)
    oldChoice.hold = true
    oldChoice.respond(complete(TENANT_A, 'gammalt-orgval'))
    await waitFor(() => expect(oldChoice.arrived).toBe(true))

    fireEvent.click(screen.getByRole('radio', { name: CANDIDATES[1]!.organizationName }))
    expect(oldChoice.config.signal?.aborted).toBe(true)
    submit('Fortsätt')
    const newChoice = await requestAt(2)
    expect(body(newChoice)).toEqual({
      email: EMAIL,
      password: PASSWORD,
      organizationId: CANDIDATES[1]!.organizationId,
    })
    await act(async () => oldChoice.gate.resolve())
    expectAnonymous()
    expect(screen.getByRole('radio', { name: CANDIDATES[1]!.organizationName })).toBeChecked()
    await act(async () => newChoice.respond(complete(TENANT_B, 'nytt-orgval')))
    await screen.findByRole('heading', { name: 'Inloggad startsida' })
    expect(useSessionStore.getState().sessionToken).toBe('nytt-orgval')
    expect(useSessionStore.getState().tenant?.id).toBe(TENANT_B.id)
    expectEphemeral()
  })

  describe.each(['omstart', 'redigering', 'avmontering', 'sessionsbyte'] as const)(
    'efter %s',
    (change) => {
      it.each(['choose', 'complete', '401'] as const)(
        'ett gammalt %s som redan passerat Axios får inte påverka det nya läget',
        async (oldResult) => {
          showPage()
          fill()
          submit()
          const old = await requestAt()
          old.hold = true
          if (oldResult === '401') old.fail(401)
          else old.respond(oldResult === 'choose' ? choose() : complete())
          await waitFor(() => expect(old.arrived).toBe(true))

          if (change === 'omstart') {
            fireEvent.click(screen.getByRole('button', { name: 'Börja om' }))
            expect(screen.getByLabelText('Lösenord')).toHaveValue('')
            expect(screen.getByLabelText('Lösenord')).toHaveFocus()
          } else if (change === 'redigering') {
            expect(screen.getByLabelText('E-postadress')).not.toBeDisabled()
            fireEvent.change(screen.getByLabelText('E-postadress'), {
              target: { value: NEXT_EMAIL },
            })
          } else if (change === 'avmontering') {
            fireEvent.click(screen.getByRole('button', { name: 'Lämna inloggningen' }))
          } else {
            act(() => useSessionStore.getState().setSession('ny-session-b', TENANT_B, expiresAt))
          }
          expect(old.config.signal?.aborted).toBe(true)

          if (change === 'omstart' || change === 'redigering') {
            fill(NEXT_EMAIL, NEXT_PASSWORD)
            submit()
            const current = await requestAt(1)
            await act(async () => current.respond(choose(NEXT_CANDIDATES)))
            await screen.findByRole('radio', { name: NEXT_CANDIDATES[0]!.organizationName })
          }
          await act(async () => old.gate.resolve())

          expect(screen.queryByRole('alert')).not.toBeInTheDocument()
          expect(document.body).not.toHaveTextContent(PRIVATE_ERROR)
          expect(
            screen.queryByRole('radio', { name: CANDIDATES[0]!.organizationName }),
          ).not.toBeInTheDocument()
          expect(notifications.error).not.toHaveBeenCalled()
          if (change === 'sessionsbyte') {
            expect(useSessionStore.getState().sessionToken).toBe('ny-session-b')
            expect(useSessionStore.getState().tenant?.id).toBe(TENANT_B.id)
          } else {
            expectAnonymous()
          }
          if (change === 'avmontering') {
            expect(screen.getByRole('heading', { name: 'Annan sida' })).toBeInTheDocument()
          } else if (change === 'omstart' || change === 'redigering') {
            expect(screen.getByRole('group', { name: 'Välj hyresvärd' })).toHaveFocus()
            expect(screen.getAllByRole('radio')).toHaveLength(2)
            expect(
              screen.getByRole('radio', { name: NEXT_CANDIDATES[1]!.organizationName }),
            ).toBeInTheDocument()
            expect(requests).toHaveLength(2)
          }
          expectEphemeral()
        },
      )
    },
  )
})
