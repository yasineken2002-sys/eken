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
const DATA_A = { tenant: 'Syntetisk A', amount: 0.29, note: 'Å/Ö', missing: null }
const DATA_B = { tenant: 'Syntetisk B', amount: 12.5, note: 'B', missing: null }
const JSON_A =
  '{\n  "tenant": "Syntetisk A",\n  "amount": 0.29,\n  "note": "Å/Ö",\n  "missing": null\n}'
const JSON_B =
  '{\n  "tenant": "Syntetisk B",\n  "amount": 12.5,\n  "note": "B",\n  "missing": null\n}'
interface Request {
  config: InternalAxiosRequestConfig
  settled: Promise<void>
  respond: (status: number, data: unknown) => void
}
const requests: Request[] = []
const unexpected: string[] = []
const interceptors: number[] = []
const blobs: Blob[] = []
const clicked: { href: string; filename: string; connected: boolean; revoked: boolean }[] = []
const originalAdapter = portalApi.defaults.adapter
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const revoke = vi.fn((_url: string) => undefined)
const create = vi.fn((blob: Blob) => {
  blobs.push(blob)
  return `blob:synthetic-export-${blobs.length}`
})
const adapter: AxiosAdapter = (config) => {
  if (config.method !== 'get' || config.url !== '/portal/me/export') {
    unexpected.push(`${config.method} ${config.url}`)
    return Promise.reject(new Error('Oväntat syntetiskt anrop'))
  }
  let resolve!: (value: AxiosResponse) => void
  let reject!: (reason: unknown) => void
  const result = new Promise<AxiosResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  requests.push({
    config,
    settled: result.then(
      () => undefined,
      () => undefined,
    ),
    respond: (status, data) => {
      const response: AxiosResponse = {
        config,
        status,
        statusText: String(status),
        headers: {},
        data: status < 400 ? { success: true, data } : { success: false, error: { message: data } },
      }
      if (status < 400) resolve(response)
      else reject(new AxiosError('Syntetiskt GET-fel', 'ERR_BAD_RESPONSE', config, {}, response))
    },
  })
  return result
}
function signIn(who: 'a' | 'b') {
  useSessionStore.getState().setSession(
    `synthetic-export-${who}`,
    {
      id: `tenant-${who}`,
      email: `${who}@example.invalid`,
      firstName: `Syntetisk ${who}`,
    },
    '2030-06-16T12:00:00.000Z',
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
          <Route path="/login" element={<p>Utloggad i testet</p>} />
        </Routes>
      </SessionBoundary>
    </MemoryRouter>,
  )
}
async function begin(who: 'a' | 'b' = 'a') {
  const count = requests.length
  fireEvent.click(screen.getByRole('button', { name: 'Ladda ner' }))
  expect(screen.getByRole('button', { name: 'Hämtar…' })).toBeDisabled()
  await waitFor(() => expect(requests).toHaveLength(count + 1))
  const request = requests[count]!
  expect(request.config.headers.Authorization).toBe(`Bearer synthetic-export-${who}`)
  expect(request.config.data).toBeUndefined()
  return request
}
// Verklig host-task efter adapter→Axios→get→sidans enda await; kvarvarande
// guard/blob/klick/catch/finally är synkrona. Framtida I/O-await kräver ny barriär.
// Date är fryst separat; setTimeout är INTE fejkad. Adaptersettlement räcker inte.
const nextHostTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function finish(request: Request, status: number, data: unknown) {
  await act(async () => {
    request.respond(status, data)
    await request.settled
    await nextHostTask()
  })
}
function expectB() {
  expect(useSessionStore.getState()).toMatchObject({
    isAuthenticated: true,
    sessionToken: 'synthetic-export-b',
    tenant: { id: 'tenant-b' },
  })
  expect(screen.getByText('b@example.invalid · Syntetisk b')).toBeInTheDocument()
  expect(screen.queryByText('Utloggad i testet')).not.toBeInTheDocument()
}
function expectNoDownload() {
  expect(create).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
  expect(document.querySelector('a[download]')).toBeNull()
  expect(notifications.error).not.toHaveBeenCalled()
}
async function expectDownload(expected: string) {
  expect(create).toHaveBeenCalledTimes(1)
  expect(blobs).toHaveLength(1)
  expect(blobs[0]).toBeInstanceOf(Blob)
  expect(blobs[0]!.type).toBe('application/json')
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blobs[0]!)
  })
  expect(text).toBe(expected)
  expect(clicked).toEqual([
    {
      href: 'blob:synthetic-export-1',
      filename: 'eveno-mina-uppgifter-2030-06-15.json',
      connected: true,
      revoked: false,
    },
  ])
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledWith('blob:synthetic-export-1')
  expect(document.querySelector('a[download]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Ladda ner' })).toBeEnabled()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-06-15T12:00:00.000Z'))
  vi.clearAllMocks()
  requests.length = unexpected.length = interceptors.length = blobs.length = clicked.length = 0
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({
      href: this.href,
      filename: this.download,
      connected: this.isConnected,
      revoked: revoke.mock.calls.some(([url]) => url === this.href),
    })
  })
})
afterEach(async () => {
  try {
    // Eject först: en kvarvarande testinterceptor får inte återinlogga i teardown.
    for (const id of interceptors) portalApi.interceptors.response.eject(id)
    await act(async () => {
      useSessionStore.getState().clearSession()
      cleanup()
      requests.forEach((request) => request.respond(500, 'Syntetisk transport avslutad'))
      await Promise.all(requests.map((request) => request.settled))
      await nextHostTask()
    })
  } finally {
    if (originalAdapter === undefined) delete portalApi.defaults.adapter
    else portalApi.defaults.adapter = originalAdapter
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
    vi.restoreAllMocks()
    vi.useRealTimers()
    useSessionStore.getState().clearSession()
    localStorage.clear()
    document.querySelectorAll('a[download]').forEach((anchor) => anchor.remove())
  }
  expect(unexpected).toEqual([])
})

