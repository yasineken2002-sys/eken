import { FortnoxTransport } from './fortnox-transport'
import { InMemoryFortnoxRateLimiter, systemFortnoxClock } from './fortnox-rate-limiter'
import { parseFortnoxRetryAfter } from './fortnox-retry-after'
import { FortnoxTransportError } from './fortnox-transport.types'
import type { FortnoxTransportOptions, FortnoxTransportRequest } from './fortnox-transport.types'

const TOKEN = 'synthetic-not-a-real-token'
const read: FortnoxTransportRequest = {
  accessToken: TOKEN,
  rateLimitKey: 'client:test-tenant',
  method: 'GET',
  path: '/3/vouchers',
}
const write: FortnoxTransportRequest = {
  ...read,
  method: 'POST',
  body: { Voucher: { Description: 'synthetic' } },
}
const response = (status = 200, headers: Record<string, string> = {}, body = '{"Vouchers":[]}') =>
  new Response(body, { status, headers })

function fixture(options: Omit<FortnoxTransportOptions, 'fetch'> = {}) {
  const fetch = jest.fn<ReturnType<typeof globalThis.fetch>, Parameters<typeof globalThis.fetch>>()
  fetch.mockImplementation(async () => response())
  return {
    fetch,
    transport: new FortnoxTransport({ fetch, clock: systemFortnoxClock, ...options }),
  }
}

