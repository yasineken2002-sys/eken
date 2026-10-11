import { FortnoxOAuthClient, FortnoxOAuthError, fortnoxPkceChallenge } from './fortnox-oauth-client'
import type {
  FortnoxOAuthAuthorization,
  FortnoxOAuthClientOptions,
  FortnoxOAuthCode,
  FortnoxOAuthRefresh,
} from './fortnox-oauth-client'

const SECRET = 'synthetic-secret&+=:/never-real'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const CODE = 'synthetic-code+with&separators='
const REFRESH = 'synthetic-refresh+with&separators='
const tokenBody = {
  access_token: 'synthetic-access-token',
  refresh_token: 'synthetic-new-refresh-token',
  expires_in: 3600,
  scope: 'companyinformation bookkeeping',
  token_type: 'bearer',
}
const json = (body: unknown = tokenBody, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
function fixture(overrides: Partial<Omit<FortnoxOAuthClientOptions, 'fetch'>> = {}) {
  const fetch = jest.fn<ReturnType<typeof globalThis.fetch>, Parameters<typeof globalThis.fetch>>()
  fetch.mockImplementation(async () => json())
  const options: FortnoxOAuthClientOptions = {
    fetch,
    clientId: 'synthetic-client',
    clientSecret: SECRET,
    redirectUri: 'https://eveno.example/api/v1/fortnox/callback',
    enabled: true,
    ...overrides,
  }
  return { fetch, options, client: new FortnoxOAuthClient(options) }
}
const code: FortnoxOAuthCode = { code: CODE, codeVerifier: VERIFIER }
const refresh: FortnoxOAuthRefresh = { refreshToken: REFRESH }
const authorization: FortnoxOAuthAuthorization = {
  state: 'synthetic-server-generated-state',
  scopes: ['companyinformation', 'bookkeeping'],
  codeChallenge: CHALLENGE,
}

/** Only synthetic credentials and fake fetch are used; no app, DB or OAuth server starts. */
describe('FortnoxOAuthClient', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('derives S256 with the RFC7636 Appendix B known vector', () => {
    expect(fortnoxPkceChallenge(VERIFIER)).toBe(CHALLENGE)
  })

  it('builds the documented auth URL, with matching callback, offline and S256', () => {
    const { client, fetch } = fixture()
    const url = new URL(client.authorizationUrl(authorization))
    expect(url.origin + url.pathname).toBe('https://apps.fortnox.se/oauth-v1/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'synthetic-client',
      redirect_uri: 'https://eveno.example/api/v1/fortnox/callback',
      response_type: 'code',
      scope: 'companyinformation bookkeeping',
      state: authorization.state,
      access_type: 'offline',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('account_type')).toBe(false)
    expect(url.searchParams.has('company')).toBe(false)
    expect(url.toString()).not.toContain(SECRET)
    expect(url.toString()).not.toContain(VERIFIER)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { state: '' },
    { codeChallenge: VERIFIER.slice(0, 42) },
    { codeChallenge: `${CHALLENGE}=` },
    { scopes: [] },
    { scopes: ['bookkeeping'] },
    { scopes: ['companyinformation', 'payment'] },
    { scopes: ['companyinformation', 'companyinformation'] },
  ])('rejects invalid authorization input %j', (input) => {
    const { client } = fixture()
    expect(() =>
      client.authorizationUrl({ ...authorization, ...input } as FortnoxOAuthAuthorization),
    ).toThrow(FortnoxOAuthError)
  })

  it('is inert by default for all network operations', async () => {
    const { fetch, options } = fixture()
    delete options.enabled
    const client = new FortnoxOAuthClient(options)
    for (const call of [
      () => client.exchangeCode(code),
      () => client.refresh(refresh),
      () => client.revoke(refresh),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'DISABLED',
        outcome: 'not_sent',
        requiresRecovery: false,
      })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('exchanges one code with Basic credentials and a correctly encoded form', async () => {
    const { client, fetch } = fixture()
    await expect(client.exchangeCode(code)).resolves.toEqual({
      accessToken: tokenBody.access_token,
      refreshToken: tokenBody.refresh_token,
      scopes: ['companyinformation', 'bookkeeping'],
      expiresInSeconds: 3600,
      tokenType: 'bearer',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://apps.fortnox.se/oauth-v1/token')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Basic ${Buffer.from(`synthetic-client:${SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    })
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: 'https://eveno.example/api/v1/fortnox/callback',
      code_verifier: VERIFIER,
    })
  })

  it('refreshes once, returning the replacement token and no code/verifier fields', async () => {
    const { client, fetch } = fixture()
    await expect(client.refresh(refresh)).resolves.toMatchObject({
      refreshToken: tokenBody.refresh_token,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(
      Object.fromEntries(new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)),
    ).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
    })
  })

  it('revokes only the refresh token and checks the documented acknowledgement', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(json({ revoked: true }))
    await expect(client.revoke(refresh)).resolves.toEqual({ revoked: true })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://apps.fortnox.se/oauth-v1/revoke')
    expect(
      Object.fromEntries(new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)),
    ).toEqual({
      token_type_hint: 'refresh_token',
      token: REFRESH,
    })
  })

  it.each(['', 'a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}!`, `${'a'.repeat(42)}\n`])(
    'rejects invalid verifier before dispatch',
    async (codeVerifier) => {
      const { client, fetch } = fixture()
      await expect(client.exchangeCode({ ...code, codeVerifier })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        outcome: 'not_sent',
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(() => fortnoxPkceChallenge(codeVerifier)).toThrow(FortnoxOAuthError)
    },
  )

  it.each(['', 'has space', 'line\nbreak', 'a'.repeat(8193)])(
    'rejects invalid refresh credentials before dispatch',
    async (refreshToken) => {
      const { client, fetch } = fixture()
      await expect(client.refresh({ refreshToken })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        outcome: 'not_sent',
      })
      await expect(client.revoke({ refreshToken })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        outcome: 'not_sent',
      })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    { redirectUri: 'http://eveno.example/callback' },
    { redirectUri: 'https://user:pass@eveno.example/callback' },
    { redirectUri: 'https://eveno.example/callback#fragment' },
    { clientId: 'client:id' },
    { clientSecret: 'bad\r\nsecret' },
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 65537 },
  ])('rejects unsafe configuration without exposing its value', (overrides) => {
    expect(() => fixture(overrides)).toThrow('Fortnox OAuth: INVALID_INPUT')
  })

  it('snapshots credentials/options and does not serialize them as client fields', async () => {
    const { client, fetch, options } = fixture()
    options.clientSecret = 'changed-secret'
    options.redirectUri = 'https://attacker.example/callback'
    options.enabled = false
    expect(JSON.stringify(client)).toBe('{}')
    await client.exchangeCode(code)
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`synthetic-client:${SECRET}`).toString('base64')}`,
    })
    expect(new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string).get('redirect_uri')).toBe(
      'https://eveno.example/api/v1/fortnox/callback',
    )
  })

  it.each([400, 401, 403, 429, 408, 500, 502, 503, 302])(
    'never retries exchange, refresh or revoke on HTTP %d',
    async (status) => {
      for (const operation of ['exchange', 'refresh', 'revoke'] as const) {
        const { client, fetch } = fixture()
        fetch.mockResolvedValueOnce(
          json({ error: 'invalid_grant', error_description: `${SECRET} ${REFRESH}` }, status, {
            'Retry-After': '0',
          }),
        )
        const call =
          operation === 'exchange'
            ? client.exchangeCode(code)
            : operation === 'refresh'
              ? client.refresh(refresh)
              : client.revoke(refresh)
        const error: unknown = await call.catch((e: unknown) => e)
        const unknown = status === 408 || status >= 500 || status === 302
        expect(error).toMatchObject({
          code: 'HTTP_ERROR',
          operation,
          status,
          outcome: unknown ? 'unknown' : 'rejected',
          requiresRecovery: unknown,
        })
        expect(JSON.stringify(error)).not.toContain(SECRET)
        expect(String(error)).not.toContain(REFRESH)
        await jest.advanceTimersByTimeAsync(60000)
        expect(fetch).toHaveBeenCalledTimes(1)
      }
    },
  )

  it('reports network uncertainty without retaining the error cause, URL or credential', async () => {
    const { client, fetch } = fixture()
    fetch.mockRejectedValueOnce(new Error(`request ${SECRET} ${CODE} ${REFRESH}`))
    const error: unknown = await client.refresh(refresh).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'NETWORK_ERROR',
      operation: 'refresh',
      outcome: 'unknown',
      requiresRecovery: true,
    })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain(SECRET)
    expect(String(error)).not.toContain(CODE)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    null,
    [],
    {},
    { ...tokenBody, access_token: '' },
    { ...tokenBody, refresh_token: '' },
    { ...tokenBody, expires_in: '3600' },
    { ...tokenBody, expires_in: 0 },
    { ...tokenBody, token_type: 'basic' },
    { ...tokenBody, scope: 'companyinformation\nbookkeeping' },
    { ...tokenBody, error: 'invalid_grant' },
  ])(
    'rejects malformed success as unknown, without returning partial credentials: %j',
    async (body) => {
      const { client, fetch } = fixture()
      fetch.mockResolvedValueOnce(json(body))
      await expect(client.exchangeCode(code)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        outcome: 'unknown',
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('detects a refresh response that did not rotate the token', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(json({ ...tokenBody, refresh_token: REFRESH }))
    await expect(client.refresh(refresh)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      outcome: 'unknown',
    })
  })

  it.each([{ revoked: false }, {}, { revoked: 'true' }])(
    'does not claim revoke success for %j',
    async (body) => {
      const { client, fetch } = fixture()
      fetch.mockResolvedValueOnce(json(body))
      await expect(client.revoke(refresh)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        outcome: 'unknown',
      })
    },
  )

  it('rejects redirect responses even if an injected fetch followed one', async () => {
    const { client, fetch } = fixture()
    const redirected = json()
    Object.defineProperty(redirected, 'url', { value: 'https://elsewhere.example/oauth-v1/token' })
    fetch.mockResolvedValueOnce(redirected)
    await expect(client.refresh(refresh)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      outcome: 'unknown',
    })
  })

  it.each([
    new Response('not-json', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } }),
  ])('rejects malformed JSON/media type/UTF-8 without leaking response text', async (body) => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(body)
    await expect(client.exchangeCode(code)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      outcome: 'unknown',
    })
  })

  it('rejects oversized Content-Length before reading the body', async () => {
    const { client, fetch } = fixture({ maxResponseBytes: 256 })
    fetch.mockResolvedValueOnce(json(tokenBody, 200, { 'Content-Length': '257' }))
    await expect(client.refresh(refresh)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      outcome: 'unknown',
    })
  })

  it('counts actual streaming bytes when Content-Length is missing or lies', async () => {
    const { client, fetch } = fixture({ maxResponseBytes: 256 })
    const cancel = jest.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200))
        controller.enqueue(new Uint8Array(100))
      },
      cancel,
    })
    fetch.mockResolvedValueOnce(
      new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
      }),
    )
    await expect(client.refresh(refresh)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      outcome: 'unknown',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('bounds an uncooperative fetch and reports a consumed-token risk', async () => {
    const { client, fetch } = fixture({ timeoutMs: 100 })
    fetch.mockImplementation(() => new Promise(() => {}))
    const result = client.refresh(refresh).catch((e: unknown) => e)
    await jest.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({
      code: 'TIMEOUT',
      outcome: 'unknown',
      requiresRecovery: true,
    })
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds and cancels a response stream that never finishes', async () => {
    const { client, fetch } = fixture({ timeoutMs: 100 })
    const cancel = jest.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel,
    })
    fetch.mockResolvedValueOnce(
      new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    )
    const result = client.refresh(refresh).catch((e: unknown) => e)
    await jest.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ code: 'TIMEOUT', outcome: 'unknown' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('honours preflight cancellation without sending anything', async () => {
    const { client, fetch } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(client.exchangeCode({ ...code, signal: controller.signal })).rejects.toMatchObject(
      { code: 'CANCELLED', outcome: 'not_sent' },
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('honours cancellation after dispatch as unknown, never as rejected', async () => {
    const { client, fetch } = fixture()
    const controller = new AbortController()
    fetch.mockImplementation(() => new Promise(() => {}))
    const result = client.revoke({ ...refresh, signal: controller.signal }).catch((e: unknown) => e)
    controller.abort()
    expect(await result).toMatchObject({
      code: 'CANCELLED',
      operation: 'revoke',
      outcome: 'unknown',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('OAuth hostile input boundaries', () => {
  it.each(['exchange', 'refresh', 'revoke', 'authorize', 'config'] as const)(
    'sanitizes %s getter failures without credential-bearing cause',
    async (operation) => {
      const { client, fetch, options } = fixture()
      const secret = 'synthetic-private-getter-error'
      const fail = () => {
        throw new FortnoxOAuthError(secret as never, 'exchange', 'unknown')
      }
      let caught: unknown
      try {
        if (operation === 'exchange')
          await client.exchangeCode({
            ...code,
            get codeVerifier() {
              return fail()
            },
          })
        else if (operation === 'refresh')
          await client.refresh({
            get refreshToken() {
              return fail()
            },
          })
        else if (operation === 'revoke')
          await client.revoke({
            get refreshToken() {
              return fail()
            },
          })
        else if (operation === 'authorize')
          client.authorizationUrl({
            ...authorization,
            get scopes() {
              return fail()
            },
          })
        else
          new FortnoxOAuthClient({
            ...options,
            get clientSecret() {
              return fail()
            },
          })
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({
        code: 'INVALID_INPUT',
        outcome: 'not_sent',
        requiresRecovery: false,
      })
      expect(String(caught)).not.toContain(secret)
      expect(JSON.stringify(caught)).not.toContain(secret)
      expect(caught).not.toHaveProperty('cause')
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('reads code/verifier once and encodes the same validated values', async () => {
    const { client, fetch } = fixture()
    const codeGetter = jest.fn().mockReturnValueOnce(CODE).mockReturnValue('changed-code')
    const verifierGetter = jest.fn().mockReturnValueOnce(VERIFIER).mockReturnValue('invalid')
    const input = Object.defineProperties(
      {},
      { code: { get: codeGetter }, codeVerifier: { get: verifierGetter } },
    ) as FortnoxOAuthCode
    await client.exchangeCode(input)
    expect(codeGetter).toHaveBeenCalledTimes(1)
    expect(verifierGetter).toHaveBeenCalledTimes(1)
    const body = new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string)
    expect(body.get('code')).toBe(CODE)
    expect(body.get('code_verifier')).toBe(VERIFIER)
  })

  it.each([undefined, NaN, 200.5, '200', 600])(
    'cannot return tokens for malformed status %s',
    async (status) => {
      const { client, fetch } = fixture()
      const malformed = json()
      Object.defineProperty(malformed, 'status', { value: status })
      fetch.mockResolvedValueOnce(malformed)
      await expect(client.exchangeCode(code)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        outcome: 'unknown',
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('does not treat a revoke acknowledgement with an error member as confirmed', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(json({ revoked: true, error: 'invalid_grant' }))
    await expect(client.revoke(refresh)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      outcome: 'unknown',
    })
  })
})

describe('OAuth response error boundary', () => {
  it('sanitizes a forged OAuth error from an upstream stream', async () => {
    const { client, fetch } = fixture()
    const secret = 'synthetic-stream-secret'
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new FortnoxOAuthError(secret as never, 'refresh', 'unknown'))
      },
    })
    fetch.mockResolvedValueOnce(
      new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    )
    const error: unknown = await client.refresh(refresh).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE', outcome: 'unknown' })
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })
})
