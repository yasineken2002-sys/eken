import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { downloadInspectionPdf, downloadRentNoticePdf, portalApi } from '@/api/portal.api'
import { SessionChangedError } from '@/lib/session-guard'
import { useSessionStore } from '@/store/session.store'
import type { PortalSessionTenant } from '@/types/portal.types'

// Riktiga download-hjälpare, Axios-interceptorer och sessionsgenerationer.
// Endast transportens leveranstid/svar och webbläsarens download-gräns ersätts.
const A: PortalSessionTenant = {
  id: '51000000-0000-4000-8000-000000000001',
  firstName: 'Syntetisk A',
  email: 'download-a@example.invalid',
}
const B: PortalSessionTenant = {
  id: '51000000-0000-4000-8000-000000000002',
  firstName: 'Syntetisk B',
  email: 'download-b@example.invalid',
}
const PRIVATE_A = 'PRIVATE_A_PDF_RESPONSE_MUST_NOT_ESCAPE'
const BLOB_URL = 'blob:synthetic-portal-download'
const helpers = [
  {
    name: 'hyresavi',
    run: () => downloadRentNoticePdf('notice-synthetic', 'AVI-2026-07'),
    path: '/portal/rent-notices/notice-synthetic/download',
    filename: 'hyresavi-AVI-2026-07.pdf',
  },
  {
    name: 'besiktningsprotokoll',
    run: () => downloadInspectionPdf('inspection-synthetic', 7),
    path: '/portal/inspections/inspection-synthetic/pdf',
    filename: 'besiktningsprotokoll-v7.pdf',
  },
] as const

type Outcome = { status: 'fulfilled' } | { status: 'rejected'; error: unknown }
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
  succeed: (blob: Blob) => void
  fail: () => void
  finishForCleanup: () => void
}
const requests: Request[] = []
const operations: Promise<Outcome>[] = []
const interceptors: number[] = []
let announce: ((request: Request) => void) | undefined
const originalAdapter = portalApi.defaults.adapter
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
const createObjectURL = vi.fn((_blob: Blob) => BLOB_URL)
const revokeObjectURL = vi.fn((_url: string) => undefined)
const clicked: { href: string; filename: string; connected: boolean }[] = []
const click = vi.fn(function (this: HTMLAnchorElement) {
  clicked.push({ href: this.href, filename: this.download, connected: this.isConnected })
})

const adapter: AxiosAdapter = (config) => {
  const result = deferred<AxiosResponse>()
  const response = (data: unknown, status = 200): AxiosResponse => ({
    config,
    data,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: {},
  })
  const request: Request = {
    config,
    succeed: (blob) => result.resolve(response(blob)),
    fail: () => {
      const error = new AxiosError(
        PRIVATE_A,
        'ERR_BAD_RESPONSE',
        config,
        { privateRequest: PRIVATE_A },
        response({ error: { message: PRIVATE_A } }, 401),
      )
      error.cause = new Error(PRIVATE_A)
      result.reject(error)
    },
    finishForCleanup: () => result.reject(new Error('Syntetisk transport avslutad')),
  }
  requests.push(request)
  const observer = announce
  announce = undefined
  observer?.(request)
  // Avsluta inte automatiskt vid sessionsbyte: ett sent svar ska gå genom
  // riktiga Axios och hela hjälparens fortsättning, inte försvinna i adaptern.
  return result.promise
}

function signIn(tenant: PortalSessionTenant, token: string) {
  useSessionStore
    .getState()
    .setSession(token, tenant, new Date(Date.now() + 3_600_000).toISOString())
}
function begin(run: () => Promise<void>) {
  const arrived = deferred<Request>()
  announce = arrived.resolve
  // Rejection-handler installeras omedelbart, före testets sessionsbyte.
  const outcome = run().then<Outcome, Outcome>(
    () => ({ status: 'fulfilled' }),
    (error: unknown) => ({ status: 'rejected', error }),
  )
  operations.push(outcome)
  return { request: arrived.promise, outcome }
}
function expectRequest(request: Request, path: string, token: string) {
  expect(request.config.method).toBe('get')
  expect(request.config.url).toBe(path)
  expect(request.config.responseType).toBe('blob')
  expect(request.config.headers.Authorization).toBe(`Bearer ${token}`)
}
function expectStale(outcome: Outcome) {
  expect(outcome.status).toBe('rejected')
  if (outcome.status !== 'rejected') throw new Error('Gammal download lyckades oväntat')
  expect(outcome.error).toBeInstanceOf(SessionChangedError)
  expect(outcome.error).toMatchObject({
    name: 'SessionChangedError',
    message: 'Sessionen har ändrats. Svaret används inte.',
  })
  for (const field of ['config', 'request', 'response', 'cause']) {
    expect(outcome.error).not.toHaveProperty(field)
  }
  expect(String(outcome.error)).not.toContain(PRIVATE_A)
  expect(JSON.stringify(outcome.error)).not.toContain(PRIVATE_A)
}
function expectNoDownload() {
  expect(createObjectURL).not.toHaveBeenCalled()
  expect(click).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
  expect(document.querySelector('a[download]')).toBeNull()
}
function restoreUrlMethod(
  name: 'createObjectURL' | 'revokeObjectURL',
  descriptor?: PropertyDescriptor,
) {
  if (descriptor) Object.defineProperty(URL, name, descriptor)
  else Reflect.deleteProperty(URL, name)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  requests.length = 0
  operations.length = 0
  interceptors.length = 0
  clicked.length = 0
  announce = undefined
  localStorage.clear()
  useSessionStore.getState().clearSession()
  portalApi.defaults.adapter = adapter
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click)
})

