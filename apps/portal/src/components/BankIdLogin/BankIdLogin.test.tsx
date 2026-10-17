import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { portalApi } from '@/api/portal.api'
import { SessionBoundary } from '@/components/SessionBoundary'
import { LoginPage } from '@/pages/LoginPage/LoginPage'
import { useSessionStore } from '@/store/session.store'
import type { PortalBankIdCollect } from '@/types/portal.types'

const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: notifications }))

const PREFIX = '/tenant-portal/auth/bankid/'
const PRIVATE_ERROR = 'Endast det avbrutna försökets fel'
const tenants = {
  A: {
    id: '70000000-0000-4000-8000-000000000001',
    email: 'a@synthetic.invalid',
    firstName: 'Anna',
    lastName: null,
    companyName: null,
  },
  B: {
    id: '70000000-0000-4000-8000-000000000002',
    email: 'b@synthetic.invalid',
    firstName: 'Britta',
    lastName: null,
    companyName: null,
  },
} as const
const choices = (tag: 'A' | 'B'): Extract<PortalBankIdCollect, { status: 'choose' }> => ({
  status: 'choose',
  chooseToken: `synthetic-choice-${tag}`,
  candidates: [
    {
      tenantId: tenants[tag].id,
      organizationName: `Hyresvärd ${tag}`,
      address: `Syntetisk gata ${tag}`,
    },
    {
      tenantId: `70000000-0000-4000-8000-00000000000${tag === 'A' ? '3' : '4'}`,
      organizationName: `Alternativ ${tag}`,
      address: null,
    },
  ],
})
const complete = (tag: 'A' | 'B'): Extract<PortalBankIdCollect, { status: 'complete' }> => ({
  status: 'complete',
  sessionToken: `bankid-session-${tag}`,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  tenant: tenants[tag],
})

interface Request {
  config: InternalAxiosRequestConfig
  settled: Promise<void>
  done: boolean
  resolve(data: unknown): void
  reject(): void
}
const requests: Request[] = []
const originalAdapter = portalApi.defaults.adapter
const adapter: AxiosAdapter = (config) => {
  const response = (data: unknown, status = 200): AxiosResponse => ({
    config,
    status,
    statusText: String(status),
    headers: {},
    data,
  })
  if (config.url === '/public/config')
    return Promise.resolve(response({ data: { features: { bankId: true } } }))
  if (!config.url?.startsWith(PREFIX)) throw new Error('Unexpected synthetic transport request')
  let resolve!: (response: AxiosResponse) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<AxiosResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  const request: Request = {
    config,
    done: false,
    settled: promise.then(
      () => undefined,
      () => undefined,
    ),
    resolve(data) {
      request.done = true
      resolve(response({ data }))
    },
    reject() {
      request.done = true
      reject(
        new AxiosError(
          'Synthetic HTTP 400',
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          response({ error: { message: PRIVATE_ERROR } }, 400),
        ),
      )
    },
  }
  requests.push(request)
  // Även ett sent transportresultat levereras; försöksgrinden är inte en mock.
  return promise
}
const matching = (kind: 'start' | 'collect' | 'choose') =>
  requests.filter((r) => r.config.url === `${PREFIX}${kind}`)
const payload = (request: Request): unknown => JSON.parse(String(request.config.data))
const hostTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function pending(kind: 'start' | 'collect' | 'choose', index: number) {
  await waitFor(() => expect(matching(kind).length).toBeGreaterThan(index))
  const request = matching(kind)[index]!
  expect(request.config.method).toBe('post')
  return request
}

async function finish(request: Request, data: unknown, error = false) {
  await act(async () => {
    if (error) request.reject()
    else request.resolve(data)
    await request.settled
    // Adapterns settlement räcker inte. Axios → post → komponentens then/catch/
    // finally är mikrotasks utan ytterligare awaits; en verklig host-task följer
    // hela nuvarande kedjan. act slutför därefter render/effects före assertions.
    await hostTask()
  })
}

