import { useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  onlineManager,
  useQueryClient,
  type NetworkMode,
  type QueryClient,
} from '@tanstack/react-query'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { MemoryRouter } from 'react-router-dom'
import { extractApiError, portalApi } from '@/api/portal.api'
import { useSessionMutation } from '@/lib/session-guard'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage/ForgotPasswordPage'
import { useSessionStore } from '@/store/session.store'
import { SessionBoundary } from './SessionBoundary'

const notifications = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notifications }))

// Endast nätets svar och toastens presentationsgräns ersätts. QueryClient,
// onlineManager, sessiongräns, mutationshook och Axios-interceptorer är riktiga.
const EMAIL = 'natprov@example.invalid'
const DRAFT_A = 'Syntetiskt utkast som tillhör A'
const DRAFT_B = 'Ett nytt uttryckligt utkast från B'
const PRIVATE_SENTINEL = 'RAW_NETWORK_SECRET_MUST_NOT_ESCAPE'
const FORGOT = '/tenant-portal/forgot-password'
const WRITE = '/portal/maintenance'
const requests: InternalAxiosRequestConfig[] = []
const clients = new Set<QueryClient>()
const successes = vi.fn()
const failures: unknown[] = []
const originalAdapter = portalApi.defaults.adapter
const originalOnline = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
let navigatorOnline = true
let transport: 'success' | 'network' | 'server' = 'success'
let transportGate: { promise: Promise<void>; resolve: () => void } | undefined

function holdTransport() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  transportGate = { promise, resolve }
  return transportGate
}

const adapter: AxiosAdapter = async (config) => {
  requests.push(config)
  if (config.url !== FORGOT && config.url !== WRITE) {
    throw new Error(`Oväntad testväg: ${config.url}`)
  }
  // Ett redan skickat anrop kan få ett bekräftat svar trots en senare
  // offline-signal. Barriären ändrar leveranstiden, inte valt transportsvar.
  const outcome = navigatorOnline ? transport : 'network'
  if (transportGate) await transportGate.promise
  if (outcome === 'network') {
    const error = new AxiosError(`Network Error ${PRIVATE_SENTINEL}`, 'ERR_NETWORK', config, {
      privateRequest: PRIVATE_SENTINEL,
    })
    error.cause = new Error(PRIVATE_SENTINEL)
    throw error
  }
  const response: AxiosResponse = {
    config,
    status: outcome === 'server' ? 500 : 200,
    statusText: outcome === 'server' ? 'Internal Server Error' : 'OK',
    headers: {},
    data:
      outcome === 'server'
        ? { success: false, error: { message: 'Syntetiskt serverfel' } }
        : { success: true, data: { id: 'synthetic-write', message: 'OK' } },
  }
  if (outcome === 'server') {
    throw new AxiosError(
      'Request failed with status code 500',
      'ERR_BAD_RESPONSE',
      config,
      null,
      response,
    )
  }
  return response
}

function ObserveClient() {
  const client = useQueryClient()
  useEffect(() => {
    clients.add(client)
  }, [client])
  return null
}

function WriteProbe({
  networkMode,
  retry = false,
  asyncMode = false,
}: {
  networkMode?: NetworkMode
  retry?: number | false
  asyncMode?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const mutation = useSessionMutation({
    ...(networkMode ? { networkMode } : {}),
    retry,
    retryDelay: 0,
    mutationFn: async (description: string) => {
      const response = await portalApi.post(WRITE, { title: 'Syntetiskt ärende', description })
      return response.data
    },
    onSuccess: successes,
    onError: (cause) => {
      failures.push(cause)
      setError(extractApiError(cause, 'Skrivningen kunde inte bekräftas.'))
    },
  })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        if (asyncMode) void mutation.mutateAsync(draft).catch(() => undefined)
        else mutation.mutate(draft)
      }}
    >
      <label htmlFor="network-draft">Utkast</label>
      <input
        id="network-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={mutation.isPending}
      />
      <button disabled={mutation.isPending || !draft}>Skicka utkast</button>
      <output aria-label="mutationsstatus">{mutation.status}</output>
      <output aria-label="pausad skrivning">{String(mutation.isPaused)}</output>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function callbackFixture(mode: 'mutate' | 'mutateAsync') {
  const variables = { description: DRAFT_A }
  const optimistic = { previousDescription: 'Tidigare syntetiskt utkast' }
  const mutationKey = ['network-callback-contract']
  const meta = { test: 'callback-contract' }
  const seen: { variables: typeof variables | undefined } = { variables: undefined }
  const onMutate = vi.fn((_variables: typeof variables, _context: unknown) => optimistic)
  const mutationFn = vi.fn(async (input: typeof variables, _context: unknown) => {
    const response = await portalApi.post<{ data: { id: string; message: string } }>(WRITE, input)
    return response.data.data
  })
  const hook = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
  const perCall = { onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() }
  const resolved = vi.fn()
  const rejected = vi.fn()
  function Probe() {
    const mutation = useSessionMutation<
      { id: string; message: string },
      Error,
      typeof variables,
      typeof optimistic
    >({ mutationKey, meta, onMutate, mutationFn, ...hook })
    seen.variables = mutation.variables
    return (
      <>
        <button
          onClick={() => {
            if (mode === 'mutateAsync') {
              void mutation.mutateAsync(variables, perCall).then(resolved, rejected)
            } else mutation.mutate(variables, perCall)
          }}
        >
          Prova callbackkontrakt
        </button>
        <output aria-label="kontraktsstatus">{mutation.status}</output>
      </>
    )
  }
  return {
    Probe,
    variables,
    optimistic,
    mutationKey,
    meta,
    seen,
    onMutate,
    mutationFn,
    hook,
    perCall,
    resolved,
    rejected,
  }
}

