import { createHash } from 'node:crypto'

const AUTH_URL = 'https://apps.fortnox.se/oauth-v1/auth'
const TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token'
const REVOKE_URL = 'https://apps.fortnox.se/oauth-v1/revoke'
const SCOPES = [
  'companyinformation',
  'bookkeeping',
  'supplierinvoice',
  'supplier',
  'costcenter',
  'project',
  'settings',
] as const
export type FortnoxOAuthScope = (typeof SCOPES)[number]
export type FortnoxOAuthOperation = 'authorize' | 'exchange' | 'refresh' | 'revoke'
export type FortnoxOAuthOutcome = 'not_sent' | 'rejected' | 'unknown'
export type FortnoxOAuthFailure =
  | 'DISABLED'
  | 'INVALID_INPUT'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE'

export class FortnoxOAuthError extends Error {
  readonly requiresRecovery: boolean
  constructor(
    readonly code: FortnoxOAuthFailure,
    readonly operation: FortnoxOAuthOperation,
    readonly outcome: FortnoxOAuthOutcome,
    readonly status?: number,
  ) {
    super(`Fortnox OAuth: ${code}`)
    this.name = 'FortnoxOAuthError'
    this.requiresRecovery = outcome === 'unknown'
  }
}

export interface FortnoxOAuthClock {
  schedule(callback: () => void, milliseconds: number): () => void
}
export interface FortnoxOAuthClientOptions {
  fetch: typeof globalThis.fetch
  clientId: string
  clientSecret: string
  /** Exact URI registered in Fortnox; reused verbatim in auth and exchange. HTTPS only. */
  redirectUri: string
  /** False by default. Factory and per-organization authorization remain caller responsibilities. */
  enabled?: boolean
  timeoutMs?: number
  maxResponseBytes?: number
  clock?: FortnoxOAuthClock
}
export interface FortnoxOAuthTokenSet {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  scopes: string[]
  tokenType: 'bearer'
}
export interface FortnoxOAuthAuthorization {
  state: string
  scopes: readonly FortnoxOAuthScope[]
  codeChallenge: string
}
export interface FortnoxOAuthCode {
  code: string
  /** The verifier stored against the consumed state, not a new verifier. */
  codeVerifier: string
  signal?: AbortSignal
}
export interface FortnoxOAuthRefresh {
  refreshToken: string
  signal?: AbortSignal
}