function Location() {
  return <output aria-label="aktuell sida">{useLocation().pathname}</output>
}
async function showLogin() {
  const generation = useSessionStore.getState().sessionGeneration
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/login']}>
        <SessionBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/dashboard" element={<p>Inloggad</p>} />
          </Routes>
          <Location />
        </SessionBoundary>
      </MemoryRouter>
    </StrictMode>,
  )
  await screen.findByRole('button', { name: 'Logga in med BankID' })
  return generation
}
async function start() {
  const index = matching('start').length
  fireEvent.click(screen.getByRole('button', { name: 'Logga in med BankID' }))
  return pending('start', index)
}
function cancel() {
  fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
  expect(screen.queryByRole('dialog', { name: 'BankID' })).not.toBeInTheDocument()
}
async function poll(orderRef: string) {
  const index = matching('collect').length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  const request = await pending('collect', index)
  expect(payload(request)).toEqual({ orderRef })
  return request
}
async function reachChoices(tag: 'A' | 'B') {
  await finish(await start(), { orderRef: `synthetic-order-${tag}` })
  await finish(await poll(`synthetic-order-${tag}`), choices(tag))
  expect(
    screen.getByRole('button', { name: new RegExp(`^Hyresvärd ${tag}\\s*Syntetisk gata ${tag}$`) }),
  ).toBeInTheDocument()
}
async function choose(tag: 'A' | 'B') {
  const index = matching('choose').length
  const button = screen.getByRole('button', {
    name: new RegExp(`^Hyresvärd ${tag}\\s*Syntetisk gata ${tag}$`),
  })
  expect(button).toBeEnabled()
  fireEvent.click(button)
  const request = await pending('choose', index)
  expect(payload(request)).toEqual({
    chooseToken: `synthetic-choice-${tag}`,
    tenantId: tenants[tag].id,
  })
  return request
}
function anonymous(generation: number) {
  expect(useSessionStore.getState().sessionGeneration).toBe(generation)
  expect(useSessionStore.getState().isAuthenticated).toBe(false)
  expect(useSessionStore.getState().sessionToken).toBeNull()
  expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/login')
  expect(screen.queryByText(PRIVATE_ERROR)).not.toBeInTheDocument()
  expect(notifications.error).not.toHaveBeenCalled()
}
function signedIn(tag: 'A' | 'B') {
  expect(useSessionStore.getState().sessionToken).toBe(`bankid-session-${tag}`)
  expect(useSessionStore.getState().tenant?.id).toBe(tenants[tag].id)
  expect(useSessionStore.getState().isAuthenticated).toBe(true)
  expect(screen.getByLabelText('aktuell sida')).toHaveTextContent('/dashboard')
  expect(screen.queryByRole('dialog', { name: 'BankID' })).not.toBeInTheDocument()
  expect(notifications.error).not.toHaveBeenCalled()
}

beforeEach(() => {
  localStorage.clear()
  useSessionStore.getState().clearSession()
  requests.length = 0
  portalApi.defaults.adapter = adapter
  vi.clearAllMocks()
  // Endast komponentens 2s-pollintervall styrs; promise-/host-task-klockan är riktig.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(async () => {
  // Även ett rött delprov dränerar alla redan startade anrop efter avmontering.
  act(() => useSessionStore.getState().clearSession())
  cleanup()
  await act(async () => {
    for (const request of requests) if (!request.done) request.reject()
    await Promise.all(requests.map((request) => request.settled))
    await hostTask()
  })
  if (originalAdapter === undefined) delete portalApi.defaults.adapter
  else portalApi.defaults.adapter = originalAdapter
  localStorage.clear()
  vi.useRealTimers()
})

