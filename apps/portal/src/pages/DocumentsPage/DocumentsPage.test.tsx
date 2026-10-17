import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import type { PortalDocument, PortalSessionTenant } from '@/types/portal.types'
import { DocumentsPage } from './DocumentsPage'

const notifications = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: notifications }))

// Ingen mock av sidan, API-hjälparna, nedladdningshjälparen eller sessionsskyddet.
const A: PortalSessionTenant = {
  id: '52000000-0000-4000-8000-000000000001',
  email: 'documents-a@example.invalid',
  firstName: 'Syntetisk A',
}
const B: PortalSessionTenant = {
  id: '52000000-0000-4000-8000-000000000002',
  email: 'documents-b@example.invalid',
  firstName: 'Syntetisk B',
}
const DOC_A: PortalDocument = {
  id: 'document-a',
  name: 'A:s hyresavtal.pdf',
  description: null,
  mimeType: 'application/pdf',
  fileSize: 1234,
  category: 'LEASE',
  createdAt: '2026-01-01T12:00:00.000Z',
}
const DOC_B: PortalDocument = { ...DOC_A, id: 'document-b', name: 'B:s hyresavtal.pdf' }
const PRIVATE_A = 'PRIVATE_A_SIGNED_LINK_OR_ERROR'
const URL_A = `https://synthetic-download.invalid/a.pdf?signature=${PRIVATE_A}`
const URL_B = 'https://synthetic-download.invalid/b.pdf?signature=synthetic-b'
const FILE_B = '  B:/hyresavtal?.pdf  '
const PATH_A = '/portal/documents/document-a/download'
const PATH_B = '/portal/documents/document-b/download'
const clients = new Set<QueryClient>()
const interceptors: number[] = []
const calls: InternalAxiosRequestConfig[] = []
const downloads: PendingDownload[] = []
const originalAdapter = portalApi.defaults.adapter
const clicked: {
  url: string
  filename: string
  target: string
  rel: string
  connected: boolean
}[] = []
const click = vi.fn(function (this: HTMLAnchorElement) {
  clicked.push({
    url: this.href,
    filename: this.download,
    target: this.target,
    rel: this.rel,
    connected: this.isConnected,
  })
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
interface PendingDownload {
  config: InternalAxiosRequestConfig
  settled: Promise<void>
  succeed: (url: string, filename: string) => void
  fail: (status: number, message: string) => void
  finishForCleanup: () => void
}
const adapter: AxiosAdapter = (config) => {
  calls.push(config)
  const response = (data: unknown, status = 200): AxiosResponse => ({
    config,
    status,
    statusText: String(status),
    headers: {},
    data,
  })
  if (config.url === '/portal/documents') {
    const token = config.headers.Authorization
    if (token !== 'Bearer synthetic-token-a' && token !== 'Bearer synthetic-token-b') {
      return Promise.reject(new Error('Oväntad syntetisk listsessionsägare'))
    }
    return Promise.resolve(
      response({ success: true, data: [token.endsWith('-a') ? DOC_A : DOC_B] }),
    )
  }
  if (config.url !== PATH_A && config.url !== PATH_B) {
    return Promise.reject(new Error('Oväntad syntetisk dokumentväg'))
  }
  const result = deferred<AxiosResponse>()
  downloads.push({
    config,
    // Handlers direkt: även teardown får avsluta ett väntande fel säkert.
    settled: result.promise.then(
      () => undefined,
      () => undefined,
    ),
    succeed: (url, filename) =>
      result.resolve(
        response({
          success: true,
          data: { url, filename, mimeType: 'application/pdf' },
        }),
      ),
    fail: (status, message) => {
      const error = new AxiosError(
        message,
        'ERR_BAD_RESPONSE',
        config,
        { privateRequest: PRIVATE_A },
        response({ success: false, error: { message } }, status),
      )
      error.cause = new Error(PRIVATE_A)
      result.reject(error)
    },
    finishForCleanup: () => result.reject(new Error('Syntetisk downloadtransport avslutad')),
  })
  // Inget artificiellt abortstopp: sena svar når riktiga Axios och sidan.
  return result.promise
}

function signIn(tenant: PortalSessionTenant, token: string) {
  useSessionStore
    .getState()
    .setSession(token, tenant, new Date(Date.now() + 3_600_000).toISOString())
}
function VisiblePage() {
  const client = useQueryClient()
  const authenticated = useSessionStore((state) => state.isAuthenticated)
  useEffect(() => {
    clients.add(client)
  }, [client])
  return authenticated ? <DocumentsPage /> : <p>Utloggad i testet</p>
}
async function show(tenant: PortalSessionTenant = A, token = 'synthetic-token-a') {
  signIn(tenant, token)
  render(
    <SessionBoundary>
      <VisiblePage />
    </SessionBoundary>,
  )
  await screen.findByText(tenant.id === A.id ? DOC_A.name : DOC_B.name)
  expect(screen.getByRole('button', { name: 'Ladda ned' })).toBeEnabled()
}
async function beginDownload(path: string, token: string) {
  const before = downloads.length
  fireEvent.click(screen.getByRole('button', { name: 'Ladda ned' }))
  expect(screen.getByRole('button', { name: 'Laddar...' })).toBeDisabled()
  await waitFor(() => expect(downloads).toHaveLength(before + 1))
  const request = downloads[before]!
  expect(request.config.method).toBe('get')
  expect(request.config.url).toBe(path)
  expect(request.config.headers.Authorization).toBe(`Bearer ${token}`)
  return request
}

// Inte en godtycklig sömn: nästa host-task kommer efter alla redan möjliga
// Promise-jobb. Adapter→Axios→get→handleDownload består här av microtasks;
// efter handlerns enda await är guard/download/toast/finally synkrona.
// Adaptersettlement ENSAM är inte barriären. Framtida timer/I/O-await i handlern
// kräver en ny completionbarriär; detta påstår ingen generell sådan garanti.
const nextHostTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function finish(request: PendingDownload, deliver: () => void) {
  await act(async () => {
    deliver()
    await request.settled
    await nextHostTask()
  })
}
function expectNoOldEffects() {
  expect(click).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
  expect(notifications.error).not.toHaveBeenCalled()
  expect(document.querySelector('a[download]')).toBeNull()
  expect(document.body).not.toHaveTextContent(PRIVATE_A)
}
function expectBDownload() {
  expect(click).toHaveBeenCalledTimes(1)
  expect(clicked).toEqual([
    {
      url: URL_B,
      filename: 'B_hyresavtal_.pdf',
      target: '_blank',
      rel: 'noopener',
      connected: true,
    },
  ])
  expect(document.querySelector('a[download]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Ladda ned' })).toBeEnabled()
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  calls.length = 0
  downloads.length = 0
  clicked.length = 0
  interceptors.length = 0
  clients.clear()
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click)
})
afterEach(async () => {
  try {
    await act(async () => {
      useSessionStore.getState().clearSession()
      cleanup()
      for (const request of downloads) request.finishForCleanup()
      await Promise.all(downloads.map((request) => request.settled))
      await Promise.all([...clients].map((client) => client.cancelQueries()))
      await nextHostTask()
    })
  } finally {
    for (const id of interceptors) portalApi.interceptors.response.eject(id)
    for (const client of clients) client.clear()
    if (originalAdapter === undefined) delete portalApi.defaults.adapter
    else portalApi.defaults.adapter = originalAdapter
    vi.restoreAllMocks()
    useSessionStore.getState().clearSession()
    localStorage.clear()
    document.querySelectorAll('a[download]').forEach((element) => element.remove())
  }
})

