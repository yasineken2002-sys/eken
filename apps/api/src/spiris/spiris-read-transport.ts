/** Fixed-host, read-only HTTP boundary. No credential storage, refresh, company
 * authorization, provider activation, retries or pagination inference.
 * 10 seconds TOTAL and 2 MiB of actual body bytes are Eveno limits, not upstream
 * promises. UTF-8 must be valid. A dependency that ignores abort may continue
 * working; its late result cannot succeed here. Synchronous injected code or
 * JSON parsing cannot be preempted: the monotonic deadline is checked afterwards.
 */
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamReadResult,
} from 'node:stream/web'
import { types } from 'node:util'
import {
  describeAccountsForYear,
  describeCompanySettings,
  describeFiscalYears,
  parseAccountsPage,
  parseCompanySettings,
  parseFiscalYearsPage,
  SpirisReadContractError,
} from './spiris-read-contract'
import type {
  SpirisAccount,
  SpirisCompanySettings,
  SpirisFiscalYear,
  SpirisGetDescriptor,
  SpirisPage,
  SpirisReadErrorCode,
} from './spiris-read-contract'

export const SPIRIS_READ_TIMEOUT_MS = 10_000
export const SPIRIS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const ORIGIN = 'https://eaccountingapi.vismaonline.com'

export type SpirisReadTransportErrorCode =
  | SpirisReadErrorCode
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RESPONSE_TOO_LARGE'

export class SpirisReadTransportError extends Error {
  constructor(
    readonly code: SpirisReadTransportErrorCode,
    readonly httpStatus: number | null,
  ) {
    super(`Spiris read transport: ${code}`)
    this.name = 'SpirisReadTransportError'
  }
}

export type SpirisReadFetch = (url: string, init: RequestInit) => Promise<Response>
/** Trusted dependency seam; now must be monotonic and schedule must be asynchronous. */
export type SpirisReadClock = Readonly<{
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
}>
export type SpirisReadTransportOptions = Readonly<{
  fetch: SpirisReadFetch
  clock?: SpirisReadClock
}>

const defaultClock: SpirisReadClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

function error(code: SpirisReadTransportErrorCode, httpStatus: number | null = null) {
  return new SpirisReadTransportError(code, httpStatus)
}
/** Only used around trusted builders/parsers, never around fetch/stream errors. */
function contract<T>(work: () => T, fallback: SpirisReadErrorCode): T {
  try {
    return work()
  } catch (cause) {
    if (cause instanceof SpirisReadContractError) throw error(cause.code, cause.httpStatus)
    throw error(fallback, fallback === 'INVALID_RESPONSE' ? 200 : null)
  }
}
function bearer(value: unknown): string {
  if (typeof value !== 'string') throw error('INVALID_REQUEST')
  const match = /^[A-Za-z0-9._~+/-]+=*$/.exec(value)
  if (!match || match[0] !== value) throw error('INVALID_REQUEST')
  return value
}
function aborted(signal: AbortSignal): boolean {
  // Native brand check; do not read an own getter or propagate a caller reason.
  try {
    return Reflect.get(AbortSignal.prototype, 'aborted', signal) === true
  } catch {
    throw error('INVALID_REQUEST')
  }
}
function discard(work: () => unknown): void {
  try {
    void Promise.resolve(work()).catch(() => undefined)
  } catch {
    // Cleanup cannot replace the fixed primary outcome or wait indefinitely.
  }
}
function urlFor(descriptor: SpirisGetDescriptor): string {
  const url = new URL(`/v2${descriptor.path}`, ORIGIN)
  if ('query' in descriptor) {
    url.searchParams.set('$page', String(descriptor.query.$page))
    url.searchParams.set('$pagesize', String(descriptor.query.$pagesize))
  }
  return url.href
}

export class SpirisReadTransport {
  private readonly fetch: SpirisReadFetch
  private readonly clock: SpirisReadClock

  constructor(options: SpirisReadTransportOptions) {
    this.fetch = options.fetch
    this.clock = options.clock ?? defaultClock
  }

  async readCompanySettings(
    accessToken: unknown,
    signal?: AbortSignal,
  ): Promise<SpirisCompanySettings> {
    const descriptor = describeCompanySettings()
    return this.request(descriptor, accessToken, signal, (body) => parseCompanySettings(200, body))
  }

  async readFiscalYears(
    accessToken: unknown,
    request?: unknown,
    signal?: AbortSignal,
  ): Promise<SpirisPage<SpirisFiscalYear>> {
    const descriptor = contract(() => describeFiscalYears(request), 'INVALID_REQUEST')
    const page = Object.freeze({
      page: descriptor.query.$page,
      pageSize: descriptor.query.$pagesize,
    })
    return this.request(descriptor, accessToken, signal, (body) =>
      parseFiscalYearsPage(200, body, page),
    )
  }

