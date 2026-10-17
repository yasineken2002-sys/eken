import { ReadableStream } from 'node:stream/web'
import {
  SPIRIS_MAX_RESPONSE_BYTES,
  SPIRIS_READ_TIMEOUT_MS,
  SpirisReadTransport,
  SpirisReadTransportError,
} from './spiris-read-transport'
import type {
  SpirisReadClock,
  SpirisReadFetch,
  SpirisReadTransportErrorCode,
} from './spiris-read-transport'
import { SpirisReadContractError } from './spiris-read-contract'

const TOKEN = 'synthetic-token-not-a-credential'
const SECRET = 'synthetic-secret-https://private.invalid/raw?token=do-not-expose'
const YEAR = 'abcdefab-1234-4567-89ab-abcdef012345'
const OTHER_YEAR = '00000000-1234-4567-89ab-abcdef012345'
const COMPANY_URL = 'https://eaccountingapi.vismaonline.com/v2/companysettings'
const company = { CompanyIdentifier: 'opaque-company', Name: 'Ångström AB', CountryCode: 'SE' }
const encoder = new TextEncoder()

function page<T>(Data: T[], current = 1, size = 100) {
  return {
    Data,
    Meta: {
      CurrentPage: current,
      PageSize: size,
      TotalNumberOfPages: current,
      TotalNumberOfResults: Data.length,
      ServerTimeUtc: '2026-10-17T12:00:00+02:00',
    },
  }
}
function response(
  url: string,
  body: ConstructorParameters<typeof Response>[0],
  status = 200,
  headers?: Record<string, string>,
) {
  const result = new Response(body, { status, ...(headers ? { headers } : {}) })
  // Native fetch supplies this metadata; new Response used by a synthetic port does not.
  Object.defineProperty(result, 'url', { value: url })
  return result
}
function json(url: string, value: unknown, status = 200) {
  return response(url, JSON.stringify(value), status)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(clock?: SpirisReadClock) {
  const fetch = jest.fn<ReturnType<SpirisReadFetch>, Parameters<SpirisReadFetch>>()
  fetch.mockImplementation(async (url) => json(url, company))
  return { fetch, transport: new SpirisReadTransport({ fetch, ...(clock ? { clock } : {}) }) }
}
async function failed(
  pending: Promise<unknown>,
  code: SpirisReadTransportErrorCode,
  status: number | null = null,
) {
  const outcome = await pending.then(
    (value) => ({ ok: true, value }) as const,
    (caught: unknown) => ({ ok: false, caught }) as const,
  )
  if (outcome.ok) throw new Error('Expected a terminal transport error')
  expect(outcome.caught).toBeInstanceOf(SpirisReadTransportError)
  expect(outcome.caught).toMatchObject({
    code,
    httpStatus: status,
    message: `Spiris read transport: ${code}`,
  })
  expect(outcome.caught).not.toHaveProperty('cause')
  expect(outcome.caught).not.toHaveProperty('response')
  expect(outcome.caught).not.toHaveProperty('body')
  expect(outcome.caught).not.toHaveProperty('url')
  expect(JSON.stringify(outcome.caught)).not.toContain(SECRET)
  if (outcome.caught instanceof Error) expect(outcome.caught.stack).not.toContain(SECRET)
  return outcome.caught
}
async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function streamed(chunks: Uint8Array[]) {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
}

/** Real Response/ReadableStream plus injected fetch only. No application boot,
 * credentials, provider calls, network, Redis or database. These are HTTP-boundary
 * tests, not evidence of company authorization or complete upstream pagination.
 */
describe('SpirisReadTransport', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    const timers = jest.getTimerCount()
    jest.useRealTimers()
    expect(timers).toBe(0)
  })

  it('uses only the fixed GET URL, Bearer and Accept, and returns the projected company', async () => {
    const { transport, fetch } = fixture()
    fetch.mockImplementation(async (url) => json(url, { ...company, RawCredential: SECRET }))
    await expect(transport.readCompanySettings(TOKEN)).resolves.toEqual(company)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(COMPANY_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
    expect(fetch.mock.calls[0]![0]).not.toContain(TOKEN)
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('body')
  })

  it('reads fiscal years and preserves UUID, dates and method without adding interpretation', async () => {
    const { transport, fetch } = fixture()
    const year = {
      Id: YEAR,
      StartDate: '2026-01-01T00:00:00+02:00',
      EndDate: '2026-12-31T23:59:59Z',
      BookkeepingMethod: 2,
    }
    fetch.mockImplementation(async (url) => json(url, page([year], 2, 3)))
    await expect(transport.readFiscalYears(TOKEN, { page: 2, pageSize: 3 })).resolves.toEqual(
      page([year], 2, 3),
    )
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://eaccountingapi.vismaonline.com/v2/fiscalyears?%24page=2&%24pagesize=3',
    )
  })

  it('snapshots requested year/page before fetch and retains account strings, order and inactive rows', async () => {
    const { transport, fetch } = fixture()
    const delayed = deferred<Response>()
    fetch.mockReturnValue(delayed.promise)
    const request = { page: 2, pageSize: 3 }
    let requestedYear = YEAR.toUpperCase()
    const pending = transport.readAccountsForYear(TOKEN, requestedYear, request)
    requestedYear = OTHER_YEAR
    request.page = 99
    request.pageSize = 1
    const accounts = [
      { FiscalYearId: YEAR, Number: '01930', Name: 'Bank', IsActive: false },
      { FiscalYearId: YEAR, Number: '01930', Name: 'Duplicate retained', IsActive: true },
    ]
    const expectedUrl = `https://eaccountingapi.vismaonline.com/v2/accounts/${YEAR.toUpperCase()}?%24page=2&%24pagesize=3`
    delayed.resolve(json(expectedUrl, page(accounts, 2, 3)))
    await expect(pending).resolves.toEqual(page(accounts, 2, 3))
    expect(fetch.mock.calls[0]![0]).toBe(expectedUrl)
    expect(requestedYear).toBe(OTHER_YEAR)
  })

  it.each(['', 'space token', 'token\n', 'token\r\nInjected: value', { token: TOKEN }])(
    'rejects invalid bearer syntax before fetch: %p',
    async (token) => {
      const { transport, fetch } = fixture()
      await failed(transport.readCompanySettings(token), 'INVALID_REQUEST')
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('rejects invalid year and page at the existing builder boundary before fetch', async () => {
    const { transport, fetch } = fixture()
    await failed(transport.readAccountsForYear(TOKEN, '../companysettings'), 'INVALID_REQUEST')
    await failed(transport.readFiscalYears(TOKEN, { page: 1, pageSize: 1001 }), 'INVALID_REQUEST')
    await failed(
      transport.readFiscalYears(TOKEN, { page: 1, pageSize: 2, url: SECRET }),
      'INVALID_REQUEST',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([204, 301, 401, 403, 429, 500])(
    'rejects HTTP %i without retry, body parsing or error-body leakage',
    async (status) => {
      const { transport, fetch } = fixture()
      const cancel = jest.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      fetch.mockImplementation(async (url) => response(url, status === 204 ? null : body, status))
      await failed(transport.readCompanySettings(TOKEN), 'HTTP_ERROR', status)
      expect(fetch).toHaveBeenCalledTimes(1)
      if (status !== 204) expect(cancel).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['', 'https://private.invalid/v2/companysettings', `${COMPANY_URL}?extra=1`])(
    'rejects mismatching response URL %p',
    async (returnedUrl) => {
      const { transport, fetch } = fixture()
      fetch.mockResolvedValue(json(returnedUrl, company))
      await failed(transport.readCompanySettings(TOKEN), 'INVALID_RESPONSE', 200)
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects an already followed redirect even if its final URL matches', async () => {
    const { transport, fetch } = fixture()
    const returned = json(COMPANY_URL, company)
    Object.defineProperty(returned, 'redirected', { value: true })
    fetch.mockResolvedValue(returned)
    await failed(transport.readCompanySettings(TOKEN), 'INVALID_RESPONSE', 200)
  })

  it('does not follow Link headers or infer completion from an empty page', async () => {
    const { transport, fetch } = fixture()
    const value = page([], 8, 2)
    value.Meta.TotalNumberOfPages = 0
    fetch.mockImplementation(async (url) =>
      response(url, JSON.stringify(value), 200, { Link: `<${SECRET}>; rel="next"` }),
    )
    await expect(transport.readFiscalYears(TOKEN, { page: 8, pageSize: 2 })).resolves.toEqual(value)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['not-json-' + SECRET, JSON.stringify({ CompanyIdentifier: SECRET })])(
    'masks invalid successful body %p',
    async (value) => {
      const { transport, fetch } = fixture()
      fetch.mockImplementation(async (url) => response(url, value))
      await failed(transport.readCompanySettings(TOKEN), 'INVALID_RESPONSE', 200)
    },
  )

  it('preserves the parser YEAR_MISMATCH code without the foreign body', async () => {
    const { transport, fetch } = fixture()
    fetch.mockImplementation(async (url) =>
      json(url, page([{ FiscalYearId: OTHER_YEAR, Number: '1930', Name: SECRET, IsActive: true }])),
    )
    await failed(transport.readAccountsForYear(TOKEN, YEAR), 'YEAR_MISMATCH', 200)
  })

  it.each(['throw', 'reject', 'forged-contract'] as const)(
    'masks fetch %s and performs no retry',
    async (kind) => {
      const { transport, fetch } = fixture()
      fetch.mockImplementation(() => {
        if (kind === 'throw') throw new Error(SECRET)
        if (kind === 'forged-contract')
          return Promise.reject(new SpirisReadContractError('YEAR_MISMATCH', 499))
        return Promise.reject(new Error(SECRET))
      })
      await failed(transport.readCompanySettings(TOKEN), 'NETWORK_ERROR')
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('masks response metadata getters and cancels its already obtained body', async () => {
    const { transport, fetch } = fixture()
    const cancel = jest.fn()
    const returned = response(COMPANY_URL, new ReadableStream<Uint8Array>({ cancel }))
    Object.defineProperty(returned, 'status', {
      get() {
        throw new Error(SECRET)
      },
    })
    fetch.mockResolvedValue(returned)
    await failed(transport.readCompanySettings(TOKEN), 'INVALID_RESPONSE')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('masks a real stream error and releases the reader lock', async () => {
    const { transport, fetch } = fixture()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(SECRET))
      },
    })
    fetch.mockResolvedValue(response(COMPANY_URL, body))
    await failed(transport.readCompanySettings(TOKEN), 'INVALID_RESPONSE', 200)
    expect(body.locked).toBe(false)
  })

  it('rejects a pre-aborted signal without sending and never exposes its reason', async () => {
    const { transport, fetch } = fixture()
    const controller = new AbortController()
    controller.abort(new Error(SECRET))
    await failed(transport.readCompanySettings(TOKEN, controller.signal), 'CANCELLED')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('detaches the external abort listener on success', async () => {
    const { transport } = fixture()
    const controller = new AbortController()
    const remove = jest.spyOn(EventTarget.prototype, 'removeEventListener')
    await expect(transport.readCompanySettings(TOKEN, controller.signal)).resolves.toEqual(company)
    expect(remove.mock.instances).toContain(controller.signal)
    expect(remove.mock.calls.some(([type]) => type === 'abort')).toBe(true)
    controller.abort(new Error(SECRET))
  })

  it('terminates a signal-ignoring fetch on the shared deadline and cancels its late response', async () => {
    const { transport, fetch } = fixture()
    const delayed = deferred<Response>()
    const cancel = jest.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const getReader = jest.spyOn(body, 'getReader')
    fetch.mockReturnValue(delayed.promise)
    const checked = failed(transport.readCompanySettings(TOKEN), 'TIMEOUT')
    await jest.advanceTimersByTimeAsync(SPIRIS_READ_TIMEOUT_MS)
    await checked
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true)
    delayed.resolve(response(COMPANY_URL, body))
    await drain()
    expect(getReader).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('consumes a late fetch rejection after cancellation rather than restoring success or leaking it', async () => {
    const { transport, fetch } = fixture()
    const delayed = deferred<Response>()
    const controller = new AbortController()
    fetch.mockReturnValue(delayed.promise)
    const checked = failed(transport.readCompanySettings(TOKEN, controller.signal), 'CANCELLED')
    controller.abort(new Error(SECRET))
    await checked
    delayed.reject(new Error(SECRET))
    await drain()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shares one deadline between delayed fetch and all stream reads', async () => {
    const { transport, fetch } = fixture()
    const delayed = deferred<Response>()
    const cancel = jest.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    fetch.mockReturnValue(delayed.promise)
    const checked = failed(transport.readCompanySettings(TOKEN), 'TIMEOUT')
    await jest.advanceTimersByTimeAsync(6_000)
    delayed.resolve(response(COMPANY_URL, body))
    await drain()
    expect(body.locked).toBe(true)
    await jest.advanceTimersByTimeAsync(3_999)
    expect(cancel).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await checked
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  it.each(['throw', 'reject', 'never'] as const)(
    'does not wait for a locked reader cancel that can %s',
    async (kind) => {
      const { transport, fetch } = fixture()
      const cancel = jest.fn(() => {
        if (kind === 'throw') throw new Error(SECRET)
        if (kind === 'reject') return Promise.reject(new Error(SECRET))
        return new Promise<void>(() => undefined)
      })
      const body = new ReadableStream<Uint8Array>({ cancel })
      const bodyCancel = jest.spyOn(body, 'cancel')
      fetch.mockResolvedValue(response(COMPANY_URL, body))
      const checked = failed(transport.readCompanySettings(TOKEN), 'TIMEOUT')
      await drain()
      expect(body.locked).toBe(true)
      await jest.advanceTimersByTimeAsync(SPIRIS_READ_TIMEOUT_MS)
      await checked
      await drain()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(bodyCancel).not.toHaveBeenCalled()
      expect(body.locked).toBe(false)
    },
  )

  it('does not resume body consumption when an abort-ignoring source finishes after cancellation', async () => {
    const { transport, fetch } = fixture()
    const source = deferred<void>()
    const cancel = jest.fn()
    const pull = jest.fn(() => source.promise)
    const body = new ReadableStream<Uint8Array>({ pull, cancel })
    const controller = new AbortController()
    const returned = response(COMPANY_URL, body)
    const jsonMethod = jest.spyOn(returned, 'json')
    fetch.mockResolvedValue(returned)
    const checked = failed(transport.readCompanySettings(TOKEN, controller.signal), 'CANCELLED')
    await drain()
    expect(body.locked).toBe(true)
    expect(pull).toHaveBeenCalledTimes(1)
    controller.abort(new Error(SECRET))
    await checked
    source.resolve()
    await drain()
    expect(pull).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(jsonMethod).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
  })

  it('uses actual bytes at exactly 2 MiB without response.json/text or trusting Content-Length', async () => {
    const { transport, fetch } = fixture()
    const encoded = encoder.encode(JSON.stringify(company))
    const padding = new Uint8Array(SPIRIS_MAX_RESPONSE_BYTES - encoded.byteLength).fill(32)
    const body = streamed([encoded, padding])
    const returned = response(COMPANY_URL, body, 200, {
      'Content-Length': String(SPIRIS_MAX_RESPONSE_BYTES * 4),
    })
    const jsonMethod = jest.spyOn(returned, 'json')
    const textMethod = jest.spyOn(returned, 'text')
    fetch.mockResolvedValue(returned)
    await expect(transport.readCompanySettings(TOKEN)).resolves.toEqual(company)
    expect(jsonMethod).not.toHaveBeenCalled()
    expect(textMethod).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
  })

  it('rejects actual 2 MiB + 1 bytes even with Content-Length 1', async () => {
    const { transport, fetch } = fixture()
    const encoded = encoder.encode(JSON.stringify(company))
    const padding = new Uint8Array(SPIRIS_MAX_RESPONSE_BYTES + 1 - encoded.byteLength).fill(32)
    fetch.mockResolvedValue(
      response(COMPANY_URL, streamed([encoded, padding]), 200, { 'Content-Length': '1' }),
    )
    await failed(transport.readCompanySettings(TOKEN), 'RESPONSE_TOO_LARGE', 200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves multibyte UTF-8 split across chunks while enforcing byte rather than character size', async () => {
    const { transport, fetch } = fixture()
    const encoded = encoder.encode(JSON.stringify(company))
    const split = encoded.findIndex((value) => value >= 128) + 1
    fetch.mockResolvedValue(
      response(COMPANY_URL, streamed([encoded.slice(0, split), encoded.slice(split)])),
    )
    await expect(transport.readCompanySettings(TOKEN)).resolves.toEqual(company)
    // Unknown upstream content is projected away, but it still counts against the wire limit.
    const large = encoder.encode(
      JSON.stringify({ ...company, Unknown: 'å'.repeat(SPIRIS_MAX_RESPONSE_BYTES / 2) }),
    )
    expect(large.byteLength).toBeGreaterThan(SPIRIS_MAX_RESPONSE_BYTES)
    fetch.mockResolvedValue(response(COMPANY_URL, streamed([large])))
    await failed(transport.readCompanySettings(TOKEN), 'RESPONSE_TOO_LARGE', 200)
  })

  it('rejects malformed UTF-8 rather than accepting replacement characters', async () => {
    const { transport, fetch } = fixture()
    fetch.mockResolvedValue(response(COMPANY_URL, streamed([new Uint8Array([0xc3, 0x28])])))
    await failed(transport.readCompanySettings(TOKEN), 'INVALID_RESPONSE', 200)
  })

  it('checks monotonic time after synchronous JSON parsing before a successful projection can escape', async () => {
    let now = 0
    const clock: SpirisReadClock = {
      now: () => now,
      schedule(callback, ms) {
        const timer = setTimeout(callback, ms)
        return () => clearTimeout(timer)
      },
    }
    const { transport, fetch } = fixture(clock)
    const returned = json(COMPANY_URL, company)
    fetch.mockResolvedValue(returned)
    const original = JSON.parse
    const spy = jest.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      const result: unknown = original(text)
      now = SPIRIS_READ_TIMEOUT_MS
      return result
    })
    let caught: unknown
    try {
      caught = await transport.readCompanySettings(TOKEN).catch((cause: unknown) => cause)
    } finally {
      spy.mockRestore()
    }
    expect(caught).toBeInstanceOf(SpirisReadTransportError)
    expect(caught).toMatchObject({ code: 'TIMEOUT', httpStatus: null })
  })
})
