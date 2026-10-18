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
import type { PortalActivationInfo } from '@/types/portal.types'
import { ActivatePage } from './ActivatePage/ActivatePage'

const notifications = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notifications }))

type Who = 'a' | 'b'
type Outcome = 'server' | 'network' | 'invalid' | 'success' | 'hold'
const TOKENS = { a: 'synthetic-activation-a', b: 'synthetic-activation-b' }
const NAMES = { a: 'Alicia Prov', b: 'Birger Prov' }
const PRIVATE_ERROR = 'PRIVATE_SYNTHETIC_GET_ERROR'
const originalAdapter = portalApi.defaults.adapter
const clients = new Set<QueryClient>()
const queryCompletions = new Set<Promise<void>>()
let currentClient: QueryClient | undefined
let outcomes: Record<Who, Outcome>
const calls: InternalAxiosRequestConfig[] = []
const unexpected: string[] = []
const path = (who: Who) => `/tenant-portal/activation/${TOKENS[who]}`
const link = (who: Who) => `/activate?token=${TOKENS[who]}`
const key = (who: Who) => ['tenant-portal', 'activation', TOKENS[who]]
const hostTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
interface Pending {
  who: Who
  settled: Promise<void>
  succeed: () => void
  fail: () => void
}
const pending: Pending[] = []
const adapter: AxiosAdapter = (config) => {
  calls.push(config)
  const response = (status: number, data: unknown): AxiosResponse => ({
    config,
    status,
    statusText: String(status),
    headers: {},
    data,
  })
  const rejectHttp = (status: number) =>
    new AxiosError(
      PRIVATE_ERROR,
      'ERR_BAD_RESPONSE',
      config,
      {},
      response(status, { success: false, error: { message: PRIVATE_ERROR } }),
    )
  if (config.method === 'get' && config.data === undefined) {
    for (const who of ['a', 'b'] as const) {
      // Befintlig avsiktlig PDF-fallback; ingen signerad URL/fil hämtas av riggen.
      if (config.url === `${path(who)}/contract`) return Promise.reject(rejectHttp(404))
      if (config.url !== path(who)) continue
      const success = () => response(200, { success: true, data: activationInfo(who) })
      if (outcomes[who] === 'success') return Promise.resolve(success())
      if (outcomes[who] === 'network')
        return Promise.reject(new AxiosError(PRIVATE_ERROR, 'ERR_NETWORK', config))
      if (outcomes[who] !== 'hold')
        return Promise.reject(rejectHttp(outcomes[who] === 'invalid' ? 401 : 500))
      let resolve!: (value: AxiosResponse) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<AxiosResponse>((yes, no) => {
        resolve = yes
        reject = no
      })
      pending.push({
        who,
        settled: promise.then(
          () => undefined,
          () => undefined,
        ),
        succeed: () => resolve(success()),
        fail: () => reject(rejectHttp(500)),
      })
      return promise
    }
  }
  unexpected.push(`${config.method} ${config.url}`)
  return Promise.reject(new Error('Oväntat anrop i aktiveringsprovet'))
}

