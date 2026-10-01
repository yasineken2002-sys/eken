import { FortnoxOAuthClient, FortnoxOAuthError } from './provider/fortnox-oauth-client'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FortnoxTransportError } from './provider/fortnox-transport.types'
import { FortnoxAuthError, FortnoxReadError } from './fortnox.types'
import type { FortnoxOAuthScope, FortnoxOAuthTokenSet } from './provider/fortnox-oauth-client'
import type { FortnoxAuthProvider, FortnoxLedgerReader, FortnoxTokenSet } from './fortnox.types'

export interface RealFortnoxAuthProviderOptions {
  client: FortnoxOAuthClient
  /** Same registered URI used to construct the OAuth client. */
  redirectUri: string
  scopes: readonly FortnoxOAuthScope[]
  enabled?: boolean
  now?: () => number
}

/** No persistence or refresh retries: C1's service owns durable state and concurrency. */
export class RealFortnoxAuthProvider implements FortnoxAuthProvider {
  readonly name = 'REAL' as const
  readonly #client: FortnoxOAuthClient
  readonly #redirectUri: string
  readonly #scopes: readonly FortnoxOAuthScope[]
  readonly #enabled: boolean
  readonly #now: () => number

  constructor(options: RealFortnoxAuthProviderOptions) {
    try {
      this.#client = options.client
      this.#redirectUri = options.redirectUri
      this.#scopes = [...options.scopes]
      this.#enabled = options.enabled === true
      this.#now = options.now ?? (() => Date.now())
      // Pure local serialization checks adapter/client configuration consistency, not portal registration.
      const configured = new URL(
        this.#client.authorizationUrl({
          state: 'configuration-check',
          scopes: this.#scopes,
          codeChallenge: 'A'.repeat(43),
        }),
      )
      if (configured.searchParams.get('redirect_uri') !== this.#redirectUri)
        throw new Error('Callback mismatch')
    } catch {
      throw new FortnoxAuthError('not_sent')
    }
  }

  authorizeUrl(input: { state: string; redirectUri: string; codeChallenge: string }): string {
    try {
      const { state, redirectUri, codeChallenge } = input
      if (
        !this.#enabled ||
        redirectUri !== this.#redirectUri ||
        typeof codeChallenge !== 'string'
      ) {
        throw new Error('Authorization unavailable')
      }
      return this.#client.authorizationUrl({
        state,
        scopes: this.#scopes,
        codeChallenge,
      })
    } catch {
      throw new FortnoxAuthError('not_sent')
    }
  }

  async exchangeCode(input: {
    code: string
    redirectUri: string
    codeVerifier: string
  }): Promise<FortnoxTokenSet> {
    let request: { code: string; codeVerifier: string }
    let startedAt: number
    try {
      const { code, redirectUri, codeVerifier } = input
      if (!this.#enabled || redirectUri !== this.#redirectUri || typeof codeVerifier !== 'string')
        throw new Error('Exchange unavailable')
      request = { code, codeVerifier }
      startedAt = this.#time()
    } catch {
      throw new FortnoxAuthError('not_sent')
    }
    try {
      return this.#tokens(await this.#client.exchangeCode(request), startedAt)
    } catch (error) {
      throw this.#authError(error)
    }
  }

  async refresh(refreshToken: string): Promise<FortnoxTokenSet> {
    if (!this.#enabled) throw new FortnoxAuthError('not_sent')
    const startedAt = this.#time()
    try {
      return this.#tokens(await this.#client.refresh({ refreshToken }), startedAt)
    } catch (error) {
      throw this.#authError(error)
    }
  }

  async revoke(refreshToken: string): Promise<void> {
    if (!this.#enabled) throw new FortnoxAuthError('not_sent')
    try {
      await this.#client.revoke({ refreshToken })
    } catch (error) {
      throw this.#authError(error)
    }
  }

  #time(): number {
    try {
      const value = this.#now()
      if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()))
        throw new Error('Invalid clock')
      return value
    } catch {
      throw new FortnoxAuthError('not_sent')
    }
  }

  #tokens(tokens: FortnoxOAuthTokenSet, startedAt: number): FortnoxTokenSet {
    // Use request start rather than response completion: network time must not extend validity.
    const expiresAt = new Date(startedAt + tokens.expiresInSeconds * 1000)
    if (!Number.isFinite(expiresAt.getTime())) throw new FortnoxAuthError('unknown')
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
      scope: tokens.scopes.join(' '),
    }
  }

  #authError(error: unknown): FortnoxAuthError {
    if (error instanceof FortnoxOAuthError) {
      // 429 is a sent rate-limited request, not evidence that a rotating token is invalid.
      // The frozen HTTP client exposes no Retry-After; do not invent provider timing here.
      if (error.status === 429) return new FortnoxAuthError('rate_limited')
      return new FortnoxAuthError(
        error.outcome === 'unknown'
          ? 'unknown'
          : error.outcome === 'rejected'
            ? 'rejected'
            : 'not_sent',
      )
    }
    // Unexpected failures after a grant begins cannot prove that the credential is still usable.
    return new FortnoxAuthError('unknown')
  }
}

export interface RealFortnoxLedgerReaderOptions {
  /** Share this transport/limiter for all reader instances for this client. */
  transport: FortnoxTransport
  clientId: string
  enabled?: boolean
}

/** Read-only adapter; deliberately reserves one conservative bucket for all client tenants. */
export class RealFortnoxLedgerReader implements FortnoxLedgerReader {
  readonly #transport: FortnoxTransport
  readonly #rateLimitKey: string
  readonly #enabled: boolean

  constructor(options: RealFortnoxLedgerReaderOptions) {
    try {
      const clientId = options.clientId
      if (typeof clientId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(clientId))
        throw new FortnoxReadError('invalid')
      this.#rateLimitKey = `fortnox:${clientId}:all-tenants`
      this.#transport = options.transport
      this.#enabled = options.enabled === true
    } catch {
      throw new FortnoxReadError('invalid')
    }
  }

  async get<T>(
    accessToken: string,
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<T> {
    if (!this.#enabled) throw new FortnoxReadError('invalid')
    try {
      const result = await this.#transport.request<T>({
        accessToken,
        path,
        method: 'GET',
        rateLimitKey: this.#rateLimitKey,
        ...(query === undefined ? {} : { query }),
      })
      return result.data
    } catch (error) {
      if (!(error instanceof FortnoxTransportError)) throw new FortnoxReadError('invalid')
      if (error.status === 401) throw new FortnoxReadError('auth', 401)
      if (error.status === 403) throw new FortnoxReadError('forbidden', 403)
      const transient =
        ['NETWORK_ERROR', 'TIMEOUT', 'CANCELLED', 'RATE_LIMIT_ERROR', 'RETRY_DEFERRED'].includes(
          error.code,
        ) ||
        error.status === 429 ||
        (error.status !== undefined && error.status >= 500)
      throw new FortnoxReadError(transient ? 'transient' : 'invalid', error.status)
    }
  }
}