describe('BankID-försök via riktig LoginPage, Axios och SessionBoundary', () => {
  it.each([200, 400])(
    'öppnar inte det avbrutna startförsöket när dess sena %s landar',
    async (status) => {
      const generation = await showLogin()
      const old = await start()
      expect(screen.getByText('Startar BankID…')).toBeInTheDocument()
      cancel()
      await finish(old, { orderRef: 'synthetic-order-A' }, status === 400)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      anonymous(generation)
      expect(screen.queryByRole('dialog', { name: 'BankID' })).not.toBeInTheDocument()
      expect(matching('collect')).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Logga in med BankID' })).toBeEnabled()
    },
  )

  it.each([200, 400])(
    'behåller B:s order och verkliga collect efter avbrutna A:s start-%s',
    async (status) => {
      const generation = await showLogin()
      const old = await start()
      cancel()
      await finish(await start(), { orderRef: 'synthetic-order-B' })
      await finish(await poll('synthetic-order-B'), { status: 'pending', hintCode: 'userSign' })
      await finish(old, { orderRef: 'synthetic-order-A' }, status === 400)
      anonymous(generation)
      expect(screen.getByText('Skriv in din säkerhetskod i BankID-appen')).toBeInTheDocument()
      const current = await poll('synthetic-order-B')
      expect(matching('collect').map(payload)).toEqual([
        { orderRef: 'synthetic-order-B' },
        { orderRef: 'synthetic-order-B' },
      ])
      await finish(current, complete('B'))
      signedIn('B')
    },
  )

  it.each(['complete', 'error'] as const)(
    'bevarar B:s kandidater efter avbrutna A:s choose-%s och tillåter ett uttryckligt B-val',
    async (outcome) => {
      const generation = await showLogin()
      await reachChoices('A')
      const old = await choose('A')
      cancel()
      await reachChoices('B')
      anonymous(generation)
      await finish(old, complete('A'), outcome === 'error')
      anonymous(generation)
      expect(screen.getAllByTestId('bankid-candidate')).toHaveLength(2)
      expect(
        screen.getByRole('button', { name: /^Hyresvärd B\s*Syntetisk gata B$/ }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Alternativ B' })).toBeInTheDocument()
      expect(screen.queryByText('Hyresvärd A')).not.toBeInTheDocument()
      await finish(await choose('B'), complete('B'))
      signedIn('B')
      expect(matching('choose').map(payload)).toEqual([
        { chooseToken: 'synthetic-choice-A', tenantId: tenants.A.id },
        { chooseToken: 'synthetic-choice-B', tenantId: tenants.B.id },
      ])
    },
  )

  it('låter inte A:s sena catch/finally släppa spärren för B:s redan pågående val', async () => {
    const generation = await showLogin()
    await reachChoices('A')
    const old = await choose('A')
    cancel()
    await reachChoices('B')
    const current = await choose('B')
    expect(
      screen
        .getAllByTestId('bankid-candidate')
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    await finish(old, undefined, true)
    anonymous(generation)
    for (const button of screen.getAllByTestId('bankid-candidate')) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(matching('choose')).toHaveLength(2)
    await finish(current, complete('B'))
    signedIn('B')
  })

  it('bevarar första collect-svarets val när en överlappande collect avvisas i samma act', async () => {
    const generation = await showLogin()
    await finish(await start(), { orderRef: 'synthetic-order-A' })
    const first = await poll('synthetic-order-A')
    const second = await poll('synthetic-order-A')
    expect(first.done).toBe(false)
    expect(second.done).toBe(false)
    await act(async () => {
      first.resolve(choices('A'))
      second.reject()
      await Promise.all([first.settled, second.settled])
      await hostTask()
    })
    anonymous(generation)
    expect(screen.getAllByTestId('bankid-candidate')).toHaveLength(2)
    await finish(await choose('A'), complete('A'))
    signedIn('A')
    expect(matching('collect').map(payload)).toEqual([
      { orderRef: 'synthetic-order-A' },
      { orderRef: 'synthetic-order-A' },
    ])
  })
})