describe('SettingsPage: faktisk JSON-export och sessionslivstid', () => {
  it('exporterar rätt JSON, MIME och datumfilnamn och frigör URL efter klick', async () => {
    show()
    await finish(await begin(), 200, DATA_A)
    await expectDownload(JSON_A)
    expect(requests).toHaveLength(1)
    expect(notifications.error).not.toHaveBeenCalled()
  })
  it('visar aktuellt GET-fel; först ett uttryckligt nytt klick hämtar filen', async () => {
    show()
    await finish(await begin(), 500, 'Exporten kunde inte hämtas')
    expect(notifications.error).toHaveBeenCalledTimes(1)
    expect(notifications.error).toHaveBeenCalledWith('Exporten kunde inte hämtas')
    expect(create).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Ladda ner' })).toBeEnabled()
    await finish(await begin(), 200, DATA_A)
    await expectDownload(JSON_A)
    expect(requests).toHaveLength(2)
    expect(notifications.error).toHaveBeenCalledTimes(1)
  })
  it.each([200, 401])(
    'A:s sena %s efter kontobyte skapar ingen fil/feltoast; B kan exportera',
    async (status) => {
      show()
      const old = await begin()
      act(() => signIn('b'))
      const current = await begin('b')
      await finish(old, status, status === 200 ? DATA_A : 'PRIVATE_OLD_EXPORT_ERROR')
      expectNoDownload()
      expectB()
      expect(screen.getByRole('button', { name: 'Hämtar…' })).toBeDisabled()
      await finish(current, 200, DATA_B)
      await expectDownload(JSON_B)
      expectB()
      expect(requests).toHaveLength(2)
    },
  )
  it('byter session efter Axios kontroll men före sidans await; gamla filen stoppas ändå', async () => {
    show()
    let switches = 0
    interceptors.push(
      portalApi.interceptors.response.use((response) => {
        if (
          response.config.headers.Authorization === 'Bearer synthetic-export-a' &&
          switches === 0
        ) {
          switches += 1
          signIn('b')
        }
        return response
      }),
    )
    await finish(await begin(), 200, DATA_A)
    expect(switches).toBe(1)
    expectNoDownload()
    expectB()
    await finish(await begin('b'), 200, DATA_B)
    await expectDownload(JSON_B)
    expectB()
    expect(requests).toHaveLength(2)
  })
})