function Controls() {
  const client = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    clients.add(client)
    currentClient = client
  }, [client])
  return (
    <>
      <output aria-label="aktuell adress">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(link('b'))}>Öppna länk B</button>
    </>
  )
}
function sessionSnapshot() {
  const state = useSessionStore.getState()
  return {
    sessionGeneration: state.sessionGeneration,
    sessionToken: state.sessionToken,
    tenant: state.tenant,
    expiresAt: state.expiresAt,
    isAuthenticated: state.isAuthenticated,
  }
}
function queryCompletion(who: Who) {
  const query = currentClient?.getQueryCache().find({ queryKey: key(who), exact: true })
  if (!query?.promise) throw new Error('Riktig påbörjad info-query krävs som slutbarriär')
  // Denna promise inkluderar Axios/interceptors + queryFn, inte bara adaptersettlement.
  const done = query.promise.then(
    () => undefined,
    () => undefined,
  )
  queryCompletions.add(done)
  return done
}
async function show(outcome: Outcome) {
  outcomes.a = outcome
  const session = sessionSnapshot()
  render(
    <StrictMode>
      <MemoryRouter
        initialEntries={[link('a')]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SessionBoundary>
          <Controls />
          <Routes>
            <Route path="/activate" element={<ActivatePage />} />
            <Route path="/dashboard" element={<h1>Inloggad startsida</h1>} />
          </Routes>
        </SessionBoundary>
      </MemoryRouter>
    </StrictMode>,
  )
  await waitFor(() => expect(calls.some((call) => call.url === path('a'))).toBe(true))
  await act(async () => {
    await queryCompletion('a')
    await hostTask()
  })
  return session
}
function expectUnchanged(session: ReturnType<typeof sessionSnapshot>, who: Who) {
  expect(sessionSnapshot()).toEqual(session)
  expect(session.isAuthenticated).toBe(false)
  expect(screen.getByLabelText('aktuell adress').textContent).toBe(link(who))
  expect(screen.queryByRole('heading', { name: 'Inloggad startsida' })).not.toBeInTheDocument()
  expect(calls.every((call) => call.method === 'get' && call.data === undefined)).toBe(true)
  expect(unexpected).toEqual([])
  expect(notifications.error).not.toHaveBeenCalled()
  expect(document.body).not.toHaveTextContent(PRIVATE_ERROR)
}
async function expectForm(who: Who) {
  await screen.findByRole('heading', { name: `Välkommen, ${NAMES[who]}!` })
  await waitFor(() => expect(screen.getByLabelText('Namnunderskrift')).toHaveValue(NAMES[who]))
  expect(screen.getByText(`Fastighet ${who} · Bostad ${who}`, { exact: true })).toBeInTheDocument()
  expect(screen.getByText('Sammanfattning', { exact: true })).toBeInTheDocument()
  expect(screen.getByLabelText('Nytt lösenord')).toHaveValue('')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await waitFor(() => expect(calls.some((call) => call.url === `${path(who)}/contract`)).toBe(true))
  const pdf = currentClient
    ?.getQueryCache()
    .find({ queryKey: ['tenant-portal', 'activation-contract', TOKENS[who]], exact: true })
  if (!pdf?.promise) throw new Error('Riktig PDF-query krävs för fallbackkontroll')
  await act(async () => {
    await pdf.promise?.catch(() => undefined)
    await hostTask()
  })
  expect(screen.queryByTitle('Hyreskontrakt')).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Ladda ner PDF' })).not.toBeInTheDocument()
}
async function beginRetry() {
  outcomes.a = 'hold'
  const before = calls.length
  const pendingBefore = pending.length
  fireEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
  await waitFor(() => expect(pending).toHaveLength(pendingBefore + 1))
  expect(calls.slice(before).map((call) => [call.method, call.url])).toEqual([['get', path('a')]])
  const request = pending[pendingBefore]!
  expect(request.who).toBe('a')
  await waitFor(() => {
    // Läs nuvarande DOM på nytt; en gammal knappreferens kan redan vara detached.
    const retryButton = screen.queryByRole('button', { name: 'Försök igen' })
    if (retryButton) expect(retryButton).toBeDisabled()
    else
      expect(
        screen.getByText('Hämtar dina kontraktsuppgifter...', { exact: true }),
      ).toBeInTheDocument()
  })
  return { request, done: queryCompletion('a') }
}
async function finishRetry(retry: Awaited<ReturnType<typeof beginRetry>>) {
  await act(async () => {
    retry.request.succeed()
    await retry.request.settled
    await retry.done
    await hostTask()
  })
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  localStorage.clear()
  useSessionStore.getState().clearSession()
  outcomes = { a: 'server', b: 'success' }
  calls.length = 0
  pending.length = 0
  unexpected.length = 0
  clients.clear()
  queryCompletions.clear()
  currentClient = undefined
  portalApi.defaults.adapter = adapter
})
afterEach(async () => {
  try {
    await act(async () => {
      useSessionStore.getState().clearSession()
      cleanup()
      pending.forEach((request) => request.fail())
      await Promise.all(pending.map((request) => request.settled))
      await Promise.all(queryCompletions)
      await Promise.all([...clients].map((client) => client.cancelQueries()))
      await hostTask()
    })
  } finally {
    clients.forEach((client) => client.clear())
    if (originalAdapter === undefined) delete portalApi.defaults.adapter
    else portalApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    useSessionStore.getState().clearSession()
    localStorage.clear()
  }
  expect(unexpected, 'Ingen mutation eller annan transport tillåten').toEqual([])
})

