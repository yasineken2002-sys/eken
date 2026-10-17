import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { portalApi } from '@/api/portal.api'
import { RequireAuth } from '@/components/RequireAuth'
import { SessionBoundary } from '@/components/SessionBoundary'
import { useSessionStore } from '@/store/session.store'
import { SettingsPage } from './SettingsPage'

const notifications = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notifications }))

// Riktig sida, router, RequireAuth, API-helper, Axios-interceptorer och session.
// API-specen tenant-delete-account-http.spec.ts belägger serverns 400/401/204.
// Här ersätts bara transporten och toast. Inga konton eller DB-poster raderas.
const calls: InternalAxiosRequestConfig[] = []
const requests: PendingDelete[] = []
const originalAdapter = portalApi.defaults.adapter
const PRIVATE_A = 'PRIVATE_OLD_ACCOUNT_ERROR'
interface PendingDelete {
  config: InternalAxiosRequestConfig
  settled: Promise<void>
  respond: (status: number, message?: string) => void
}
const adapter: AxiosAdapter = (config) => {
  calls.push(config)
  const response = (status: number, message?: string): AxiosResponse => ({
    config,
    status,
    statusText: String(status),
    headers: {},
    data: status >= 400 ? { success: false, error: { message } } : { success: true, data: null },
  })
  if (config.url === '/tenant-portal/logout' && config.method === 'post') {
    return Promise.resolve(response(200))
  }
  if (config.url !== '/portal/me' || config.method !== 'delete') {
    return Promise.reject(new Error('Oväntat testanrop'))
  }
  let resolve!: (result: AxiosResponse) => void
  let reject!: (error: unknown) => void
  const pending = new Promise<AxiosResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  requests.push({
    config,
    settled: pending.then(
      () => undefined,
      () => undefined,
    ),
    respond: (status, message) => {
      if (status >= 400)
        reject(new AxiosError(message, 'ERR_BAD_RESPONSE', config, {}, response(status, message)))
      else resolve(response(status))
    },
  })
  return pending
}
function signIn(who: 'a' | 'b') {
  useSessionStore.getState().setSession(
    `synthetic-token-${who}`,
    {
      id: `synthetic-tenant-${who}`,
      email: `${who}@example.invalid`,
      firstName: `Syntetisk ${who}`,
    },
    new Date(Date.now() + 3_600_000).toISOString(),
  )
}
function show() {
  signIn('a')
  render(
    <MemoryRouter
      initialEntries={['/settings']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SessionBoundary>
        <Routes>
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<p>Inloggningssidan i testet</p>} />
        </Routes>
      </SessionBoundary>
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Radera konto' }))
}
async function submit(password: string, who: 'a' | 'b' = 'a') {
  const count = requests.length
  fireEvent.change(screen.getByPlaceholderText('Bekräfta med ditt lösenord'), {
    target: { value: password },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Bekräfta radering' }))
  expect(screen.getByRole('button', { name: 'Raderar…' })).toBeDisabled()
  await waitFor(() => expect(requests).toHaveLength(count + 1))
  const request = requests[count]!
  expect(request.config.headers.Authorization).toBe(`Bearer synthetic-token-${who}`)
  expect(JSON.parse(request.config.data as string)).toEqual({ password })
  return request
}
// Efter adaptersettlement måste även Axios och sidans await/catch hinna klart.
// Den aktuella handlern utför session/error/navigation synkront efter sin await.
// Nästa host-task väntar ut dessa Promise-jobb; framtida timer/I/O-await kräver
// annan completionbarriär. Ingen generell vänta-noll-garanti påstås.
const nextHostTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function finish(request: PendingDelete, status: number, message?: string) {
  await act(async () => {
    request.respond(status, message)
    await request.settled
    await nextHostTask()
  })
}
function expectSession(who: 'a' | 'b') {
  expect(useSessionStore.getState()).toMatchObject({
    isAuthenticated: true,
    sessionToken: `synthetic-token-${who}`,
    tenant: { id: `synthetic-tenant-${who}` },
  })
  expect(screen.queryByText('Inloggningssidan i testet')).not.toBeInTheDocument()
}
function logoutCalls() {
  return calls.filter((call) => call.url === '/tenant-portal/logout')
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  calls.length = 0
  requests.length = 0
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
})
afterEach(async () => {
  try {
    await act(async () => {
      useSessionStore.getState().clearSession()
      cleanup()
      requests.forEach((request) => request.respond(500, 'Testtransport avslutad'))
      await Promise.all(requests.map((request) => request.settled))
      await nextHostTask()
    })
  } finally {
    if (originalAdapter === undefined) delete portalApi.defaults.adapter
    else portalApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    useSessionStore.getState().clearSession()
    localStorage.clear()
  }
})

describe('SettingsPage: raderingslösenord och session är skilda kontroller', () => {
  it('visar fel lösenord utan logout; först en uttrycklig korrigering får radera och lämna sessionen', async () => {
    show()
    const wrong = await submit('Syntetiskt-fel-123!')
    await finish(wrong, 400, 'Felaktigt lösenord')
    expectSession('a')
    expect(screen.getByText('Felaktigt lösenord')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bekräfta radering' })).toBeEnabled()
    expect(requests).toHaveLength(1)
    expect(logoutCalls()).toHaveLength(0)

    const corrected = await submit('Syntetiskt-ratt-123!')
    expect(screen.queryByText('Felaktigt lösenord')).not.toBeInTheDocument()
    await finish(corrected, 204)
    expect(screen.getByText('Inloggningssidan i testet')).toBeInTheDocument()
    expect(useSessionStore.getState().isAuthenticated).toBe(false)
    expect(requests).toHaveLength(2)
    expect(logoutCalls()).toHaveLength(1)
    expect(JSON.parse(logoutCalls()[0]!.data as string)).toEqual({
      sessionToken: 'synthetic-token-a',
    })
    expect(notifications.error).not.toHaveBeenCalled()
  })

  it('två synkrona bekräftelseklick före React-commit skickar bara ett DELETE', async () => {
    show()
    const password = 'Syntetiskt-synkront-123!'
    fireEvent.change(screen.getByPlaceholderText('Bekräfta med ditt lösenord'), {
      target: { value: password },
    })
    const confirm = screen.getByRole('button', { name: 'Bekräfta radering' })
    // Native DOM-klick i samma act: disabled har ännu inte committats mellan dem.
    // Ingen direkt handler-/API-mock får ersätta den riktiga händelsekedjan.
    act(() => {
      confirm.click()
      confirm.click()
    })
    await act(async () => {
      await nextHostTask()
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.config.headers.Authorization).toBe('Bearer synthetic-token-a')
    expect(JSON.parse(requests[0]!.config.data as string)).toEqual({ password })
    expect(screen.getByRole('button', { name: 'Raderar…' })).toBeDisabled()
    await finish(requests[0]!, 204)
    expect(requests).toHaveLength(1)
    expect(logoutCalls()).toHaveLength(1)
    expect(screen.getByText('Inloggningssidan i testet')).toBeInTheDocument()
  })

  it('ett skickat DELETE kan inte döljas med Avbryt och låser lösenordskontroller tills svaret', async () => {
    show()
    // Avbryt är fortfarande en verklig möjlighet innan något anrop har skickats.
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
    expect(screen.queryByPlaceholderText('Bekräfta med ditt lösenord')).not.toBeInTheDocument()
    expect(requests).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Radera konto' }))
    const password = 'Syntetiskt-pagaende-123!'
    fireEvent.change(screen.getByPlaceholderText('Bekräfta med ditt lösenord'), {
      target: { value: password },
    })
    const confirm = screen.getByRole('button', { name: 'Bekräfta radering' })
    const cancel = screen.getByRole('button', { name: 'Avbryt' })
    // Bekräfta → Avbryt före commit behöver en synkron spärr, inte bara disabled.
    act(() => {
      confirm.click()
      cancel.click()
    })
    await act(async () => {
      await nextHostTask()
    })
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!.config.data as string)).toEqual({ password })
    const input = screen.getByPlaceholderText('Bekräfta med ditt lösenord')
    expect(input).toBeVisible()
    expect(input).toHaveValue(password)
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Visa lösenord' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Avbryt' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Raderar…' })).toBeDisabled()
    act(() => cancel.click())
    expect(input).toBeInTheDocument()
    expect(requests).toHaveLength(1)

    await finish(requests[0]!, 400, 'Felaktigt lösenord')
    expectSession('a')
    expect(screen.getByText('Felaktigt lösenord')).toBeInTheDocument()
    expect(input).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Visa lösenord' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Avbryt' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }))
    expect(screen.queryByPlaceholderText('Bekräfta med ditt lösenord')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Radera konto' })).toBeEnabled()
    expect(requests).toHaveLength(1)
    expect(logoutCalls()).toHaveLength(0)
  })

  it('behåller riktig 401 som sessionsfel även på raderingsvägen', async () => {
    show()
    const invalidSession = await submit('Syntetiskt-ratt-123!')
    await finish(invalidSession, 401, 'Sessionen har gått ut')
    expect(screen.getByText('Inloggningssidan i testet')).toBeInTheDocument()
    expect(useSessionStore.getState().isAuthenticated).toBe(false)
    expect(requests).toHaveLength(1)
    expect(logoutCalls()).toHaveLength(0)
    expect(screen.queryByText('Sessionen har gått ut')).not.toBeInTheDocument()
  })

  it.each([400, 401, 204])('A:s sena %s påverkar inte B:s konto eller session', async (status) => {
    show()
    const old = await submit('Syntetiskt-fel-123!')
    act(() => signIn('b'))
    expect(screen.getByText(/b@example.invalid/)).toBeInTheDocument()
    await finish(old, status, PRIVATE_A)
    expectSession('b')
    expect(screen.queryByText(PRIVATE_A)).not.toBeInTheDocument()
    expect(logoutCalls()).toHaveLength(0)
    expect(requests).toHaveLength(1)
    expect(notifications.error).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Radera konto' })).toBeEnabled()
  })
})