  async readAccountsForYear(
    accessToken: unknown,
    fiscalYearId: unknown,
    request?: unknown,
    signal?: AbortSignal,
  ): Promise<SpirisPage<SpirisAccount>> {
    const descriptor = contract(
      () => describeAccountsForYear(fiscalYearId, request),
      'INVALID_REQUEST',
    )
    const year = descriptor.path.slice('/accounts/'.length)
    const page = Object.freeze({
      page: descriptor.query.$page,
      pageSize: descriptor.query.$pagesize,
    })
    return this.request(descriptor, accessToken, signal, (body) =>
      parseAccountsPage(200, body, year, page),
    )
  }

  private async request<T>(
    descriptor: SpirisGetDescriptor,
    accessToken: unknown,
    signal: AbortSignal | undefined,
    project: (body: unknown) => T,
  ): Promise<T> {
    // Every caller-controlled input used after await is now a primitive or private snapshot.
    const token = bearer(accessToken)
    if (signal !== undefined && aborted(signal)) throw error('CANCELLED')
    const url = urlFor(descriptor)
    const deadline = this.clock.now() + SPIRIS_READ_TIMEOUT_MS
    const controller = new AbortController()
    let stopped: SpirisReadTransportError | undefined
    let finished = false
    let body: ReadableStream<Uint8Array> | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let rejectStop: (reason: SpirisReadTransportError) => void = () => undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectStop = reject
    })
    const disposeBody = () => {
      const oldReader = reader
      const oldBody = body
      reader = undefined
      body = null
      if (oldReader) {
        discard(() => oldReader.cancel())
        try {
          oldReader.releaseLock()
        } catch {
          /* A pending native read may reject on release. */
        }
      } else if (oldBody) discard(() => oldBody.cancel())
    }
    const stop = (code: 'CANCELLED' | 'TIMEOUT') => {
      if (stopped || finished) return
      stopped = error(code)
      controller.abort()
      rejectStop(stopped)
    }
    const ensureActive = () => {
      if (!stopped && this.clock.now() >= deadline) stop('TIMEOUT')
      if (stopped) throw stopped
      if (finished) throw error('CANCELLED')
    }
    const onAbort = () => stop('CANCELLED')
    const cancelTimer = this.clock.schedule(() => stop('TIMEOUT'), SPIRIS_READ_TIMEOUT_MS)
    if (signal !== undefined)
      EventTarget.prototype.addEventListener.call(signal, 'abort', onAbort, { once: true })

    const perform = async (): Promise<T> => {
      try {
        ensureActive()
        let response: Response
        try {
          response = await this.fetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            redirect: 'error',
            signal: controller.signal,
          })
        } catch {
          ensureActive()
          throw error('NETWORK_ERROR')
        }
        let status: number
        let responseUrl: string
        let redirected: boolean
        try {
          // Acquire the body even after a late fetch, so finally can cancel it.
          body = response.body
          status = response.status
          responseUrl = response.url
          redirected = response.redirected
        } catch {
          ensureActive()
          throw error('INVALID_RESPONSE')
        }
        ensureActive()
        if (!Number.isInteger(status) || status < 100 || status > 599)
          throw error('INVALID_HTTP_STATUS')
        if (responseUrl !== url || redirected !== false) throw error('INVALID_RESPONSE', status)
        if (status !== 200) throw error('HTTP_ERROR', status)
        if (!body) throw error('INVALID_RESPONSE', status)
        try {
          reader = body.getReader()
        } catch {
          throw error('INVALID_RESPONSE', status)
        }
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0
        let text = ''
        for (;;) {
          ensureActive()
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch {
            ensureActive()
            throw error('INVALID_RESPONSE', status)
          }
          ensureActive()
          if (chunk.done) break
          if (!types.isUint8Array(chunk.value)) throw error('INVALID_RESPONSE', status)
          bytes += chunk.value.byteLength
          if (bytes > SPIRIS_MAX_RESPONSE_BYTES) throw error('RESPONSE_TOO_LARGE', status)
          try {
            text += decoder.decode(chunk.value, { stream: true })
          } catch {
            throw error('INVALID_RESPONSE', status)
          }
        }
        let decoded: unknown
        try {
          decoded = JSON.parse(text + decoder.decode())
        } catch {
          ensureActive()
          throw error('INVALID_RESPONSE', status)
        }
        ensureActive()
        const result = contract(() => project(decoded), 'INVALID_RESPONSE')
        ensureActive()
        return result
      } finally {
        // Also runs when a signal-ignoring fetch eventually produces a late body.
        disposeBody()
      }
    }
    try {
      // Both promises retain rejection handlers even after the other branch wins.
      return await Promise.race([perform(), cancellation])
    } finally {
      finished = true
      cancelTimer()
      if (signal !== undefined)
        EventTarget.prototype.removeEventListener.call(signal, 'abort', onAbort)
      controller.abort()
      disposeBody()
    }
  }
}