describe('aktiveringens första hämtning och manuella återförsök', () => {
  it.each(['server', 'network'] as const)(
    '%s är ett hämtningsfel; explicit nytt GET återställer samma formulär',
    async (failure) => {
      const session = await show(failure)
      expect(
        screen.getByRole('heading', { name: 'Kunde inte hämta uppgifterna' }),
      ).toBeInTheDocument()
      expect(document.body).not.toHaveTextContent(/ogiltig|gått ut|skicka en ny länk/i)
      expect(screen.getByRole('button', { name: 'Försök igen' })).toBeEnabled()
      expect(calls.every((call) => call.url === path('a'))).toBe(true)
      expectUnchanged(session, 'a')
      const before = calls.length
      await act(hostTask)
      expect(calls).toHaveLength(before)
      const retry = await beginRetry()
      expectUnchanged(session, 'a')
      await finishRetry(retry)
      await expectForm('a')
      expect(calls.filter((call) => call.url === path('a'))).toHaveLength(before + 1)
      expectUnchanged(session, 'a')
    },
  )

  it('backendens401 behåller ogiltig-länk-beskedet utan manuell retry', async () => {
    const session = await show('invalid')
    expect(screen.getByRole('heading', { name: 'Länken är ogiltig' })).toBeInTheDocument()
    expect(document.body).toHaveTextContent('Be din hyresvärd skicka en ny länk.')
    expect(screen.queryByRole('button', { name: 'Försök igen' })).not.toBeInTheDocument()
    expect(calls.every((call) => call.url === path('a'))).toBe(true)
    expectUnchanged(session, 'a')
  })

  it('info200 och separat PDF404 behåller den riktiga avtalssammanfattningen', async () => {
    const session = await show('success')
    await expectForm('a')
    expect(screen.getByText('Månadshyra', { exact: true })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Länken är ogiltig' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Kunde inte hämta uppgifterna' }),
    ).not.toBeInTheDocument()
    expectUnchanged(session, 'a')
  })

  it('sent retryA200 efter tokenbyte lämnar B:s formulär och utkast kvar', async () => {
    const session = await show('server')
    const retry = await beginRetry()
    fireEvent.click(screen.getByRole('button', { name: 'Öppna länk B' }))
    await expectForm('b')
    fireEvent.change(screen.getByLabelText('Namnunderskrift'), {
      target: { value: 'Birger B-utkast' },
    })
    fireEvent.change(screen.getByLabelText('Nytt lösenord'), {
      target: { value: 'Syntetiskt-B-losenord-456!' },
    })
    const beforeLateA = calls.length
    await finishRetry(retry)
    expect(screen.getByRole('heading', { name: `Välkommen, ${NAMES.b}!` })).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: `Välkommen, ${NAMES.a}!` }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Fastighet b · Bostad b', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('Fastighet a · Bostad a', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Namnunderskrift')).toHaveValue('Birger B-utkast')
    expect(screen.getByLabelText('Nytt lösenord')).toHaveValue('Syntetiskt-B-losenord-456!')
    expect(calls).toHaveLength(beforeLateA)
    expect(calls.some((call) => call.url === `${path('a')}/contract`)).toBe(false)
    expectUnchanged(session, 'b')
  })
})
