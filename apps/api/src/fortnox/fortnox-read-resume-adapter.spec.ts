import {
  FortnoxCredentialBindingError,
  FortnoxNotConnectedError,
  type FortnoxBoundCredential,
  type FortnoxConnectionService,
  type FortnoxCredentialBinding,
} from './fortnox-connection.service'
import { FortnoxResumeReadAdapter } from './fortnox-read-resume-adapter'
import { ResumeBindingError } from './fortnox-read-resume-driver'
import type { SourceResumeScope } from './fortnox-read-source-run.service'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'
import { FortnoxRateIdentity } from './provider/fortnox-rate-limiter'
import { FortnoxTransport } from './provider/fortnox-transport'
import type { FortnoxClock, FortnoxRateLimiter } from './provider/fortnox-transport.types'

type Connections = Pick<FortnoxConnectionService, 'boundAccessToken'>
type ReadArgs = [token: string, path: string, query?: Readonly<Record<string, string | number>>]
const BINDING: FortnoxCredentialBinding = {
  organizationId: 'synthetic-adapter-org-a',
  connectionId: 'synthetic-adapter-connection-a',
  connectionGeneration: 4,
  fortnoxDatabaseNumber: 900002,
  fortnoxOrgNumber: null,
}
const SCOPE: SourceResumeScope = {
  ...BINDING,
  runId: 'synthetic-run-a',
  sourceCaptureId: 'synthetic-source-a',
  requestHash: 'synthetic-request-a',
  financialYear: { id: 2, fromDate: '2025-07-01', toDate: '2026-06-30' },
}
const OTHER_BINDING: FortnoxCredentialBinding = {
  organizationId: 'synthetic-adapter-org-b',
  connectionId: 'synthetic-adapter-connection-b',
  connectionGeneration: 9,
  fortnoxDatabaseNumber: 900003,
  fortnoxOrgNumber: 'synthetic-company-b',
}
const OTHER_SCOPE: SourceResumeScope = {
  ...OTHER_BINDING,
  runId: 'synthetic-run-b',
  sourceCaptureId: 'synthetic-source-b',
  requestHash: 'synthetic-request-b',
  financialYear: { id: 3, fromDate: '2026-01-01', toDate: '2026-12-31' },
}
const TOKEN_A = 'synthetic-adapter-token-a'
const TOKEN_NEXT = 'synthetic-adapter-token-next'

// Mutable return deliberately represents an injected port whose later mutations must not leak.
function credential(token = TOKEN_A, tokenVersion = 7, binding = BINDING) {
  return { token, tokenVersion, binding: { ...binding } }
}
function port() {
  return {
    boundAccessToken: jest
      .fn<Promise<FortnoxBoundCredential>, Parameters<Connections['boundAccessToken']>>()
      .mockRejectedValue(new Error('Unexpected credential resolution')),
  } satisfies Connections
}
function rig() {
  const connections = port()
  connections.boundAccessToken.mockResolvedValueOnce(credential())
  const get = jest.fn<Promise<unknown>, ReadArgs>().mockRejectedValue(new Error('Unexpected GET'))
  // Only the generic reader boundary casts T; arguments and observable results stay typed.
  const reader: FortnoxLedgerReader = {
    get: <T>(...args: ReadArgs) => get(...args) as Promise<T>,
  }
  const adapter = new FortnoxResumeReadAdapter(connections, reader)
  return { connections, get, adapter }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Synthetic adapter barrier did not settle')),
          2000,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
async function reached(signal: Promise<void>, operation: Promise<unknown>) {
  await bounded(
    Promise.race([
      signal,
      operation.then(() => {
        throw new Error('Adapter operation settled before barrier')
      }),
    ]),
  )
}
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}
function transportRig(clock?: FortnoxClock) {
  const connections = port()
  connections.boundAccessToken.mockResolvedValueOnce(credential())
  const fetch = jest
    .fn<ReturnType<typeof globalThis.fetch>, Parameters<typeof globalThis.fetch>>()
    .mockRejectedValue(new Error('Unexpected fetch'))
  const limiter: jest.Mocked<FortnoxRateLimiter> = {
    acquire: jest.fn().mockResolvedValue(undefined),
    defer: jest.fn().mockResolvedValue(undefined),
  }
  const identity = new FortnoxRateIdentity()
  // Synthetic credential registration only; the separate DB spec exercises actual service binding.
  identity.bind(TOKEN_A, 900002)
  identity.bind(TOKEN_NEXT, 900002)
  const transport = new FortnoxTransport({
    fetch,
    rateLimiter: limiter,
    ...(clock ? { clock } : {}),
  })
  const reader = new RealFortnoxLedgerReader({
    transport,
    clientId: 'synthetic-adapter-client',
    identity,
    enabled: true,
  })
  return { adapter: new FortnoxResumeReadAdapter(connections, reader), connections, fetch, limiter }
}

