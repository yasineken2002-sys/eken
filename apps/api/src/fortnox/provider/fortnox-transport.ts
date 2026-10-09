import { FORTNOX_MIN_429_BACKOFF_MS, systemFortnoxClock } from './fortnox-rate-limiter'
import { parseFortnoxRetryAfter } from './fortnox-retry-after'
import { prepareFortnoxRequest } from './fortnox-transport.routes'
import { FortnoxTransportError, type FortnoxRejectionDetail } from './fortnox-transport.types'
import type {
  FortnoxClock,
  FortnoxFailureCode,
  FortnoxRateLimiter,
  FortnoxTransportOptions,
  FortnoxTransportRequest,
  FortnoxTransportResult,
} from './fortnox-transport.types'

/** No OAuth, logging, environment access or financial idempotency in this layer. */
export class FortnoxTransport {
  private readonly clock: FortnoxClock
  private readonly limiter: FortnoxRateLimiter
  private readonly timeoutMs: number
  private readonly maxReadAttempts: number
  private readonly fetch: typeof globalThis.fetch
  private readonly allowVoucherWrites: boolean

  constructor(options: FortnoxTransportOptions) {
    this.fetch = options.fetch
    this.allowVoucherWrites = options.allowVoucherWrites === true
    this.clock = options.clock ?? systemFortnoxClock
    // TESTKUND-035 P3-A1: ingen processlokal standard; produkten skickar den delade begränsaren.
    this.limiter = options.rateLimiter as FortnoxRateLimiter
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxReadAttempts = options.maxReadAttempts ?? 3
    if (
      typeof options.fetch !== 'function' ||
      !options.rateLimiter ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000 ||
      !Number.isInteger(this.maxReadAttempts) ||
      this.maxReadAttempts < 1 ||
      this.maxReadAttempts > 3
    ) {
      throw new FortnoxTransportError('INVALID_REQUEST', 'not_sent', 0)
    }
  }