function show(children: ReactNode) {
  return render(
    <MemoryRouter>
      <SessionBoundary>
        <ObserveClient />
        {children}
      </SessionBoundary>
    </MemoryRouter>,
  )
}

function setNetwork(browser: boolean, query: boolean) {
  navigatorOnline = browser
  onlineManager.setOnline(query)
}

async function reconnect() {
  await act(async () => {
    setNetwork(true, true)
    // Avsluta riktiga återupptagningsförsök innan negativa assertions; ingen
    // godtycklig sleep eller förhoppning om att en dold kö redan hunnit köra.
    await Promise.all([...clients].map((client) => client.resumePausedMutations()))
  })
}

function write(draft = DRAFT_A) {
  fireEvent.change(screen.getByLabelText('Utkast'), { target: { value: draft } })
  fireEvent.click(screen.getByRole('button', { name: 'Skicka utkast' }))
}

function forgot() {
  fireEvent.change(screen.getByLabelText('E-postadress'), { target: { value: EMAIL } })
  fireEvent.click(screen.getByRole('button', { name: 'Skicka återställningslänk' }))
}

function expectNoFalseAssurance(text: string) {
  expect(text).not.toMatch(
    /inget (har )?(sparats|skickats)|inte (har )?(sparats|skickats)|ingenting (har )?(sparats|skickats)/i,
  )
}

beforeEach(() => {
  requests.length = 0
  clients.clear()
  failures.length = 0
  transport = 'success'
  transportGate = undefined
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => navigatorOnline,
  })
  setNetwork(true, true)
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
  vi.clearAllMocks()
})

afterEach(async () => {
  const mutations = [...clients].flatMap((client) => client.getMutationCache().getAll())
  cleanup()
  // Även en röd baslinje kan lämna en pausad mutation. Gör dess session inaktuell
  // innan köerna töms, så nästa prov aldrig kan ärva dess body eller callbacks.
  await act(async () => {
    useSessionStore.getState().clearSession()
    setNetwork(true, true)
    transportGate?.resolve()
    await Promise.allSettled(mutations.map((mutation) => mutation.continue()))
  })
  clients.forEach((client) => client.clear())
  if (originalAdapter === undefined) delete portalApi.defaults.adapter
  else portalApi.defaults.adapter = originalAdapter
  if (originalOnline) Object.defineProperty(window.navigator, 'onLine', originalOnline)
  else Reflect.deleteProperty(window.navigator, 'onLine')
  localStorage.clear()
})