/** No real network, credentials, OAuth, DB or application boot occurs in these tests. */
describe('FortnoxTransport', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-10-01T12:00:00Z'))
  })
  afterEach(() => jest.useRealTimers())

  it('sends only bearer auth to the fixed origin and returns provider JSON with attempt count', async () => {
    const { transport, fetch } = fixture()
    await expect(
      transport.request({ ...read, query: { financialyear: 5, page: 2, limit: 100 } }),
    ).resolves.toEqual({ data: { Vouchers: [] }, status: 200, attempts: 1 })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.fortnox.se/3/vouchers?financialyear=5&page=2&limit=100',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
        signal: expect.any(AbortSignal),
        redirect: 'error',
      },
    )
  })

  it.each([
    'https://evil.example/3/vouchers',
    '//evil.example/3/vouchers',
    'https://api.fortnox.se/3/vouchers',
    '/3/../vouchers',
    '/3/%2e%2e/vouchers',
    '/3/vouchers?method=POST',
    '/3/vouchers#secret',
    '/3/vouchers/',
    '/3/vouchers\\evil',
    '/3/vouchers%2fA%2f1',
    '/3/invoices',
    '/3/supplierinvoices/1/bookkeep',
    '/3/supplierinvoicepayments',
    '/oauth-v1/token',
  ])('rejects non-allowlisted or noncanonical path %s before fetch', async (path) => {
    const { transport, fetch } = fixture()
    await expect(transport.request({ ...read, path })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      outcome: 'not_sent',
      attempts: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['PUT', 'DELETE', 'PATCH', 'HEAD', 'get'])(
    'rejects method %s at runtime',
    async (method) => {
      const { transport, fetch } = fixture({ allowVoucherWrites: true })
      await expect(
        transport.request({ ...read, method } as FortnoxTransportRequest),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    { query: { access_token: TOKEN } },
    { query: { _method: 'POST' } },
    { query: { limit: 501 } },
    { query: { page: 0 } },
    { query: { offset: -1 } },
    { query: { financialyear: NaN } },
    { body: {} },
    { accessToken: 'bad\r\ntoken' },
    { accessToken: '' },
    { rateLimitKey: '' },
  ])('rejects unsafe request input %j before fetch', async (overrides) => {
    const { transport, fetch } = fixture()
    await expect(
      transport.request({ ...read, ...overrides } as FortnoxTransportRequest),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', attempts: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/3/companyinformation',
    '/3/accounts/3000',
    '/3/financialyears/5',
    '/3/projects/123',
    '/3/costcenters/HUS-A',
    '/3/voucherseries/A',
    '/3/supplierinvoices/44',
    '/3/vouchers/A/1',
    '/3/vouchers/sublist',
    '/3/vouchers/sublist/A',
  ])('allows documented read route %s', async (path) => {
    const { transport } = fixture()
    await expect(transport.request({ ...read, path })).resolves.toMatchObject({ attempts: 1 })
  })

  it('disables all writes by default and disallows invoice/payment writes even with voucher capability', async () => {
    const disabled = fixture()
    await expect(disabled.transport.request(write)).rejects.toMatchObject({
      code: 'WRITE_DISABLED',
    })
    expect(disabled.fetch).not.toHaveBeenCalled()
    const enabled = fixture({ allowVoucherWrites: true })
    for (const path of ['/3/invoices', '/3/supplierinvoices', '/3/invoicepayments']) {
      await expect(enabled.transport.request({ ...write, path })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(enabled.fetch).not.toHaveBeenCalled()
  })

  it('returns a successful voucher write after exactly one attempt', async () => {
    const { transport, fetch } = fixture({ allowVoucherWrites: true })
    fetch.mockResolvedValueOnce(response(201, {}, '{"Voucher":{"VoucherNumber":1}}'))
    await expect(transport.request(write)).resolves.toMatchObject({ status: 201, attempts: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(write.body))
  })

  it.each([400, 401, 403, 404, 408, 422])('never retries GET HTTP %d', async (status) => {
    const { transport, fetch } = fixture()
    fetch.mockResolvedValueOnce(response(status))
    await expect(transport.request(read)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status,
      attempts: 1,
      reconciliationRequired: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([429, 500, 502, 503, 504])(
    'retries only reads for HTTP %d, with a bounded delay',
    async (status) => {
      const { transport, fetch } = fixture()
      fetch.mockResolvedValueOnce(response(status, { 'Retry-After': '2' }))
      const result = transport.request(read)
      await jest.advanceTimersByTimeAsync(1999)
      expect(fetch).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toMatchObject({ attempts: 2 })
      expect(fetch).toHaveBeenCalledTimes(2)
    },
  )

  it('honours Retry-After HTTP dates', async () => {
    const { transport, fetch } = fixture()
    fetch.mockResolvedValueOnce(response(429, { 'Retry-After': 'Thu, 01 Oct 2026 12:00:03 GMT' }))
    const result = transport.request(read)
    await jest.advanceTimersByTimeAsync(2999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toMatchObject({ attempts: 2 })
  })

  it('exhausts at three GET attempts with 500ms and 1000ms backoff when header is absent', async () => {
    const { transport, fetch } = fixture()
    fetch.mockImplementation(async () => response(503))
    const result = transport.request(read).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(1499)
    expect(fetch).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ code: 'HTTP_ERROR', status: 503, attempts: 3 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('defers instead of retrying before a Retry-After that exceeds the total deadline', async () => {
    const { transport, fetch } = fixture({ timeoutMs: 1000 })
    fetch.mockResolvedValueOnce(response(429, { 'Retry-After': '60' }))
    await expect(transport.request(read)).rejects.toMatchObject({
      code: 'RETRY_DEFERRED',
      attempts: 1,
      retryAfterMs: 60000,
    })
    await jest.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([429, 500, 502, 503, 504, 408, 302, 401, 403])(
    'never retries POST HTTP %d and classifies its outcome',
    async (status) => {
      const { transport, fetch } = fixture({ allowVoucherWrites: true })
      fetch.mockResolvedValueOnce(response(status, { 'Retry-After': '1' }))
      const unknown = status >= 500 || status === 408 || status === 302
      await expect(transport.request(write)).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        status,
        attempts: 1,
        outcome: unknown ? 'unknown' : 'rejected',
        reconciliationRequired: unknown,
      })
      await jest.advanceTimersByTimeAsync(5000)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['GET', 'POST'] as const)(
    'does not retry %s network failures or expose upstream errors',
    async (method) => {
      const { transport, fetch } = fixture({ allowVoucherWrites: true })
      fetch.mockRejectedValueOnce(new Error(`upstream leaked ${TOKEN} and private accounting data`))
      const error: unknown = await transport
        .request(method === 'GET' ? read : write)
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FortnoxTransportError)
      expect(error).toMatchObject({
        code: 'NETWORK_ERROR',
        attempts: 1,
        reconciliationRequired: method === 'POST',
      })
      expect(JSON.stringify(error)).not.toContain(TOKEN)
      expect(String(error)).not.toContain('upstream leaked')
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['invalid json', 'null', '[]', '{"ErrorInformation":{"message":"secret"}}'])(
    'treats malformed successful writes as unknown: %s',
    async (body) => {
      const { transport, fetch } = fixture({ allowVoucherWrites: true })
      fetch.mockResolvedValueOnce(response(201, {}, body))
      await expect(transport.request(write)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        attempts: 1,
        reconciliationRequired: true,
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('bounds an uncooperative fetch and aborts it without retry', async () => {
    const { transport, fetch } = fixture({ allowVoucherWrites: true, timeoutMs: 100 })
    fetch.mockImplementation(() => new Promise(() => {}))
    const result = transport.request(write).catch((e: unknown) => e)
    await jest.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ code: 'TIMEOUT', outcome: 'unknown', attempts: 1 })
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('includes response body reading in the total timeout', async () => {
    const { transport, fetch } = fixture({ allowVoucherWrites: true, timeoutMs: 100 })
    const stalled = response(201)
    jest.spyOn(stalled, 'json').mockImplementation(() => new Promise(() => {}))
    fetch.mockResolvedValueOnce(stalled)
    const result = transport.request(write).catch((e: unknown) => e)
    await jest.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({
      code: 'TIMEOUT',
      reconciliationRequired: true,
      attempts: 1,
    })
  })

  it('timeout before limiter admission is not sent, even if the limiter later completes', async () => {
    let release: () => void = () => {}
    const limiter = {
      acquire: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      defer: () => {},
    }
    const { transport, fetch } = fixture({
      timeoutMs: 100,
      rateLimiter: limiter,
      allowVoucherWrites: true,
    })
    const result = transport.request(write).catch((e: unknown) => e)
    await jest.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ code: 'TIMEOUT', outcome: 'not_sent', attempts: 0 })
    release()
    await jest.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('snapshots validated input before waiting so mutation cannot turn a read into a write', async () => {
    let release: () => void = () => {}
    const limiter = {
      acquire: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      defer: () => {},
    }
    const { transport, fetch } = fixture({ rateLimiter: limiter })
    const mutable = { ...read }
    const result = transport.request(mutable)
    mutable.method = 'POST'
    mutable.accessToken = 'replacement-token'
    mutable.path = '/3/invoicepayments'
    release()
    await expect(result).resolves.toMatchObject({ attempts: 1 })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.fortnox.se/3/vouchers')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
  })

  it('honours cancellation before dispatch', async () => {
    const { transport, fetch } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(transport.request({ ...read, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
      outcome: 'not_sent',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a redirected response from an injected fetch', async () => {
    const { transport, fetch } = fixture()
    const redirected = response()
    Object.defineProperty(redirected, 'redirected', { value: true })
    fetch.mockResolvedValueOnce(redirected)
    await expect(transport.request(read)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shares the process-local 25/5s allowance across transports and refreshed tokens', async () => {
    const rateLimiter = new InMemoryFortnoxRateLimiter(systemFortnoxClock)
    const a = fixture({ rateLimiter })
    const b = fixture({ rateLimiter })
    await Promise.all(Array.from({ length: 25 }, () => a.transport.request(read)))
    const next = b.transport.request({ ...read, accessToken: 'refreshed-synthetic-token' })
    await jest.advanceTimersByTimeAsync(4999)
    expect(b.fetch).not.toHaveBeenCalled()
    // Another tenant retains its independent allowance.
    await b.transport.request({ ...read, rateLimitKey: 'client:other-tenant' })
    expect(b.fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await expect(next).resolves.toMatchObject({ attempts: 1 })
    expect(b.fetch).toHaveBeenCalledTimes(2)
  })

  it('a final 429 cools down subsequent calls sharing the limiter', async () => {
    const { transport, fetch } = fixture({ maxReadAttempts: 1 })
    fetch.mockResolvedValueOnce(response(429, { 'Retry-After': '2' }))
    await expect(transport.request(read)).rejects.toMatchObject({ status: 429 })
    const result = transport.request(read)
    await jest.advanceTimersByTimeAsync(1999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toMatchObject({ attempts: 1 })
  })
})

describe('Retry-After grammar', () => {
  const now = Date.parse('1994-11-06T08:49:30Z')
  it.each([
    'Sun, 06 Nov 1994 08:49:37 GMT',
    'Sunday, 06-Nov-94 08:49:37 GMT',
    'Sun Nov  6 08:49:37 1994',
  ])('accepts HTTP-date %s', (value) => {
    expect(parseFortnoxRetryAfter(value, now)).toBe(7000)
  })
  it.each([null, '', '-1', '1.5', 'NaN', 'Infinity', '1e3', '2026-10-01', '1, 2', 'tomorrow'])(
    'rejects malformed value %s',
    (value) => {
      expect(parseFortnoxRetryAfter(value, now)).toBeUndefined()
    },
  )
  it('supports integer seconds, zero, past dates, and overflow without early retry', () => {
    expect(parseFortnoxRetryAfter(' 120 ', now)).toBe(120000)
    expect(parseFortnoxRetryAfter('0', now)).toBe(0)
    expect(parseFortnoxRetryAfter('Sun, 06 Nov 1994 08:49:29 GMT', now)).toBe(0)
    expect(parseFortnoxRetryAfter('9'.repeat(400), now)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

/** Regression cases from independent review R01–R04: check actual external effects. */
describe('FortnoxTransport review regressions', () => {
  it('R01 query getters cannot turn an allowed GET into a POST with writes disabled', async () => {
    const { transport, fetch } = fixture()
    const request: FortnoxTransportRequest = { ...read }
    request.query = {
      get page() {
        request.method = 'POST'
        request.body = { Voucher: {} }
        return 1
      },
    }
    await transport.request(request)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined()
  })

  it('R02 body.toJSON cannot change a validated POST into a DELETE', async () => {
    const { transport, fetch } = fixture({ allowVoucherWrites: true })
    const request: FortnoxTransportRequest = { ...write }
    request.body = {
      toJSON() {
        Object.assign(request, {
          method: 'DELETE',
          path: '/3/invoicepayments',
          accessToken: 'changed',
        })
        return { Voucher: { Description: 'serialized' } }
      },
    }
    await transport.request(request)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.fortnox.se/3/vouchers')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{"Voucher":{"Description":"serialized"}}',
    })
  })

  it.each(['query', 'top-level', 'toJSON', 'forged-error'])(
    'R03 %s exceptions are sanitized before dispatch',
    async (kind) => {
      const { transport, fetch } = fixture({ allowVoucherWrites: true })
      const secret = 'synthetic-secret-must-not-escape'
      const request = { ...write }
      const crash = () => {
        throw kind === 'forged-error'
          ? new FortnoxTransportError(secret as never, 'unknown', 999)
          : new Error(secret)
      }
      if (kind === 'top-level') Object.defineProperty(request, 'method', { get: crash })
      else if (kind === 'toJSON') request.body = { toJSON: crash }
      else
        request.query = {
          get financialyear() {
            return crash()
          },
        }
      const error: unknown = await transport.request(request).catch((caught: unknown) => caught)
      expect(error).toMatchObject({
        code: 'INVALID_REQUEST',
        outcome: 'not_sent',
        attempts: 0,
        reconciliationRequired: false,
      })
      expect(String(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(error).not.toHaveProperty('cause')
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, NaN, 200.5, '200', 99, 600, Infinity])(
    'R04 malformed status %s cannot become a successful POST receipt',
    async (status) => {
      const { transport, fetch } = fixture({ allowVoucherWrites: true })
      fetch.mockResolvedValueOnce({
        status,
        redirected: false,
        url: '',
        headers: new Headers(),
        json: async () => ({ Voucher: { VoucherNumber: 1 } }),
      } as unknown as Response)
      await expect(transport.request(write)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        outcome: 'unknown',
        reconciliationRequired: true,
        attempts: 1,
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('uses the validated status snapshot without re-reading a mutable response getter', async () => {
    const { transport, fetch } = fixture({ allowVoucherWrites: true })
    const getter = jest.fn().mockReturnValueOnce(201).mockReturnValue(500)
    const responseValue = response(201, {}, '{"Voucher":{"VoucherNumber":1}}')
    Object.defineProperty(responseValue, 'status', { get: getter })
    fetch.mockResolvedValueOnce(responseValue)
    await expect(transport.request(write)).resolves.toMatchObject({ status: 201, attempts: 1 })
    expect(getter).toHaveBeenCalledTimes(1)
  })
})
