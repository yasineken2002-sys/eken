/** Trusted server-side input only. Tokens come from the org-bound OAuth provider. */
export interface FortnoxTransportRequest {
  accessToken: string
  /** Stable client-id + verified Fortnox tenant identity, never the token itself. */
  rateLimitKey: string
  method: 'GET' | 'POST'
  /** Canonical relative path, e.g. /3/vouchers/A/123. URLs are never accepted. */
  path: string
  query?: Readonly<Record<string, string | number | boolean>>
  body?: unknown
  signal?: AbortSignal
}

export interface FortnoxTransportResult<T> {
  /** Still untrusted provider data: validate the resource schema in the caller. */
  data: T
  status: number
  attempts: number
}

export interface FortnoxClock {
  now(): number
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
  /** Returns a function cancelling the timer. */
  schedule(callback: () => void, milliseconds: number): () => void
}

/** Share across all transports for a client/tenant. Multi-process hosts need a shared backend. */
export interface FortnoxRateLimiter {
  acquire(key: string, signal: AbortSignal): Promise<void>
  defer(key: string, untilMs: number): void
}

export interface FortnoxTransportOptions {
  /** Deliberately required: constructing this class never opts into real networking. */
  fetch: typeof globalThis.fetch
  clock?: FortnoxClock
  rateLimiter?: FortnoxRateLimiter
  /** Total deadline including limiter, retries, fetch and response body. Default 30s. */
  timeoutMs?: number
  /** Inclusive of the first attempt. Default 3, maximum 3. GET only. */
  maxReadAttempts?: number
  /** Explicit capability; false by default. Only POST /3/vouchers can be enabled. */
  allowVoucherWrites?: boolean
}

export type FortnoxFailureCode =
  | 'INVALID_REQUEST'
  | 'WRITE_DISABLED'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'RETRY_DEFERRED'
  | 'RATE_LIMIT_ERROR'

export type FortnoxOutcome = 'not_sent' | 'read_failed' | 'rejected' | 'unknown'

/** Contains no token, URL, response body, upstream message or original error cause. */
export class FortnoxTransportError extends Error {
  readonly reconciliationRequired: boolean

  constructor(
    readonly code: FortnoxFailureCode,
    readonly outcome: FortnoxOutcome,
    readonly attempts: number,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Fortnox transport: ${code}`)
    this.name = 'FortnoxTransportError'
    this.reconciliationRequired = outcome === 'unknown'
  }
}