const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/
const opaque = (value: unknown, max = 8192): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x21-\x7e]+$/.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** C1 still generates/stores the verifier with cryptographic entropy and binds it to state. */
export function fortnoxPkceChallenge(verifier: string): string {
  if (typeof verifier !== 'string' || !verifierPattern.test(verifier)) {
    throw new FortnoxOAuthError('INVALID_INPUT', 'authorize', 'not_sent')
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** HTTP only. No state, DB, environment, refresh scheduling, retries or logging. */
export class FortnoxOAuthClient {
  // Private fields also keep credentials out of JSON.stringify(client) / generic object logging.
  readonly #fetch: typeof globalThis.fetch
  readonly #authorization: string
  readonly #clientId: string
  readonly #redirectUri: string
  readonly #enabled: boolean
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #clock: FortnoxOAuthClock

  constructor(options: FortnoxOAuthClientOptions) {
    try {
      const snapshot = {
        fetch: options.fetch,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        redirectUri: options.redirectUri,
        enabled: options.enabled,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        clock: options.clock,
      }
      const invalid = () => new FortnoxOAuthError('INVALID_INPUT', 'authorize', 'not_sent')
      if (
        typeof snapshot.fetch !== 'function' ||
        !opaque(snapshot.clientId, 256) ||
        snapshot.clientId.includes(':') ||
        !opaque(snapshot.clientSecret, 4096) ||
        !opaque(snapshot.redirectUri, 2048)
      )
        throw invalid()
      let redirect: URL
      try {
        redirect = new URL(snapshot.redirectUri)
      } catch {
        throw invalid()
      }
      if (
        redirect.protocol !== 'https:' ||
        redirect.username ||
        redirect.password ||
        redirect.hash ||
        !snapshot.redirectUri.startsWith('https://')
      )
        throw invalid()
      this.#timeoutMs = snapshot.timeoutMs ?? 10_000
      this.#maxResponseBytes = snapshot.maxResponseBytes ?? 65_536
      if (
        !Number.isInteger(this.#timeoutMs) ||
        this.#timeoutMs < 1 ||
        this.#timeoutMs > 30_000 ||
        !Number.isInteger(this.#maxResponseBytes) ||
        this.#maxResponseBytes < 256 ||
        this.#maxResponseBytes > 65_536
      )
        throw invalid()
      this.#clientId = snapshot.clientId
      this.#authorization = `Basic ${Buffer.from(`${snapshot.clientId}:${snapshot.clientSecret}`, 'utf8').toString('base64')}`
      this.#redirectUri = snapshot.redirectUri
      this.#enabled = snapshot.enabled === true
      this.#fetch = snapshot.fetch
      this.#clock = snapshot.clock ?? {
        schedule: (callback, milliseconds) => {
          const timer = setTimeout(callback, milliseconds)
          return () => clearTimeout(timer)
        },
      }
    } catch {
      throw new FortnoxOAuthError('INVALID_INPUT', 'authorize', 'not_sent')
    }
  }

  authorizationUrl(input: FortnoxOAuthAuthorization): string {
    try {
      const { state, codeChallenge, scopes: sourceScopes } = input
      const scopes = [...sourceScopes]
      const invalid = () => new FortnoxOAuthError('INVALID_INPUT', 'authorize', 'not_sent')
      if (
        !opaque(state, 512) ||
        !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
        !Array.isArray(scopes) ||
        !scopes.includes('companyinformation') ||
        scopes.some((scope) => !SCOPES.includes(scope)) ||
        new Set(scopes).size !== scopes.length
      )
        throw invalid()
      const url = new URL(AUTH_URL)
      url.search = new URLSearchParams({
        client_id: this.#clientId,
        redirect_uri: this.#redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state: state,
        access_type: 'offline',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    } catch {
      throw new FortnoxOAuthError('INVALID_INPUT', 'authorize', 'not_sent')
    }
  }

  async exchangeCode(input: FortnoxOAuthCode): Promise<FortnoxOAuthTokenSet> {
    let body: string
    let signal: AbortSignal | undefined
    try {
      const { code, codeVerifier, signal: sourceSignal } = input
      signal = sourceSignal
      if (!opaque(code) || typeof codeVerifier !== 'string' || !verifierPattern.test(codeVerifier))
        throw new Error('Invalid input')
      if (signal !== undefined) Reflect.get(AbortSignal.prototype, 'aborted', signal)
      body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.#redirectUri,
        code_verifier: codeVerifier,
      }).toString()
    } catch {
      throw new FortnoxOAuthError('INVALID_INPUT', 'exchange', 'not_sent')
    }
    return this.#tokenSet(await this.#post('exchange', TOKEN_URL, body, signal), 'exchange')
  }

  async refresh(input: FortnoxOAuthRefresh): Promise<FortnoxOAuthTokenSet> {
    const { token, signal } = this.#refreshInput(input, 'refresh')
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
    }).toString()
    const result = this.#tokenSet(await this.#post('refresh', TOKEN_URL, body, signal), 'refresh')
    if (result.refreshToken === token)
      throw new FortnoxOAuthError('INVALID_RESPONSE', 'refresh', 'unknown')
    return result
  }

  async revoke(input: FortnoxOAuthRefresh): Promise<{ revoked: true }> {
    const { token, signal } = this.#refreshInput(input, 'revoke')
    const body = new URLSearchParams({ token_type_hint: 'refresh_token', token }).toString()
    const result = await this.#post('revoke', REVOKE_URL, body, signal)
    if (!record(result) || result.revoked !== true || 'error' in result)
      throw new FortnoxOAuthError('INVALID_RESPONSE', 'revoke', 'unknown')
    return { revoked: true }
  }

  #refreshInput(
    input: FortnoxOAuthRefresh,
    operation: 'refresh' | 'revoke',
  ): { token: string; signal: AbortSignal | undefined } {
    try {
      const { refreshToken: token, signal } = input
      if (!opaque(token)) throw new Error('Invalid input')
      if (signal !== undefined) Reflect.get(AbortSignal.prototype, 'aborted', signal)
      return { token, signal }
    } catch {
      throw new FortnoxOAuthError('INVALID_INPUT', operation, 'not_sent')
    }
  }

  #tokenSet(data: unknown, operation: 'exchange' | 'refresh'): FortnoxOAuthTokenSet {
    if (
      !record(data) ||
      !opaque(data.access_token) ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(data.access_token) ||
      !opaque(data.refresh_token) ||
      typeof data.expires_in !== 'number' ||
      !Number.isSafeInteger(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > Number.MAX_SAFE_INTEGER / 1000 ||
      typeof data.scope !== 'string' ||
      !/^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*)*$/.test(data.scope) ||
      data.scope.length > 2048 ||
      typeof data.token_type !== 'string' ||
      data.token_type.toLowerCase() !== 'bearer' ||
      'error' in data
    )
      throw new FortnoxOAuthError('INVALID_RESPONSE', operation, 'unknown')
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresInSeconds: data.expires_in,
      scopes: data.scope.split(' '),
      tokenType: 'bearer',
    }
  }

  async #post(
    operation: 'exchange' | 'refresh' | 'revoke',
    url: typeof TOKEN_URL | typeof REVOKE_URL,
    body: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#enabled) throw new FortnoxOAuthError('DISABLED', operation, 'not_sent')
    if (signal && Reflect.get(AbortSignal.prototype, 'aborted', signal))
      throw new FortnoxOAuthError('CANCELLED', operation, 'not_sent')
    const controller = new AbortController()
    let sent = false
    let cancelBody = () => {}
    let timeout = false
    const ownErrors = new WeakSet<FortnoxOAuthError>()
    const owned = (error: FortnoxOAuthError) => {
      ownErrors.add(error)
      return error
    }
    const failure = (code: FortnoxOAuthFailure, status?: number) =>
      owned(new FortnoxOAuthError(code, operation, sent ? 'unknown' : 'not_sent', status))
    const abort = () => controller.abort()
    if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true })
    const cancelTimer = this.#clock.schedule(() => {
      timeout = true
      controller.abort()
    }, this.#timeoutMs)
    let removeAbort = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(failure(timeout ? 'TIMEOUT' : 'CANCELLED'))
      removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort)
      if (controller.signal.aborted) rejectAbort()
      else controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const ensureActive = () => {
      if (controller.signal.aborted) throw failure(timeout ? 'TIMEOUT' : 'CANCELLED')
    }
    const perform = async (): Promise<unknown> => {
      ensureActive()
      let response: Response
      try {
        sent = true
        response = await this.#fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: this.#authorization,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
        })
      } catch {
        ensureActive()
        throw failure('NETWORK_ERROR')
      }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        ensureActive()
      }
      let status: number
      try {
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
          (responseUrl !== '' && responseUrl !== url)
        )
          throw new Error('Invalid metadata')
      } catch {
        throw failure('INVALID_RESPONSE')
      }
      if (status !== 200) {
        void response.body?.cancel().catch(() => {})
        const rejected = status >= 400 && status < 500 && status !== 408
        throw owned(
          new FortnoxOAuthError('HTTP_ERROR', operation, rejected ? 'rejected' : 'unknown', status),
        )
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (contentType !== 'application/json' || !response.body) {
        void response.body?.cancel().catch(() => {})
        throw failure('INVALID_RESPONSE', status)
      }
      const length = response.headers.get('content-length')
      if (length !== null && /^\d+$/.test(length) && Number(length) > this.#maxResponseBytes) {
        void response.body.cancel().catch(() => {})
        throw failure('RESPONSE_TOO_LARGE', status)
      }
      const reader = response.body.getReader()
      cancelBody = () => {
        void reader.cancel().catch(() => {})
      }
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const next = await reader.read()
          ensureActive()
          if (next.done) break
          total += next.value.byteLength
          if (total > this.#maxResponseBytes) throw failure('RESPONSE_TOO_LARGE', status)
          chunks.push(next.value)
        }
        const bytes = Buffer.concat(chunks, total)
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch (error) {
        void reader.cancel().catch(() => {})
        if (error instanceof FortnoxOAuthError && ownErrors.has(error)) throw error
        ensureActive()
        throw failure('INVALID_RESPONSE', status)
      } finally {
        reader.releaseLock()
      }
    }
    try {
      return await Promise.race([cancelled, perform()])
    } catch (error) {
      if (error instanceof FortnoxOAuthError && ownErrors.has(error)) throw error
      ensureActive()
      throw failure('NETWORK_ERROR')
    } finally {
      cancelBody()
      cancelTimer()
      removeAbort()
      if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', abort)
      controller.abort()
    }
  }
}
