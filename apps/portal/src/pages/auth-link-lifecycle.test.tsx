import { StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { portalApi } from '@/api/portal.api'
import { SessionBoundary } from '@/components/SessionBoundary'
import { useSessionStore } from '@/store/session.store'
import type { PortalActivationInfo, PortalAuthResult } from '@/types/portal.types'
import { ActivatePage } from './ActivatePage/ActivatePage'
import { ResetPasswordPage } from './ResetPasswordPage/ResetPasswordPage'

const notifications = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notifications }))

const FORMS = [
  {
    name: 'aktivering',
    route: '/activate',
    endpoint: '/tenant-portal/activate',
    submit: 'Aktivera mitt konto',
  },
  {
    name: 'återställning',
    route: '/reset-password',
    endpoint: '/tenant-portal/reset-password',
    submit: 'Spara nytt lösenord',
  },
] as const
type Form = (typeof FORMS)[number]
type Who = 'a' | 'b'
const TOKENS = { a: 'synthetic-link-a', b: 'synthetic-link-b' }
const NAMES = { a: 'Alicia Prov', b: 'Birger Prov' }
const PASSWORDS = { a: 'Syntetiskt-A-losenord-123!', b: 'Syntetiskt-B-losenord-456!' }
const PRIVATE_A = 'PRIVATE_ABANDONED_FORM_ERROR'
const CURRENT_ERROR = 'Det nya lösenordet behöver korrigeras.'
const originalAdapter = portalApi.defaults.adapter
const clients = new Set<QueryClient>()
const subscriptions = new Set<() => void>()
type CachedMutation = ReturnType<ReturnType<QueryClient['getMutationCache']>['getAll']>[number]

function completion() {
  let resolve!: () => void
  const done = new Promise<void>((yes) => {
    resolve = yes
  })
  return { done, resolve }
}
const mutations = new Map<CachedMutation, ReturnType<typeof completion>>()
function observe(client: QueryClient) {
  if (clients.has(client)) return
  clients.add(client)
  // Lyssnaren lever till teardown, även när en route försvinner eller cache rensas.
  // success/error dispatchas efter mutationens awaitade callbacks, inte vid adaptersvaret.
  subscriptions.add(
    client.getMutationCache().subscribe((event) => {
      if (event.type !== 'added' && event.type !== 'updated') return
      let tracked = mutations.get(event.mutation)
      if (!tracked) {
        tracked = completion()
        mutations.set(event.mutation, tracked)
      }
      if (event.mutation.state.status === 'success' || event.mutation.state.status === 'error') {
        tracked.resolve()
      }
    }),
  )
}