describe('portalens skrivningar vid nätavbrott', () => {
  it.each([true, false])(
    'avslutar verkligt offlineformulär utan transport när onlineManager=%s och kräver nytt submit',
    async (queryOnline) => {
      setNetwork(false, queryOnline)
      show(<ForgotPasswordPage />)
      forgot()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Skicka återställningslänk' })).toBeEnabled(),
      )
      expect(screen.getByLabelText('E-postadress')).toHaveValue(EMAIL)
      expect(screen.getByLabelText('E-postadress')).toBeEnabled()
      expect(screen.queryByRole('heading', { name: 'Mejl skickat' })).not.toBeInTheDocument()
      expect(screen.getByText(/anslutningen|uppkoppling|offline|nätet/i)).toBeInTheDocument()
      expect(requests).toHaveLength(0)
      await reconnect()
      expect(requests).toHaveLength(0)
      expect(screen.queryByRole('heading', { name: 'Mejl skickat' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Skicka återställningslänk' }))
      expect(await screen.findByRole('heading', { name: 'Mejl skickat' })).toBeInTheDocument()
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe(FORGOT)
      expect(JSON.parse(String(requests[0]?.data))).toEqual({ email: EMAIL })
    },
  )

  it('återanslutning skickar inte ett tidigare offline-submit automatiskt', async () => {
    setNetwork(false, false)
    show(<ForgotPasswordPage />)
    forgot()
    await waitFor(() => {
      const mutations = [...clients][0]?.getMutationCache().getAll()
      expect(mutations).toHaveLength(1)
      const state = mutations?.[0]?.state
      expect(state?.status === 'error' || state?.isPaused).toBe(true)
    })
    // Baslinjen lämnar här en pausad mutation; provet släpper nätet även om
    // terminalt fel saknas, så själva felaktiga eftersändningen blir mätbar.
    await reconnect()
    expect(requests).toHaveLength(0)
    expect(screen.queryByRole('heading', { name: 'Mejl skickat' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('E-postadress')).toHaveValue(EMAIL)
  })

  it('förväxlar inte enbart onlineManager=false med navigator offline eller köar ett explicit submit', async () => {
    setNetwork(true, false)
    show(<ForgotPasswordPage />)
    forgot()
    expect(await screen.findByRole('heading', { name: 'Mejl skickat' })).toBeInTheDocument()
    expect(requests).toHaveLength(1)
    await reconnect()
    expect(requests).toHaveLength(1)
  })

  it.each(['network', 'server'] as const)(
    'verkliga glömt-lösenord-formuläret bevarar e-post vid %s och skickar igen endast på nytt submit',
    async (failure) => {
      transport = failure
      show(<ForgotPasswordPage />)
      forgot()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Skicka återställningslänk' })).toBeEnabled(),
      )
      expect(requests).toHaveLength(1)
      expect(screen.getByLabelText('E-postadress')).toHaveValue(EMAIL)
      expect(screen.queryByRole('heading', { name: 'Mejl skickat' })).not.toBeInTheDocument()
      expectNoFalseAssurance(document.body.textContent ?? '')
      act(() => setNetwork(false, false))
      transport = 'success'
      await reconnect()
      expect(requests).toHaveLength(1)
      expect(screen.queryByRole('heading', { name: 'Mejl skickat' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Skicka återställningslänk' }))
      expect(await screen.findByRole('heading', { name: 'Mejl skickat' })).toBeInTheDocument()
      expect(requests).toHaveLength(2)
    },
  )

  it.each(['online', 'offlineFirst', 'always'] as const)(
    'networkMode=%s och retry:2 får inte öppna en dold skrivkö eller automatiska försök',
    async (networkMode) => {
      transport = 'network'
      show(<WriteProbe networkMode={networkMode} retry={2} />)
      write()
      await waitFor(() =>
        expect(screen.getByLabelText('mutationsstatus')).toHaveTextContent('error'),
      )
      expect(screen.getByLabelText('pausad skrivning')).toHaveTextContent('false')
      expect(screen.getByLabelText('Utkast')).toHaveValue(DRAFT_A)
      expect(requests).toHaveLength(1)
      expect(successes).not.toHaveBeenCalled()
      expectNoFalseAssurance(screen.getByRole('alert').textContent ?? '')
      act(() => setNetwork(false, false))
      transport = 'success'
      await reconnect()
      expect(requests).toHaveLength(1)
      expect(successes).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Skicka utkast' }))
      await waitFor(() => expect(successes).toHaveBeenCalledTimes(1))
      expect(requests).toHaveLength(2)
    },
  )

  it('rensar råa transportdetaljer från ERR_NETWORK även när navigator säger online', async () => {
    transport = 'network'
    show(<WriteProbe />)
    write()
    await waitFor(() => expect(failures).toHaveLength(1))
    expect(requests).toHaveLength(1)
    expect(window.navigator.onLine).toBe(true)
    const error = failures[0]
    expect(error).toBeInstanceOf(Error)
    for (const field of ['config', 'request', 'response', 'cause']) {
      expect(error).not.toHaveProperty(field)
    }
    expect(String(error)).not.toContain(PRIVATE_SENTINEL)
    expect(document.body.textContent).not.toContain(PRIVATE_SENTINEL)
    expect(JSON.stringify(notifications.error.mock.calls)).not.toContain(PRIVATE_SENTINEL)
    expect(screen.getByRole('alert')).toHaveTextContent(/anslutningen|uppkoppling|nät/i)
    expectNoFalseAssurance(screen.getByRole('alert').textContent ?? '')
    expect(successes).not.toHaveBeenCalled()
  })

  it('bevarar HTTP500 som serverfel utan att lyckas eller försöka igen automatiskt', async () => {
    transport = 'server'
    show(<WriteProbe retry={2} />)
    write()
    await waitFor(() => expect(failures).toHaveLength(1))
    expect(requests).toHaveLength(1)
    expect(failures[0]).toHaveProperty('response.status', 500)
    expect(screen.getByRole('alert')).toHaveTextContent('Syntetiskt serverfel')
    expect(screen.getByLabelText('Utkast')).toHaveValue(DRAFT_A)
    expect(successes).not.toHaveBeenCalled()
    act(() => setNetwork(false, false))
    transport = 'success'
    await reconnect()
    expect(requests).toHaveLength(1)
    expect(successes).not.toHaveBeenCalled()
    expectNoFalseAssurance(screen.getByRole('alert').textContent ?? '')
  })

  it('skickar aldrig A:s offlineutkast med B:s token efter logout och återanslutning', async () => {
    const expiry = new Date(Date.now() + 3_600_000).toISOString()
    useSessionStore
      .getState()
      .setSession('token-a', { id: 'tenant-a', email: 'a@example.invalid' }, expiry)
    setNetwork(false, false)
    show(<WriteProbe networkMode="online" retry={2} />)
    write()
    await waitFor(() => {
      const mutations = [...clients][0]?.getMutationCache().getAll()
      expect(mutations).toHaveLength(1)
      const state = mutations?.[0]?.state
      expect(state?.status === 'error' || state?.isPaused).toBe(true)
    })
    const oldMutation = [...clients][0]?.getMutationCache().getAll()[0]
    expect(oldMutation).toBeDefined()
    act(() => {
      useSessionStore.getState().clearSession()
      useSessionStore
        .getState()
        .setSession('token-b', { id: 'tenant-b', email: 'b@example.invalid' }, expiry)
    })
    expect(screen.getByLabelText('Utkast')).toHaveValue('')
    await reconnect()
    await act(async () => {
      // Pröva även en redan borttagen mutations continuation, som cachetömning
      // ensam inte återkallar. Den gamla sessionsgrinden ska fortfarande neka.
      await oldMutation?.continue().catch(() => undefined)
    })
    expect(requests).toHaveLength(0)
    expect(successes).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
    write(DRAFT_B)
    await waitFor(() => expect(successes).toHaveBeenCalledTimes(1))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.Authorization).toBe('Bearer token-b')
    expect(JSON.parse(String(requests[0]?.data))).toEqual({
      title: 'Syntetiskt ärende',
      description: DRAFT_B,
    })
    expect(JSON.stringify(requests.map((request) => request.data))).not.toContain(DRAFT_A)
  })

  it.each(['mutate', 'mutateAsync'] as const)(
    '%s fångar offline vid klick även när nätet återkommer före nästa mikrotask',
    async (method) => {
      show(<WriteProbe asyncMode={method === 'mutateAsync'} />)
      act(() => {
        setNetwork(false, true)
        write()
        // Inget await: Axios kommer annars först att se det nya onlineläget.
        setNetwork(true, true)
      })
      await waitFor(() =>
        expect(screen.getByLabelText('mutationsstatus')).toHaveTextContent('error'),
      )
      expect(failures).toHaveLength(1)
      expect(failures[0]).toHaveProperty('kind', 'offline')
      expect(requests).toHaveLength(0)
      expect(successes).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Utkast')).toHaveValue(DRAFT_A)
      expect(screen.getByRole('button', { name: 'Skicka utkast' })).toBeEnabled()
      expect(screen.getByLabelText('pausad skrivning')).toHaveTextContent('false')
      await reconnect()
      expect(requests).toHaveLength(0)
    },
  )

  it.each([
    ['mutate', 'success'],
    ['mutate', 'server'],
    ['mutateAsync', 'success'],
    ['mutateAsync', 'server'],
  ] as const)(
    '%s bevarar variabelidentitet och context i alla callbacks vid %s',
    async (method, outcome) => {
      transport = outcome
      const fixture = callbackFixture(method)
      show(<fixture.Probe />)
      fireEvent.click(screen.getByRole('button', { name: 'Prova callbackkontrakt' }))
      await waitFor(() =>
        expect(screen.getByLabelText('kontraktsstatus')).toHaveTextContent(
          outcome === 'success' ? 'success' : 'error',
        ),
      )
      expect(requests).toHaveLength(1)
      expect(fixture.seen.variables).toBe(fixture.variables)
      expect(fixture.seen.variables).not.toHaveProperty('offlineAtStart')
      const expectedContext = {
        client: [...clients][0],
        meta: fixture.meta,
        mutationKey: fixture.mutationKey,
      }
      for (const callback of [fixture.onMutate, fixture.mutationFn]) {
        expect(callback).toHaveBeenCalledTimes(1)
        expect(callback.mock.calls[0]?.[0]).toBe(fixture.variables)
        expect(callback.mock.calls[0]?.[1]).toEqual(expectedContext)
      }
      const terminalHook = outcome === 'success' ? fixture.hook.onSuccess : fixture.hook.onError
      const terminalCall =
        outcome === 'success' ? fixture.perCall.onSuccess : fixture.perCall.onError
      const value = terminalHook.mock.calls[0]?.[0]
      if (outcome === 'success') {
        expect(value).toEqual({ id: 'synthetic-write', message: 'OK' })
        expect(fixture.hook.onError).not.toHaveBeenCalled()
        expect(fixture.perCall.onError).not.toHaveBeenCalled()
      } else {
        expect(value).toHaveProperty('response.status', 500)
        expect(fixture.hook.onSuccess).not.toHaveBeenCalled()
        expect(fixture.perCall.onSuccess).not.toHaveBeenCalled()
      }
      for (const callback of [terminalHook, terminalCall]) {
        expect(callback).toHaveBeenCalledTimes(1)
        expect(callback.mock.calls[0]?.[0]).toBe(value)
        expect(callback.mock.calls[0]?.[1]).toBe(fixture.variables)
        expect(callback.mock.calls[0]?.[2]).toBe(fixture.optimistic)
        expect(callback.mock.calls[0]?.[3]).toEqual(expectedContext)
      }
      for (const callback of [fixture.hook.onSettled, fixture.perCall.onSettled]) {
        expect(callback).toHaveBeenCalledTimes(1)
        expect(callback.mock.calls[0]?.[0]).toBe(outcome === 'success' ? value : undefined)
        expect(callback.mock.calls[0]?.[1]).toBe(outcome === 'success' ? null : value)
        expect(callback.mock.calls[0]?.[2]).toBe(fixture.variables)
        expect(callback.mock.calls[0]?.[3]).toBe(fixture.optimistic)
        expect(callback.mock.calls[0]?.[4]).toEqual(expectedContext)
      }
      if (method === 'mutateAsync') {
        await waitFor(() =>
          expect(outcome === 'success' ? fixture.resolved : fixture.rejected).toHaveBeenCalledWith(
            value,
          ),
        )
        expect(outcome === 'success' ? fixture.rejected : fixture.resolved).not.toHaveBeenCalled()
      }
    },
  )

  it('ignorerar ett sent ERR_NETWORK från A efter sessionsbyte till B', async () => {
    const expiry = new Date(Date.now() + 3_600_000).toISOString()
    useSessionStore
      .getState()
      .setSession('token-a', { id: 'tenant-a', email: 'a@example.invalid' }, expiry)
    transport = 'network'
    const gate = holdTransport()
    show(<WriteProbe />)
    write()
    await waitFor(() => expect(requests).toHaveLength(1))
    const oldMutation = [...clients][0]?.getMutationCache().getAll()[0]
    expect(oldMutation).toBeDefined()
    expect(requests[0]?.headers.Authorization).toBe('Bearer token-a')
    act(() => {
      useSessionStore.getState().clearSession()
      useSessionStore
        .getState()
        .setSession('token-b', { id: 'tenant-b', email: 'b@example.invalid' }, expiry)
    })
    await act(async () => {
      gate.resolve()
      await oldMutation?.continue().catch(() => undefined)
    })
    expect(useSessionStore.getState().sessionToken).toBe('token-b')
    expect(requests).toHaveLength(1)
    expect(failures).toHaveLength(0)
    expect(successes).not.toHaveBeenCalled()
    expect(notifications.error).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Utkast')).toHaveValue('')
  })

  it('accepterar bekräftad 200 för ett redan skickat anrop efter en senare offline-signal', async () => {
    const gate = holdTransport()
    show(<WriteProbe />)
    write()
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => {
      setNetwork(false, false)
      gate.resolve()
    })
    await waitFor(() => expect(successes).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('mutationsstatus')).toHaveTextContent('success')
    expect(failures).toHaveLength(0)
    expect(notifications.error).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    await reconnect()
    expect(requests).toHaveLength(1)
    expect(successes).toHaveBeenCalledTimes(1)
  })
})