afterEach(async () => {
  // Även ett avbrutet assertionsflöde gör gamla anrop inaktuella, avslutar
  // transporterna och inväntar HELA download-livstiden före mockåterställning.
  useSessionStore.getState().clearSession()
  for (const request of requests) request.finishForCleanup()
  try {
    await Promise.all(operations)
    vi.runOnlyPendingTimers()
  } finally {
    for (const id of interceptors) portalApi.interceptors.response.eject(id)
    if (originalAdapter === undefined) delete portalApi.defaults.adapter
    else portalApi.defaults.adapter = originalAdapter
    restoreUrlMethod('createObjectURL', originalCreate)
    restoreUrlMethod('revokeObjectURL', originalRevoke)
    vi.restoreAllMocks()
    vi.useRealTimers()
    useSessionStore.getState().clearSession()
    localStorage.clear()
    document.querySelectorAll('a[download]').forEach((element) => element.remove())
  }
})

describe.each(helpers)('$name: PDF-download över sessionsgränsen', ({ run, path, filename }) => {
  it('använder inte A:s sena blob efter logout; en uttrycklig B-download fungerar', async () => {
    signIn(A, 'synthetic-token-a')
    const old = begin(run)
    const oldRequest = await old.request
    expectRequest(oldRequest, path, 'synthetic-token-a')
    useSessionStore.getState().clearSession()
    oldRequest.succeed(new Blob([PRIVATE_A], { type: 'application/pdf' }))
    expectStale(await old.outcome)
    expectNoDownload()

    signIn(B, 'synthetic-token-b')
    const current = begin(run)
    const currentRequest = await current.request
    expectRequest(currentRequest, path, 'synthetic-token-b')
    const bBlob = new Blob(['%PDF-SYNTHETIC-B'], { type: 'application/pdf' })
    currentRequest.succeed(bBlob)
    expect(await current.outcome).toEqual({ status: 'fulfilled' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledWith(bBlob)
    expect(click).toHaveBeenCalledTimes(1)
    expect(clicked).toEqual([{ href: BLOB_URL, filename, connected: true }])
    expect(document.querySelector('a[download]')).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(BLOB_URL)
    expect(requests).toHaveLength(2)
  })

  it('avvisar A:s sena 401 utan rått fel eller utloggning av B', async () => {
    signIn(A, 'synthetic-token-a')
    const old = begin(run)
    const request = await old.request
    expectRequest(request, path, 'synthetic-token-a')
    signIn(B, 'synthetic-token-b')
    request.fail()
    expectStale(await old.outcome)
    expectNoDownload()
    expect(useSessionStore.getState()).toMatchObject({
      sessionToken: 'synthetic-token-b',
      tenant: { id: B.id },
      isAuthenticated: true,
    })
    expect(requests).toHaveLength(1)
  })

  it('stoppar också A när kontot byts efter Axios sessionsinterceptor före hjälparens await-fortsättning', async () => {
    signIn(A, 'synthetic-token-a')
    let passed = 0
    let tokenBeforeSwitch: string | null = null
    // Axios kör response-interceptorer i registreringsordning. Detta är ett
    // riktigt tillägg EFTER produktens assertCurrentRequest, inte en ersättning.
    // Kontobytet sker sedan innan downloadPdfBlob får sitt await-resultat.
    interceptors.push(
      portalApi.interceptors.response.use((response) => {
        passed++
        tokenBeforeSwitch = useSessionStore.getState().sessionToken
        signIn(B, 'synthetic-token-b')
        return response
      }),
    )
    const old = begin(run)
    const request = await old.request
    expectRequest(request, path, 'synthetic-token-a')
    request.succeed(new Blob([PRIVATE_A], { type: 'application/pdf' }))
    expectStale(await old.outcome)
    expect(passed).toBe(1)
    expect(tokenBeforeSwitch).toBe('synthetic-token-a')
    expectNoDownload()
    expect(useSessionStore.getState().tenant?.id).toBe(B.id)
    expect(requests).toHaveLength(1)
  })
})