describe('DocumentsPage: signerade länkar och sessionens livstid', () => {
  it('öppnar inte A:s sena signerade URL efter logout', async () => {
    await show()
    const old = await beginDownload(PATH_A, 'synthetic-token-a')
    act(() => useSessionStore.getState().clearSession())
    expect(screen.getByText('Utloggad i testet')).toBeInTheDocument()
    await finish(old, () => old.succeed(URL_A, 'A-hemligt.pdf'))
    expectNoOldEffects()
    expect(useSessionStore.getState().isAuthenticated).toBe(false)
    expect(downloads).toHaveLength(1)
  })

  it('ignorerar A efter kontobyte och öppnar B:s URL med verkligt sanerat filnamn', async () => {
    await show()
    const old = await beginDownload(PATH_A, 'synthetic-token-a')
    act(() => signIn(B, 'synthetic-token-b'))
    await screen.findByText(DOC_B.name)
    expect(screen.queryByText(DOC_A.name)).not.toBeInTheDocument()
    await finish(old, () => old.succeed(URL_A, 'A-hemligt.pdf'))
    expectNoOldEffects()

    const current = await beginDownload(PATH_B, 'synthetic-token-b')
    await finish(current, () => current.succeed(URL_B, FILE_B))
    expectBDownload()
    expect(notifications.error).not.toHaveBeenCalled()
    expect(downloads).toHaveLength(2)
    expect(
      calls
        .filter((request) => request.url === '/portal/documents')
        .map((request) => request.headers.Authorization),
    ).toEqual(['Bearer synthetic-token-a', 'Bearer synthetic-token-b'])
  })

  it('visar ingen gammal feltoast och loggar inte ut B vid A:s sena 401', async () => {
    await show()
    const old = await beginDownload(PATH_A, 'synthetic-token-a')
    act(() => signIn(B, 'synthetic-token-b'))
    await screen.findByText(DOC_B.name)
    await finish(old, () => old.fail(401, PRIVATE_A))
    expectNoOldEffects()
    expect(useSessionStore.getState()).toMatchObject({
      sessionToken: 'synthetic-token-b',
      tenant: { id: B.id },
      isAuthenticated: true,
    })
    expect(screen.getByRole('button', { name: 'Ladda ned' })).toBeEnabled()
    expect(downloads).toHaveLength(1)
  })

  it('visar aktuellt serverfel och tillåter en ny uttrycklig nedladdning', async () => {
    await show(B, 'synthetic-token-b')
    const failed = await beginDownload(PATH_B, 'synthetic-token-b')
    await finish(failed, () =>
      failed.fail(500, 'Syntetiskt dokument är tillfälligt otillgängligt.'),
    )
    expect(notifications.error).toHaveBeenCalledTimes(1)
    expect(notifications.error).toHaveBeenCalledWith('Kunde inte ladda ner dokumentet', {
      description: 'Syntetiskt dokument är tillfälligt otillgängligt.',
    })
    expect(click).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Ladda ned' })).toBeEnabled()
    expect(downloads).toHaveLength(1)

    const retry = await beginDownload(PATH_B, 'synthetic-token-b')
    await finish(retry, () => retry.succeed(URL_B, FILE_B))
    expectBDownload()
    expect(notifications.error).toHaveBeenCalledTimes(1)
    expect(downloads).toHaveLength(2)
  })

  it('stoppar länken när A→B sker efter Axios sessionskontroll men före sidans await-fortsättning', async () => {
    await show()
    let passed = 0
    let tokenBeforeSwitch: string | null = null
    // Riktig extra interceptor EFTER produktens, enbart på download-svaret.
    // Detta isolerar sidans egen efter-await-guard från Axios första kontroll.
    interceptors.push(
      portalApi.interceptors.response.use((response) => {
        if (response.config.url === PATH_A) {
          passed++
          tokenBeforeSwitch = useSessionStore.getState().sessionToken
          signIn(B, 'synthetic-token-b')
        }
        return response
      }),
    )
    const old = await beginDownload(PATH_A, 'synthetic-token-a')
    await finish(old, () => old.succeed(URL_A, 'A-hemligt.pdf'))
    expect(passed).toBe(1)
    expect(tokenBeforeSwitch).toBe('synthetic-token-a')
    await screen.findByText(DOC_B.name)
    expectNoOldEffects()
    expect(useSessionStore.getState().tenant?.id).toBe(B.id)
    expect(screen.getByRole('button', { name: 'Ladda ned' })).toBeEnabled()
    expect(downloads).toHaveLength(1)
  })
})