function activationInfo(who: Who): PortalActivationInfo {
  return {
    tenant: {
      id: `tenant-${who}`,
      type: 'INDIVIDUAL',
      firstName: who === 'a' ? 'Alicia' : 'Birger',
      lastName: 'Prov',
      companyName: null,
      email: `${who}@example.invalid`,
    },
    organization: { id: `org-${who}`, name: `Syntetisk hyresvärd ${who.toUpperCase()}` },
    lease: {
      id: `lease-${who}`,
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: null,
      monthlyRent: 7500,
      depositAmount: 0,
      noticePeriodMonths: 3,
      leaseType: 'INDEFINITE',
      unit: {
        id: `unit-${who}`,
        name: `Bostad ${who}`,
        unitNumber: '1001',
        property: {
          name: `Fastighet ${who}`,
          street: 'Provvägen 1',
          city: 'Provstad',
          postalCode: '12345',
        },
      },
    },
  }
}
function authResult(who: Who): PortalAuthResult {
  return {
    sessionToken: `synthetic-session-${who}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tenant: {
      id: `tenant-${who}`,
      email: `${who}@example.invalid`,
      firstName: who === 'a' ? 'Alicia' : 'Birger',
      lastName: 'Prov',
      companyName: null,
    },
  }
}
interface PendingRequest {
  config: InternalAxiosRequestConfig
  settled: Promise<void>
  succeed: (who: Who) => void
  fail: (message: string) => void
}
const requests: PendingRequest[] = []
const adapter: AxiosAdapter = (config) => {
  const response = (status: number, data: unknown): AxiosResponse => ({
    config,
    status,
    statusText: String(status),
    headers: {},
    data,
  })
  if (config.method === 'get') {
    for (const who of ['a', 'b'] as const) {
      const path = `/tenant-portal/activation/${TOKENS[who]}`
      if (config.url === path)
        return Promise.resolve(response(200, { success: true, data: activationInfo(who) }))
      // En tillåten saknad PDF: sidan använder sin riktiga kontraktssammanfattning.
      if (config.url === `${path}/contract`)
        return Promise.reject(
          new AxiosError(
            'Syntetisk PDF saknas',
            'ERR_BAD_RESPONSE',
            config,
            {},
            response(404, { success: false, error: { message: 'Syntetisk PDF saknas' } }),
          ),
        )
    }
  }
  if (config.method !== 'post' || !FORMS.some((form) => form.endpoint === config.url)) {
    return Promise.reject(new Error('Oväntat anrop i länklivstidsprovet'))
  }
  let resolve!: (response: AxiosResponse) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<AxiosResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  requests.push({
    config,
    settled: promise.then(
      () => undefined,
      () => undefined,
    ),
    succeed: (who) => resolve(response(200, { success: true, data: authResult(who) })),
    fail: (message) =>
      reject(
        new AxiosError(
          message,
          'ERR_BAD_RESPONSE',
          config,
          {},
          response(400, { success: false, error: { message } }),
        ),
      ),
  })
  return promise
}

function link(form: Form, who: Who) {
  return `${form.route}?token=${TOKENS[who]}`
}
function Controls({ form }: { form: Form }) {
  const client = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => observe(client), [client])
  return (
    <>
      <output aria-label="aktuell adress">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate('/annan-sida')}>Lämna länken</button>
      <button onClick={() => navigate(link(form, 'b'))}>Öppna länk B</button>
    </>
  )
}
async function ready(form: Form, who: Who) {
  expect(screen.getByLabelText('aktuell adress')).toHaveTextContent(link(form, who))
  if (form.route === '/activate')
    await screen.findByRole('heading', { name: `Välkommen, ${NAMES[who]}!` })
  await screen.findByLabelText('Nytt lösenord')
}
async function show(form: Form) {
  render(
    <StrictMode>
      <MemoryRouter
        initialEntries={[link(form, 'a')]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SessionBoundary>
          <Controls form={form} />
          <Routes>
            <Route path="/activate" element={<ActivatePage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/annan-sida" element={<h1>Annan sida</h1>} />
            <Route path="/dashboard" element={<h1>Inloggad startsida</h1>} />
          </Routes>
        </SessionBoundary>
      </MemoryRouter>
    </StrictMode>,
  )
  await ready(form, 'a')
}
function fill(form: Form, who: Who, password = PASSWORDS[who]) {
  if (form.route === '/activate') {
    fireEvent.change(screen.getByLabelText('Namnunderskrift'), { target: { value: NAMES[who] } })
    const signed = screen.getByRole('checkbox') as HTMLInputElement
    if (!signed.checked) fireEvent.click(signed)
  }
  fireEvent.change(screen.getByLabelText('Nytt lösenord'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('Bekräfta lösenord'), { target: { value: password } })
}
async function submit(form: Form, who: Who, password = PASSWORDS[who]) {
  const requestCount = requests.length
  const mutationCount = mutations.size
  const button = screen.getByRole('button', { name: form.submit })
  expect(button).toBeEnabled()
  const element = button.closest('form')
  if (!element) throw new Error('Ett riktigt länkformulär krävs')
  fireEvent.submit(element)
  await waitFor(() => expect(requests).toHaveLength(requestCount + 1))
  expect(mutations.size).toBe(mutationCount + 1)
  const request = requests[requestCount]!
  const tracked = [...mutations.values()].at(-1)!
  expect(request.config.url).toBe(form.endpoint)
  expect(JSON.parse(request.config.data as string)).toEqual({
    token: TOKENS[who],
    password,
    ...(form.route === '/activate' ? { signatureName: NAMES[who] } : {}),
  })
  return { request, tracked }
}
type Attempt = Awaited<ReturnType<typeof submit>>
async function finish(attempt: Attempt, outcome: Who | { error: string }) {
  await act(async () => {
    if (typeof outcome === 'string') attempt.request.succeed(outcome)
    else attempt.request.fail(outcome.error)
    await attempt.request.settled
    await attempt.tracked.done
  })
}
function expectAnonymous() {
  expect(useSessionStore.getState()).toMatchObject({
    isAuthenticated: false,
    sessionToken: null,
    tenant: null,
  })
  expect(screen.queryByRole('heading', { name: 'Inloggad startsida' })).not.toBeInTheDocument()
}
async function openB(form: Form) {
  fireEvent.click(screen.getByRole('button', { name: 'Öppna länk B' }))
  await ready(form, 'b')
}
async function succeedB(form: Form) {
  fill(form, 'b')
  const current = await submit(form, 'b')
  await finish(current, 'b')
  expect(useSessionStore.getState()).toMatchObject({
    isAuthenticated: true,
    sessionToken: 'synthetic-session-b',
    tenant: { id: 'tenant-b' },
  })
  expect(screen.getByRole('heading', { name: 'Inloggad startsida' })).toBeInTheDocument()
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  requests.length = 0
  clients.clear()
  mutations.clear()
  subscriptions.clear()
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
})
afterEach(async () => {
  try {
    await act(async () => {
      useSessionStore.getState().clearSession()
      cleanup()
      requests.forEach((request) => request.fail('Testtransport avslutad'))
      await Promise.all(requests.map((request) => request.settled))
      await Promise.all([...mutations.values()].map((tracked) => tracked.done))
      await Promise.all([...clients].map((client) => client.cancelQueries()))
    })
  } finally {
    subscriptions.forEach((unsubscribe) => unsubscribe())
    clients.forEach((client) => client.clear())
    if (originalAdapter === undefined) delete portalApi.defaults.adapter
    else portalApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    useSessionStore.getState().clearSession()
    localStorage.clear()
  }
})

for (const form of FORMS) {
  describe(`${form.name}: formulärets länk och livstid äger svaret`, () => {
    it.each([200, 400])(
      'sen %s efter lämnad sida loggar inte in eller visar gammalt fel; B fungerar',
      async (status) => {
        await show(form)
        fill(form, 'a')
        const old = await submit(form, 'a')
        const generation = useSessionStore.getState().sessionGeneration
        fireEvent.click(screen.getByRole('button', { name: 'Lämna länken' }))
        expect(screen.getByRole('heading', { name: 'Annan sida' })).toBeInTheDocument()
        expect(useSessionStore.getState().sessionGeneration).toBe(generation)
        await finish(old, status === 200 ? 'a' : { error: PRIVATE_A })
        expectAnonymous()
        expect(screen.getByLabelText('aktuell adress')).toHaveTextContent(/^\/annan-sida$/)
        expect(document.body).not.toHaveTextContent(PRIVATE_A)
        expect(notifications.error).not.toHaveBeenCalled()
        await openB(form)
        await succeedB(form)
        expect(requests).toHaveLength(2)
      },
    )

    it('tokenbyte tömmer lösenord och tidigare godkännande utan att skicka', async () => {
      await show(form)
      fill(form, 'a')
      await openB(form)
      if (form.route === '/activate') {
        await waitFor(() => expect(screen.getByLabelText('Namnunderskrift')).toHaveValue(NAMES.b))
        expect(screen.getByRole('checkbox')).not.toBeChecked()
      }
      expect(screen.getByLabelText('Nytt lösenord')).toHaveValue('')
      expect(screen.getByLabelText('Bekräfta lösenord')).toHaveValue('')
      expectAnonymous()
      expect(requests).toHaveLength(0)
    })

    it('sent A200 efter tokenbyte lämnar B-formuläret och B:s explicita submit användbara', async () => {
      await show(form)
      fill(form, 'a')
      const old = await submit(form, 'a')
      const generation = useSessionStore.getState().sessionGeneration
      await openB(form)
      expect(useSessionStore.getState().sessionGeneration).toBe(generation)
      await finish(old, 'a')
      expectAnonymous()
      expect(screen.getByLabelText('aktuell adress')).toHaveTextContent(link(form, 'b'))
      expect(notifications.error).not.toHaveBeenCalled()
      await succeedB(form)
      expect(requests).toHaveLength(2)
    })

    it('aktuellt400 visas inline och ett uttryckligt korrigerat nytt försök lyckas', async () => {
      await show(form)
      fill(form, 'a')
      const rejected = await submit(form, 'a')
      await finish(rejected, { error: CURRENT_ERROR })
      expectAnonymous()
      expect(screen.getByRole('alert')).toHaveTextContent(CURRENT_ERROR)
      expect(notifications.error).not.toHaveBeenCalled()
      expect(requests).toHaveLength(1)
      fill(form, 'a', PASSWORDS.b)
      const retry = await submit(form, 'a', PASSWORDS.b)
      await finish(retry, 'a')
      expect(requests).toHaveLength(2)
      expect(useSessionStore.getState().sessionToken).toBe('synthetic-session-a')
      expect(screen.getByRole('heading', { name: 'Inloggad startsida' })).toBeInTheDocument()
    })

    it('verkligt sessionsbyte till B behåller det befintliga skyddet mot sent A200', async () => {
      await show(form)
      fill(form, 'a')
      const old = await submit(form, 'a')
      const b = authResult('b')
      act(() => useSessionStore.getState().setSession(b.sessionToken, b.tenant, b.expiresAt))
      await finish(old, 'a')
      expect(useSessionStore.getState()).toMatchObject({
        isAuthenticated: true,
        sessionToken: b.sessionToken,
        tenant: { id: 'tenant-b' },
      })
      expect(screen.getByLabelText('aktuell adress')).toHaveTextContent(link(form, 'a'))
      expect(screen.queryByRole('heading', { name: 'Inloggad startsida' })).not.toBeInTheDocument()
      expect(notifications.error).not.toHaveBeenCalled()
      expect(requests).toHaveLength(1)
    })
  })
}
