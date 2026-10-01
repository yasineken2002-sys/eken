import { RealFortnoxAuthProvider, RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxOAuthClient, fortnoxPkceChallenge } from './provider/fortnox-oauth-client'
import { FortnoxTransport } from './provider/fortnox-transport'
import { InMemoryFortnoxRateLimiter } from './provider/fortnox-rate-limiter'
import { FortnoxAuthError, FortnoxReadError } from './fortnox.types'

const REDIRECT = 'https://eveno.example/v1/integrations/fortnox/callback'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const ACCESS = 'synthetic-access-token'
const REFRESH = 'synthetic-refresh-token'
const SECRET = 'synthetic-client-secret'
const baseTime = Date.parse('2026-10-01T12:00:00Z')
const tokenBody = {
  access_token: ACCESS,
  refresh_token: REFRESH,
  expires_in: 3600,
  token_type: 'bearer',
  scope: 'companyinformation bookkeeping costcenter',
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

function fixture(
  options: {
    enabled?: boolean
    oauthEnabled?: boolean
    clientId?: string
    limiter?: InMemoryFortnoxRateLimiter
    timeoutMs?: number
  } = {},
) {
  const clientId = options.clientId ?? 'synthetic-client'
  const fetch = jest.fn<ReturnType<typeof globalThis.fetch>, Parameters<typeof globalThis.fetch>>()
  fetch.mockImplementation(async (input) => {
    const url = String(input)
    if (url === 'https://apps.fortnox.se/oauth-v1/token') return json(tokenBody)
    if (url === 'https://apps.fortnox.se/oauth-v1/revoke') return json({ revoked: true })
    if (url === 'https://api.fortnox.se/3/companyinformation')
      return json({
        CompanyInformation: {
          DatabaseNumber: 900001,
          OrganizationNumber: '556000-0001',
          CompanyName: 'Syntetiskt testbolag',
        },
      })
    if (url.startsWith('https://api.fortnox.se/3/vouchers'))
      return json({ Vouchers: [{ VoucherSeries: 'A', VoucherNumber: 1 }] })
    throw new Error('Unexpected fake route')
  })
  const client = new FortnoxOAuthClient({
    fetch,
    clientId,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    enabled: options.oauthEnabled ?? true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const transport = new FortnoxTransport({
    fetch,
    ...(options.limiter ? { rateLimiter: options.limiter } : {}),
  })
  const auth = new RealFortnoxAuthProvider({
    client,
    redirectUri: REDIRECT,
    scopes: ['companyinformation', 'bookkeeping', 'costcenter'],
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  })
  const reader = new RealFortnoxLedgerReader({
    transport,
    clientId,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  })
  return { auth, reader, fetch }
}
const exchange = {
  code: 'synthetic-code',
  redirectUri: REDIRECT,
  codeVerifier: VERIFIER,
}

/** Real adapter + frozen OAuth client + frozen transport; only the wire is replaced. */
describe('Fortnox REAL provider adapter', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(baseTime)
  })
  afterEach(() => jest.useRealTimers())

  it('is inert by default even if the underlying OAuth client is enabled', async () => {
    const { auth, reader, fetch } = fixture()
    expect(() =>
      auth.authorizeUrl({
        state: 'state',
        redirectUri: REDIRECT,
        codeChallenge: fortnoxPkceChallenge(VERIFIER),
      }),
    ).toThrow(FortnoxAuthError)
    await expect(auth.exchangeCode(exchange)).rejects.toMatchObject({
      kind: 'not_sent',
    })
    await expect(auth.refresh(REFRESH)).rejects.toMatchObject({
      kind: 'not_sent',
    })
    await expect(auth.revoke(REFRESH)).rejects.toMatchObject({
      kind: 'not_sent',
    })
    await expect(reader.get(ACCESS, '/3/vouchers')).rejects.toBeInstanceOf(FortnoxReadError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('connects auth URL, PKCE form exchange and company GET through the real clients', async () => {
    const { auth, reader, fetch } = fixture({ enabled: true })
    const url = new URL(
      auth.authorizeUrl({
        state: 'server-owned-state',
        redirectUri: REDIRECT,
        codeChallenge: fortnoxPkceChallenge(VERIFIER),
      }),
    )
    expect(auth.name).toBe('REAL')
    expect(url.origin + url.pathname).toBe('https://apps.fortnox.se/oauth-v1/auth')
    expect(url.searchParams.get('state')).toBe('server-owned-state')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('companyinformation bookkeeping costcenter')
    expect(url.searchParams.has('account_type')).toBe(false)
    const tokens = await auth.exchangeCode(exchange)
    expect(tokens).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(baseTime + 3600_000),
      scope: 'companyinformation bookkeeping costcenter',
    })
    const posted = new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)
    expect(posted.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'))
    expect(fortnoxPkceChallenge(posted.get('code_verifier')!)).toBe(
      url.searchParams.get('code_challenge'),
    )
    const company = await reader.get(tokens.accessToken, '/3/companyinformation')
    expect(company).toMatchObject({
      CompanyInformation: { DatabaseNumber: 900001 },
    })
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${ACCESS}` },
    })
    expect(JSON.stringify(auth)).not.toContain(SECRET)
    // The adapter returns evidence; only C1's authorized service may bind this company or mark ACTIVE.
  })

  it('does not invent granted scopes when Fortnox grants fewer than requested', async () => {
    const { auth, fetch } = fixture({ enabled: true })
    fetch.mockResolvedValueOnce(json({ ...tokenBody, scope: 'companyinformation' }))
    await expect(auth.exchangeCode(exchange)).resolves.toMatchObject({
      scope: 'companyinformation',
    })
  })

  it('does not extend expiry by network time', async () => {
    const { auth, fetch } = fixture({ enabled: true })
    let resolve: (response: Response) => void = () => {}
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const result = auth.exchangeCode(exchange)
    await jest.advanceTimersByTimeAsync(1500)
    resolve(json(tokenBody))
    await expect(result).resolves.toMatchObject({
      expiresAt: new Date(baseTime + 3600_000),
    })
  })

  it('passes rotated tokens through the C1 port and revokes only refresh tokens', async () => {
    const { auth, fetch } = fixture({ enabled: true })
    fetch.mockResolvedValueOnce(
      json({
        ...tokenBody,
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
      }),
    )
    await expect(auth.refresh(REFRESH)).resolves.toMatchObject({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    })
    await auth.revoke('rotated-refresh')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(
      Object.fromEntries(new URLSearchParams(fetch.mock.calls[1]?.[1]?.body as string)),
    ).toEqual({ token_type_hint: 'refresh_token', token: 'rotated-refresh' })
    expect(fetch.mock.calls[1]?.[0]).toBe('https://apps.fortnox.se/oauth-v1/revoke')
  })

  it('requires PKCE and exact registered callback before any exchange', async () => {
    const { auth, fetch } = fixture({ enabled: true })
    expect(() =>
      auth.authorizeUrl({ state: 'state', redirectUri: REDIRECT } as Parameters<
        RealFortnoxAuthProvider['authorizeUrl']
      >[0]),
    ).toThrow(FortnoxAuthError)
    expect(() =>
      auth.authorizeUrl({
        state: 'state',
        redirectUri: 'https://other.example/callback',
        codeChallenge: fortnoxPkceChallenge(VERIFIER),
      }),
    ).toThrow(FortnoxAuthError)
    await expect(
      auth.exchangeCode({ code: 'code', redirectUri: REDIRECT } as Parameters<
        RealFortnoxAuthProvider['exchangeCode']
      >[0]),
    ).rejects.toMatchObject({
      kind: 'not_sent',
    })
    await expect(
      auth.exchangeCode({
        ...exchange,
        redirectUri: 'https://other.example/callback',
      }),
    ).rejects.toMatchObject({ kind: 'not_sent' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([500, 502, 503, 408, 302])(
    'maps refresh HTTP %d to unknown and dispatches once',
    async (status) => {
      const { auth, fetch } = fixture({ enabled: true })
      fetch.mockResolvedValueOnce(
        json({ error: 'server_error', error_description: SECRET }, status),
      )
      const error: unknown = await auth.refresh(REFRESH).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FortnoxAuthError)
      expect(error).toMatchObject({ kind: 'unknown' })
      expect(String(error)).not.toContain(SECRET)
      await jest.advanceTimersByTimeAsync(60000)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each([400, 401, 403])(
    'maps refresh HTTP %d to rejected and does not auto-refresh again',
    async (status) => {
      const { auth, fetch } = fixture({ enabled: true })
      fetch.mockResolvedValueOnce(json({ error: 'invalid_grant' }, status))
      await expect(auth.refresh(REFRESH)).rejects.toMatchObject({
        kind: 'rejected',
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('maps a malformed successful grant and missing rotation to unknown', async () => {
    const { auth, fetch } = fixture({ enabled: true })
    fetch.mockResolvedValueOnce(json({ ...tokenBody, refresh_token: REFRESH }))
    await expect(auth.refresh(REFRESH)).rejects.toMatchObject({
      kind: 'unknown',
    })
    fetch.mockResolvedValueOnce(json({ access_token: ACCESS }))
    await expect(auth.exchangeCode(exchange)).rejects.toMatchObject({
      kind: 'unknown',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['refresh', 'exchange', 'revoke'] as const)(
    'maps sent %s HTTP 429 to rate_limited without retry or an invented Retry-After',
    async (operation) => {
      const { auth, fetch } = fixture({ enabled: true })
      fetch.mockResolvedValueOnce(
        json({ error: 'rate_limit', error_description: SECRET }, 429, {
          'Retry-After': '60',
        }),
      )
      const result =
        operation === 'refresh'
          ? auth.refresh(REFRESH)
          : operation === 'exchange'
            ? auth.exchangeCode(exchange)
            : auth.revoke(REFRESH)
      const error: unknown = await result.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FortnoxAuthError)
      expect(error).toMatchObject({ kind: 'rate_limited' })
      expect(error).not.toHaveProperty('retryAfterMs')
      expect(String(error)).not.toContain(SECRET)
      expect(error).not.toHaveProperty('cause')
      await jest.advanceTimersByTimeAsync(60_000)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('preserves timeout as unknown rather than C1 not_sent/retry', async () => {
    const { auth, fetch } = fixture({ enabled: true, timeoutMs: 20 })
    fetch.mockImplementationOnce(() => new Promise(() => {}))
    const result = auth.refresh(REFRESH).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(20)
    expect(await result).toMatchObject({ kind: 'unknown' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('preserves network ambiguity for exchange and revoke without exposing raw errors', async () => {
    const { auth, fetch } = fixture({ enabled: true })
    fetch.mockRejectedValueOnce(new Error(`${SECRET} ${REFRESH}`))
    const exchangeError: unknown = await auth
      .exchangeCode(exchange)
      .catch((error: unknown) => error)
    fetch.mockRejectedValueOnce(new Error(`${SECRET} ${REFRESH}`))
    const revokeError: unknown = await auth.revoke(REFRESH).catch((error: unknown) => error)
    for (const error of [exchangeError, revokeError]) {
      expect(error).toMatchObject({ kind: 'unknown' })
      expect(JSON.stringify(error)).not.toContain(SECRET)
      expect(String(error)).not.toContain(REFRESH)
      expect(error).not.toHaveProperty('cause')
    }
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses not_sent only when the OAuth client confirms no dispatch', async () => {
    const { auth, fetch } = fixture({ enabled: true, oauthEnabled: false })
    await expect(auth.refresh(REFRESH)).rejects.toMatchObject({
      kind: 'not_sent',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'invalid'],
  ] as const)('maps read %d to %s without any token refresh', async (status, kind) => {
    const { reader, fetch } = fixture({ enabled: true })
    fetch.mockResolvedValueOnce(json({ ErrorInformation: { message: SECRET } }, status))
    const error: unknown = await reader.get(ACCESS, '/3/vouchers').catch((error: unknown) => error)
    expect(error).toMatchObject({ kind, status })
    expect(String(error)).not.toContain(SECRET)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('retains bounded GET retry behavior through the reader adapter', async () => {
    const { reader, fetch } = fixture({ enabled: true })
    fetch.mockResolvedValueOnce(json({}, 503))
    const result = reader.get(ACCESS, '/3/vouchers', {
      financialyear: 5,
      page: 1,
    })
    await jest.advanceTimersByTimeAsync(499)
    expect(fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({
      Vouchers: [{ VoucherSeries: 'A', VoucherNumber: 1 }],
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it('turns exhausted GET 429 into transient while retaining three-attempt transport limit', async () => {
    const { reader, fetch } = fixture({ enabled: true })
    fetch.mockImplementation(async () => json({}, 429, { 'Retry-After': '1' }))
    const result = reader.get(ACCESS, '/3/vouchers').catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(2000)
    expect(await result).toMatchObject({ kind: 'transient', status: 429 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('never gives the reader write/payment routes or absolute URL access', async () => {
    const { reader, fetch } = fixture({ enabled: true })
    for (const path of [
      'https://evil.example/3/vouchers',
      '/3/supplierinvoices/1/bookkeep',
      '/3/invoicepayments',
    ]) {
      await expect(reader.get(ACCESS, path)).rejects.toMatchObject({
        kind: 'invalid',
      })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not leak query-getter errors through the C1 read port', async () => {
    const { reader, fetch } = fixture({ enabled: true })
    const query = {
      get page(): number {
        throw new Error(SECRET)
      },
    }
    const error: unknown = await reader
      .get(ACCESS, '/3/vouchers', query)
      .catch((error: unknown) => error)
    expect(error).toMatchObject({ kind: 'invalid' })
    expect(String(error)).not.toContain(SECRET)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shares one stable client bucket despite token/tenant changes and separates other clients', async () => {
    const limiter = new InMemoryFortnoxRateLimiter()
    const a = fixture({ enabled: true, limiter })
    const b = fixture({ enabled: true, limiter })
    const other = fixture({ enabled: true, limiter, clientId: 'other-client' })
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        a.reader.get(`synthetic-tenant-token-${i}`, '/3/vouchers'),
      ),
    )
    const next = b.reader.get('synthetic-refreshed-token', '/3/vouchers')
    await jest.advanceTimersByTimeAsync(4999)
    expect(b.fetch).not.toHaveBeenCalled()
    await other.reader.get('different-client-token', '/3/vouchers')
    expect(other.fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await next
    expect(b.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('REAL adapter configuration consistency', () => {
  it('refuses a callback mismatch between C1 adapter configuration and OAuth client without dispatch', () => {
    const fetch = jest.fn<
      ReturnType<typeof globalThis.fetch>,
      Parameters<typeof globalThis.fetch>
    >()
    const client = new FortnoxOAuthClient({
      fetch,
      clientId: 'client',
      clientSecret: SECRET,
      redirectUri: REDIRECT,
      enabled: true,
    })
    expect(
      () =>
        new RealFortnoxAuthProvider({
          client,
          redirectUri: 'https://elsewhere.example/callback',
          scopes: ['companyinformation'],
          enabled: true,
        }),
    ).toThrow(FortnoxAuthError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not leak credential-bearing configuration getters', () => {
    const fetch = jest.fn<
      ReturnType<typeof globalThis.fetch>,
      Parameters<typeof globalThis.fetch>
    >()
    const client = new FortnoxOAuthClient({
      fetch,
      clientId: 'client',
      clientSecret: SECRET,
      redirectUri: REDIRECT,
    })
    const transport = new FortnoxTransport({ fetch })
    const fail = () => {
      throw new Error(SECRET)
    }
    for (const make of [
      () =>
        new RealFortnoxAuthProvider({
          client,
          redirectUri: REDIRECT,
          get scopes() {
            return fail()
          },
        }),
      () =>
        new RealFortnoxLedgerReader({
          transport,
          get clientId() {
            return fail()
          },
        }),
    ]) {
      let caught: unknown
      try {
        make()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect(String(caught)).not.toContain(SECRET)
      expect(caught).not.toHaveProperty('cause')
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