/** Pure adapter and injected-transport proofs: no real credentials, provider, Redis or DB. */
describe('FortnoxResumeReadAdapter', () => {
  afterEach(() => jest.restoreAllMocks())

  it('uses literal year2/company900002 GET routes and preserves the complete envelope, Voucher and absence', async () => {
    const r = transportRig()
    const envelope = {
      MetaInformation: { '@CurrentPage': 2, '@TotalPages': 3, '@TotalResources': 101 },
      Vouchers: [{ Year: 2, VoucherSeries: 'A7', VoucherNumber: 0, Extra: 'Å🦉' }],
      Untouched: { empty: null, ordered: ['b', 'a', 'a'] },
    }
    const voucher = {
      Year: 2,
      VoucherSeries: 'A7',
      VoucherNumber: 0,
      Extra: { text: 'Å🦉', empty: null },
    }
    r.fetch
      .mockResolvedValueOnce(response(envelope))
      .mockResolvedValueOnce(response({ Voucher: voucher, EnvelopeExtra: 'discarded' }))
      .mockResolvedValueOnce(response({ Voucher: { VoucherNumber: 9007199254740992 } }))
      .mockResolvedValueOnce(response({ Untouched: true }))
    const session = await r.adapter.open(SCOPE)
    // Native Response.json() may cross Jest realms; compare every JSON value, not prototypes.
    await expect(session.readManifestPage(2)).resolves.toEqual(envelope)
    await expect(session.readVoucher('2|A7|0')).resolves.toEqual(voucher)
    await expect(session.readVoucher('2|A7|9007199254740992')).resolves.toEqual({
      VoucherNumber: 9007199254740992,
    })
    await expect(session.readVoucher('2|A7|1')).resolves.toBeUndefined()
    expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(1)
    expect(r.connections.boundAccessToken.mock.calls[0]?.[0]).toStrictEqual(BINDING)
    expect(r.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.fortnox.se/3/vouchers/sublist?financialyear=2&page=2&limit=100',
      'https://api.fortnox.se/3/vouchers/A7/0?financialyear=2',
      'https://api.fortnox.se/3/vouchers/A7/9007199254740992?financialyear=2',
      'https://api.fortnox.se/3/vouchers/A7/1?financialyear=2',
    ])
    for (const [, init] of r.fetch.mock.calls) {
      expect(init).toEqual({
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN_A}`, Accept: 'application/json' },
        signal: expect.any(AbortSignal),
        redirect: 'error',
      })
    }
    expect(r.limiter.acquire.mock.calls.map(([key]) => key)).toEqual(
      Array(4).fill('fortnox:synthetic-adapter-client:db900002'),
    )
    expect(r.limiter.defer).not.toHaveBeenCalled()
  })

  it('rejects malformed scope/year with masked binding error before resolving credentials', async () => {
    const r = rig()
    const bad: unknown[] = [
      undefined,
      null,
      [],
      {},
      ...['runId', 'sourceCaptureId', 'requestHash'].map((key) => ({ ...SCOPE, [key]: '' })),
      { ...SCOPE, financialYear: null },
      { ...SCOPE, financialYear: [] },
      { ...SCOPE, financialYear: {} },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'].map((id) => ({
        ...SCOPE,
        financialYear: { ...SCOPE.financialYear, id },
      })),
      { ...SCOPE, financialYear: { ...SCOPE.financialYear, fromDate: '2026-02-30' } },
      { ...SCOPE, financialYear: { ...SCOPE.financialYear, toDate: '2025-06-30' } },
    ]
    for (const scope of bad) {
      const operation = r.adapter.open(scope as SourceResumeScope)
      await expect(operation).rejects.toBeInstanceOf(ResumeBindingError)
      await expect(operation).rejects.toMatchObject({
        message: 'Läsaren matchar inte det frysta Fortnox-underlaget',
      })
    }
    expect(r.connections.boundAccessToken).not.toHaveBeenCalled()
    expect(r.get).not.toHaveBeenCalled()
  })

  it('rejects invalid page/key routes before inner GET without imposing a new voucher safe-int rule', async () => {
    const r = rig()
    const session = await r.adapter.open(SCOPE)
    const pages: unknown[] = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]
    const keys: unknown[] = [
      null,
      2,
      '',
      '2|A7',
      '2|A7|1|x',
      '3|A7|1',
      '02|A7|1',
      '2||1',
      '2|A-7|1',
      '2|ABCDEFGHIJK|1',
      '2|A/7|1',
      '2|A%2f7|1',
      '2|A7|-1',
      '2|A7|+1',
      '2|A7|01',
      '2|A7|1.0',
      '2|A7|1e+21',
      '2|A7|1/2',
      '2|A7|%31',
      '2|A7|9007199254740993',
    ]
    for (const page of pages)
      await expect(session.readManifestPage(page as number)).rejects.toMatchObject({
        name: 'FortnoxReadError',
        kind: 'invalid',
      })
    for (const key of keys)
      await expect(session.readVoucher(key as string)).rejects.toMatchObject({
        name: 'FortnoxReadError',
        kind: 'invalid',
      })
    expect(r.get).not.toHaveBeenCalled()
    expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(1)
  })

  it('snapshots scope/year before awaiting open and owns a private copy of the returned credential', async () => {
    const r = rig(),
      pending = deferred<FortnoxBoundCredential>()
    const input = { ...SCOPE, financialYear: { ...SCOPE.financialYear } }
    const returned = credential()
    r.connections.boundAccessToken.mockReset().mockReturnValueOnce(pending.promise)
    const operation = r.adapter.open(input)
    const settled = Promise.allSettled([operation])
    try {
      expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(1)
      Object.assign(input.financialYear, OTHER_SCOPE.financialYear)
      Object.assign(input, OTHER_SCOPE)
      input.financialYear = { ...OTHER_SCOPE.financialYear }
      pending.resolve(returned)
      const session = await bounded(operation)
      returned.token = 'mutated-token'
      returned.tokenVersion = 999
      Object.assign(returned.binding, OTHER_BINDING)
      expect(session.binding).toStrictEqual(SCOPE)
      expect(session.binding).not.toBe(input)
      expect(Object.isFrozen(session)).toBe(true)
      expect(Object.isFrozen(session.binding)).toBe(true)
      expect(Object.isFrozen(session.binding.financialYear)).toBe(true)
      expect(Object.keys(session).sort()).toEqual(['binding', 'readManifestPage', 'readVoucher'])
      expect(r.connections.boundAccessToken.mock.calls[0]?.[0]).toStrictEqual(BINDING)
      r.connections.boundAccessToken.mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
      r.get
        .mockRejectedValueOnce(new FortnoxReadError('auth', 401))
        .mockResolvedValueOnce({ Vouchers: [] })
      await expect(session.readManifestPage(1)).resolves.toStrictEqual({ Vouchers: [] })
      expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(2)
      expect(r.connections.boundAccessToken).toHaveBeenNthCalledWith(2, BINDING, {
        afterUnauthorizedVersion: 7,
      })
      expect(r.get.mock.calls).toEqual([
        [TOKEN_A, '/3/vouchers/sublist', { financialyear: 2, page: 1, limit: 100 }],
        [TOKEN_NEXT, '/3/vouchers/sublist', { financialyear: 2, page: 1, limit: 100 }],
      ])
    } finally {
      pending.resolve(returned)
      await settled
    }
  })

  it.each(['open', 'refresh'] as const)(
    'checks all five returned binding fields at %s before the corresponding GET',
    async (phase) => {
      const changes: Array<Partial<FortnoxCredentialBinding>> = [
        { organizationId: 'foreign-org' },
        { connectionId: 'foreign-connection' },
        { connectionGeneration: 5 },
        { fortnoxDatabaseNumber: 900003 },
        { fortnoxOrgNumber: '' },
      ]
      for (const change of changes) {
        const r = rig(),
          bad = credential(TOKEN_NEXT, 8, { ...BINDING, ...change })
        if (phase === 'open') r.connections.boundAccessToken.mockReset().mockResolvedValueOnce(bad)
        else {
          r.connections.boundAccessToken.mockResolvedValueOnce(bad)
          r.get.mockRejectedValueOnce(new FortnoxReadError('auth', 401))
        }
        const operation = r.adapter.open(SCOPE).then((session) => session.readManifestPage(1))
        await expect(operation).rejects.toBeInstanceOf(ResumeBindingError)
        expect(r.get).toHaveBeenCalledTimes(phase === 'open' ? 0 : 1)
        expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(phase === 'open' ? 1 : 2)
      }
    },
  )

  it('retries one auth failure with the used version and identical private path/query', async () => {
    const r = rig(),
      result = { Voucher: { Year: 2, VoucherSeries: 'A7', VoucherNumber: 0 } }
    r.connections.boundAccessToken.mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
    r.get.mockRejectedValueOnce(new FortnoxReadError('auth', 401)).mockResolvedValueOnce(result)
    const session = await r.adapter.open(SCOPE)
    await expect(session.readVoucher('2|A7|0')).resolves.toBe(result.Voucher)
    expect(r.connections.boundAccessToken).toHaveBeenNthCalledWith(2, BINDING, {
      afterUnauthorizedVersion: 7,
    })
    expect(r.get.mock.calls).toEqual([
      [TOKEN_A, '/3/vouchers/A7/0', { financialyear: 2 }],
      [TOKEN_NEXT, '/3/vouchers/A7/0', { financialyear: 2 }],
    ])
    expect(r.get.mock.calls[1]?.[2]).toBe(r.get.mock.calls[0]?.[2])
    expect(Object.isFrozen(r.get.mock.calls[0]?.[2])).toBe(true)
    expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(2)
  })

  it('preserves non-auth first-GET error identity without another credential resolution', async () => {
    const errors = [
      new FortnoxReadError('forbidden', 403),
      new FortnoxReadError('invalid', 404),
      new FortnoxReadError('transient', 503),
      new Error('synthetic reader failure'),
    ]
    for (const original of errors) {
      const r = rig()
      r.get.mockRejectedValueOnce(original)
      const session = await r.adapter.open(SCOPE)
      await expect(session.readManifestPage(1)).rejects.toBe(original)
      expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(1)
      expect(r.get).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['open', 'refresh'] as const)(
    'preserves credential error identity at %s without masking or fallback',
    async (phase) => {
      const errors = [
        new FortnoxCredentialBindingError(),
        new FortnoxNotConnectedError('REFRESH_IN_PROGRESS'),
        new FortnoxNotConnectedError('REFRESH_RATE_LIMITED'),
        new Error('synthetic DB or crypto failure'),
      ]
      for (const original of errors) {
        const r = rig()
        if (phase === 'open')
          r.connections.boundAccessToken.mockReset().mockRejectedValueOnce(original)
        else {
          r.connections.boundAccessToken.mockRejectedValueOnce(original)
          r.get.mockRejectedValueOnce(new FortnoxReadError('auth', 401))
        }
        await expect(r.adapter.open(SCOPE).then((s) => s.readManifestPage(1))).rejects.toBe(
          original,
        )
        expect(r.get).toHaveBeenCalledTimes(phase === 'open' ? 0 : 1)
        expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(phase === 'open' ? 1 : 2)
      }
    },
  )

  it('preserves second-GET errors, including a second401, without a third GET or resolution', async () => {
    for (const original of [
      new FortnoxReadError('auth', 401),
      new FortnoxReadError('forbidden', 403),
      new Error('synthetic retry failure'),
    ]) {
      const r = rig()
      r.connections.boundAccessToken.mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
      r.get.mockRejectedValueOnce(new FortnoxReadError('auth', 401)).mockRejectedValueOnce(original)
      const session = await r.adapter.open(SCOPE)
      await expect(session.readManifestPage(1)).rejects.toBe(original)
      expect(r.get).toHaveBeenCalledTimes(2)
      expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(2)
    }
  })

  it('repeated use of one session keeps its initial token and version rather than caching a refresh', async () => {
    const r = rig()
    r.connections.boundAccessToken
      .mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
      .mockResolvedValueOnce(credential('synthetic-third', 9))
    r.get
      .mockRejectedValueOnce(new FortnoxReadError('auth', 401))
      .mockResolvedValueOnce({ first: true })
      .mockRejectedValueOnce(new FortnoxReadError('auth', 401))
      .mockResolvedValueOnce({ second: true })
    const session = await r.adapter.open(SCOPE)
    await expect(session.readManifestPage(1)).resolves.toEqual({ first: true })
    await expect(session.readManifestPage(2)).resolves.toEqual({ second: true })
    expect(r.get.mock.calls.map(([token]) => token)).toEqual([
      TOKEN_A,
      TOKEN_NEXT,
      TOKEN_A,
      'synthetic-third',
    ])
    expect(r.connections.boundAccessToken.mock.calls.slice(1)).toEqual([
      [BINDING, { afterUnauthorizedVersion: 7 }],
      [BINDING, { afterUnauthorizedVersion: 7 }],
    ])
  })

  it('a late401 in the same session uses its own sent version after another operation has refreshed', async () => {
    const r = rig(),
      entered = deferred<void>(),
      late = deferred<unknown>()
    const lateSettled = Promise.allSettled([late.promise])
    r.connections.boundAccessToken
      .mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
      .mockResolvedValueOnce(credential('synthetic-third', 9))
    r.get
      .mockImplementationOnce(() => {
        entered.resolve()
        return late.promise
      })
      .mockRejectedValueOnce(new FortnoxReadError('auth', 401))
      .mockResolvedValueOnce({ page: 2 })
      .mockResolvedValueOnce({ page: 1 })
    const session = await r.adapter.open(SCOPE)
    const first = session.readManifestPage(1)
    const settled = Promise.allSettled([first])
    let second: Promise<unknown> | undefined
    try {
      await reached(entered.promise, first)
      second = session.readManifestPage(2)
      await expect(bounded(second)).resolves.toEqual({ page: 2 })
      late.reject(new FortnoxReadError('auth', 401))
      await expect(bounded(first)).resolves.toEqual({ page: 1 })
      expect(r.connections.boundAccessToken.mock.calls.slice(1)).toEqual([
        [BINDING, { afterUnauthorizedVersion: 7 }],
        [BINDING, { afterUnauthorizedVersion: 7 }],
      ])
      expect(r.get.mock.calls).toEqual([
        [TOKEN_A, '/3/vouchers/sublist', { financialyear: 2, page: 1, limit: 100 }],
        [TOKEN_A, '/3/vouchers/sublist', { financialyear: 2, page: 2, limit: 100 }],
        [TOKEN_NEXT, '/3/vouchers/sublist', { financialyear: 2, page: 2, limit: 100 }],
        ['synthetic-third', '/3/vouchers/sublist', { financialyear: 2, page: 1, limit: 100 }],
      ])
    } finally {
      late.reject(new Error('Synthetic late-read cleanup'))
      await Promise.allSettled([settled, lateSettled, ...(second ? [second] : [])])
    }
  })

  it('keeps independent sessions separate across reversed open completion and late401', async () => {
    const r = rig(),
      openA = deferred<FortnoxBoundCredential>(),
      entered = deferred<void>(),
      lateA = deferred<unknown>()
    const lateSettled = Promise.allSettled([lateA.promise])
    r.connections.boundAccessToken
      .mockReset()
      .mockReturnValueOnce(openA.promise)
      .mockResolvedValueOnce(credential('synthetic-b', 19, OTHER_BINDING))
      .mockResolvedValueOnce(credential('synthetic-b-next', 20, OTHER_BINDING))
      .mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
    r.get
      .mockImplementationOnce(() => {
        entered.resolve()
        return lateA.promise
      })
      .mockRejectedValueOnce(new FortnoxReadError('auth', 401))
      .mockResolvedValueOnce({ org: 'B' })
      .mockResolvedValueOnce({ org: 'A' })
    const pendingA = r.adapter.open(SCOPE)
    const settledOpen = Promise.allSettled([pendingA])
    let a: Promise<unknown> | undefined, b: Promise<unknown> | undefined
    let pendingB: ReturnType<typeof r.adapter.open> | undefined
    try {
      pendingB = r.adapter.open(OTHER_SCOPE)
      const sessionB = await bounded(pendingB)
      openA.resolve(credential())
      const sessionA = await bounded(pendingA)
      expect(sessionA.binding).toStrictEqual(SCOPE)
      expect(sessionB.binding).toStrictEqual(OTHER_SCOPE)
      a = sessionA.readManifestPage(1)
      await reached(entered.promise, a)
      b = sessionB.readManifestPage(4)
      await expect(bounded(b)).resolves.toEqual({ org: 'B' })
      lateA.reject(new FortnoxReadError('auth', 401))
      await expect(bounded(a)).resolves.toEqual({ org: 'A' })
      expect(r.connections.boundAccessToken.mock.calls.map(([binding]) => binding)).toEqual([
        BINDING,
        OTHER_BINDING,
        OTHER_BINDING,
        BINDING,
      ])
      expect(r.connections.boundAccessToken.mock.calls.slice(2)).toEqual([
        [OTHER_BINDING, { afterUnauthorizedVersion: 19 }],
        [BINDING, { afterUnauthorizedVersion: 7 }],
      ])
      expect(r.get.mock.calls).toEqual([
        [TOKEN_A, '/3/vouchers/sublist', { financialyear: 2, page: 1, limit: 100 }],
        ['synthetic-b', '/3/vouchers/sublist', { financialyear: 3, page: 4, limit: 100 }],
        ['synthetic-b-next', '/3/vouchers/sublist', { financialyear: 3, page: 4, limit: 100 }],
        [TOKEN_NEXT, '/3/vouchers/sublist', { financialyear: 2, page: 1, limit: 100 }],
      ])
    } finally {
      openA.resolve(credential())
      lateA.reject(new Error('Synthetic cross-session cleanup'))
      await Promise.allSettled([
        settledOpen,
        lateSettled,
        ...(pendingB ? [pendingB] : []),
        ...(a ? [a] : []),
        ...(b ? [b] : []),
      ])
    }
  })

  it('composes500→401 and429→200 as four fetches, two GET legs and one auth retry in the same company bucket', async () => {
    let now = 0
    const scheduled = new Set<() => void>()
    const sleep = jest.fn(async (milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error('Synthetic clock aborted')
      now += milliseconds
    })
    const clock: FortnoxClock = {
      now: () => now,
      sleep,
      schedule: (callback) => {
        scheduled.add(callback)
        return () => {
          scheduled.delete(callback)
        }
      },
    }
    // Logical retry clock only: this test does not prove transport deadlines or physical cancellation.
    const r = transportRig(clock)
    r.connections.boundAccessToken.mockResolvedValueOnce(credential(TOKEN_NEXT, 8))
    r.fetch
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({}, 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(response({ Vouchers: [], MetaInformation: { '@CurrentPage': 1 } }))
    const session = await r.adapter.open(SCOPE)
    await expect(session.readManifestPage(1)).resolves.toEqual({
      Vouchers: [],
      MetaInformation: { '@CurrentPage': 1 },
    })
    expect(r.connections.boundAccessToken).toHaveBeenCalledTimes(2)
    expect(r.connections.boundAccessToken).toHaveBeenNthCalledWith(2, BINDING, {
      afterUnauthorizedVersion: 7,
    })
    expect(r.fetch.mock.calls.map(([url]) => url)).toEqual(
      Array(4).fill('https://api.fortnox.se/3/vouchers/sublist?financialyear=2&page=1&limit=100'),
    )
    expect(
      r.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')),
    ).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_NEXT}`,
      `Bearer ${TOKEN_NEXT}`,
    ])
    expect(r.limiter.acquire.mock.calls.map(([key]) => key)).toEqual(
      Array(4).fill('fortnox:synthetic-adapter-client:db900002'),
    )
    expect(r.limiter.defer.mock.calls).toEqual([
      ['fortnox:synthetic-adapter-client:db900002', 500],
      ['fortnox:synthetic-adapter-client:db900002', 1000],
    ])
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1000])
    expect(scheduled.size).toBe(0)
  })
})