  async request<T = unknown>(request: FortnoxTransportRequest): Promise<FortnoxTransportResult<T>> {
    const prepared = prepareFortnoxRequest(request, this.allowVoucherWrites)
    const { method, accessToken, rateLimitKey, signal } = prepared
    const controller = new AbortController()
    const deadline = this.clock.now() + this.timeoutMs
    let attempts = 0
    let timedOut = false
    const failure = (code: FortnoxFailureCode) =>
      new FortnoxTransportError(
        code,
        attempts === 0 ? 'not_sent' : method === 'POST' ? 'unknown' : 'read_failed',
        attempts,
      )
    const abort = () => controller.abort()
    if (signal) {
      EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true })
      if (Reflect.get(AbortSignal.prototype, 'aborted', signal)) controller.abort()
    }
    const cancelTimer = this.clock.schedule(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    let removeAbortListener = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(failure(timedOut ? 'TIMEOUT' : 'CANCELLED'))
      removeAbortListener = () => controller.signal.removeEventListener('abort', rejectAbort)
      if (controller.signal.aborted) rejectAbort()
      else controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const ensureActive = () => {
      if (controller.signal.aborted) throw failure(timedOut ? 'TIMEOUT' : 'CANCELLED')
      if (this.clock.now() >= deadline) {
        timedOut = true
        controller.abort()
        throw failure('TIMEOUT')
      }
    }
    const perform = async (): Promise<FortnoxTransportResult<T>> => {
      for (;;) {
        ensureActive()
        try {
          await this.limiter.acquire(rateLimitKey, controller.signal)
        } catch {
          ensureActive()
          throw failure('RATE_LIMIT_ERROR')
        }
        ensureActive()
        let response: Response
        try {
          attempts += 1
          response = await this.fetch(prepared.url, {
            method: method,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(prepared.body === undefined ? {} : { body: prepared.body }),
            signal: controller.signal,
            redirect: 'error',
          })
        } catch {
          ensureActive()
          // Network failures cannot prove whether a write reached Fortnox. Never retry them.
          throw failure('NETWORK_ERROR')
        }
        ensureActive()
        let status: number
        let retryAfter: string | null
        try {
          // Metadata is read once and checked before comparisons or issuing a receipt.
          status = response.status
          const redirected = response.redirected
          const responseUrl = response.url
          if (
            !Number.isInteger(status) ||
            status < 100 ||
            status > 599 ||
            typeof redirected !== 'boolean' ||
            redirected ||
            typeof responseUrl !== 'string' ||
            (responseUrl !== '' && responseUrl !== prepared.url)
          )
            throw new Error('Invalid metadata')
          retryAfter = response.headers.get('retry-after')
          if (retryAfter !== null && typeof retryAfter !== 'string')
            throw new Error('Invalid metadata')
        } catch {
          throw failure('INVALID_RESPONSE')
        }
        const retryAfterMs = parseFortnoxRetryAfter(retryAfter, this.clock.now())
        const retryableStatus = status === 429 || (status >= 500 && status <= 599)
        if (retryableStatus) {
          // TESTKUND-035 P3-A6: 429 utan giltigt (positivt) Retry-After spärrar minst 5 s.
          const delay =
            status === 429
              ? retryAfterMs !== undefined && retryAfterMs > 0
                ? retryAfterMs
                : FORTNOX_MIN_429_BACKOFF_MS
              : (retryAfterMs ?? 500 * 2 ** (attempts - 1))
          let deferred = true
          try {
            await this.limiter.defer(rateLimitKey, delay)
          } catch {
            deferred = false
          }
          if (method === 'POST' && status === 429) {
            // TESTKUND-035 P3-B3: en skrivning som fick 429 kan ändå ha skapat posten; utfallet är
            // okänt (aldrig avvisat) och skickas aldrig om, även när spärren inte kunde sparas.
            void response.body?.cancel().catch(() => {})
            throw new FortnoxTransportError(
              'HTTP_ERROR',
              'unknown',
              attempts,
              429,
              delay,
              null,
              !deferred,
            )
          }
          if (!deferred) {
            // T-4: inget omförsök utan delad spärr; en läsning avbryts (read_failed).
            void response.body?.cancel().catch(() => {})
            throw failure('RATE_LIMIT_ERROR')
          }
          if (method === 'GET' && attempts < this.maxReadAttempts) {
            void response.body?.cancel().catch(() => {})
            // Never cap Retry-After and retry earlier than the provider requested.
            if (delay >= deadline - this.clock.now()) {
              throw new FortnoxTransportError(
                'RETRY_DEFERRED',
                'read_failed',
                attempts,
                status,
                delay,
              )
            }
            await this.clock.sleep(delay, controller.signal)
            continue
          }
        }
        if (status < 200 || status >= 300) {
          const outcome =
            method === 'GET'
              ? 'read_failed'
              : status >= 400 && status < 500 && status !== 408
                ? 'rejected'
                : 'unknown'
          // TESTKUND-016 K3.1: en avvisad skrivning bär Fortnox egen felkod; den läses begränsat
          // (högst 4 KB) så att avvisningsbeviset kan sparas. Allt annat avbryts som tidigare.
          const rejection = outcome === 'rejected' ? await readRejection(response) : null
          if (outcome !== 'rejected') void response.body?.cancel().catch(() => {})
          throw new FortnoxTransportError(
            'HTTP_ERROR',
            outcome,
            attempts,
            status,
            retryAfterMs,
            rejection,
          )
        }
        let data: unknown
        try {
          data = await response.json()
        } catch {
          ensureActive()
          throw failure('INVALID_RESPONSE')
        }
        ensureActive()
        if (
          data === null ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          'ErrorInformation' in data
        ) {
          throw failure('INVALID_RESPONSE')
        }
        return { data: data as T, status: status, attempts }
      }
    }
    try {
      // Bounded even when an injected fetch/limiter/body reader ignores AbortSignal.
      return await Promise.race([cancelled, perform()])
    } catch (error) {
      if (error instanceof FortnoxTransportError) throw error
      ensureActive()
      throw failure('NETWORK_ERROR')
    } finally {
      cancelTimer()
      removeAbortListener()
      if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
      controller.abort()
    }
  }
}

const REJECTION_MAX_BYTES = 4096

/** Läser högst 4 KB av ett avvisningssvar; ErrorInformation.code/message eller null. Kastar aldrig. */
async function readRejection(response: Response): Promise<FortnoxRejectionDetail> {
  const none: FortnoxRejectionDetail = { code: null, message: null }
  try {
    const reader = response.body?.getReader()
    if (!reader) return none
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
      if (size > REJECTION_MAX_BYTES) {
        void reader.cancel().catch(() => {})
        return none
      }
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    const info =
      body && typeof body === 'object'
        ? ((body as Record<string, unknown>).ErrorInformation as
            | Record<string, unknown>
            | undefined)
        : undefined
    if (!info || typeof info !== 'object') return none
    const raw = info.code ?? info.Code
    const code =
      typeof raw === 'number' && Number.isSafeInteger(raw)
        ? raw
        : typeof raw === 'string' && /^\d{1,10}$/.test(raw)
          ? Number(raw)
          : null
    const msg = info.message ?? info.Message
    return { code, message: typeof msg === 'string' ? msg.slice(0, 500) : null }
  } catch {
    return none
  }
}
