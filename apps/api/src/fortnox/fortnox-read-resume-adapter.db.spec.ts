/** Real storage + crypto + driver/adapter/reader/transport; synthetic OAuth and fetch.
 * Three composition cases only. No network, live Fortnox, Redis or publication proof.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import {
  FortnoxConnectionService,
  FortnoxCredentialBindingError,
} from './fortnox-connection.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FortnoxRateIdentity } from './provider/fortnox-rate-limiter'
import type { FortnoxRateLimiter } from './provider/fortnox-transport.types'
import { FortnoxResumeReadAdapter } from './fortnox-read-resume-adapter'
import { FortnoxReadResumeDriver } from './fortnox-read-resume-driver'
import { FortnoxReadSourceRunService } from './fortnox-read-source-run.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'

const YEAR = { id: 2, fromDate: '2026-01-01', toDate: '2026-12-31' }
const INPUT: StartCheckpointInput = {
  financialYearId: 2,
  financialYearStart: YEAR.fromDate,
  financialYearEnd: YEAR.toDate,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const MANIFEST = {
  MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 1 },
  Vouchers: [{ Year: 2, VoucherSeries: 'L', VoucherNumber: 1 }],
}
const DETAIL = {
  Voucher: {
    Year: 2,
    VoucherSeries: 'L',
    VoucherNumber: 1,
    TransactionDate: '2026-10-01',
    ReferenceType: 'INVOICE',
    ReferenceNumber: 'SYNTHETIC-29',
    VoucherRows: [
      { Account: 5170, Debit: 0.29 },
      { Account: 2440, Credit: 0.29 },
    ],
  },
}
const NORMAL_FORM = {
  key: '2|L|1',
  date: '2026-10-01',
  headerDimensionPresent: false,
  reference: { type: 'INVOICE', number: 'SYNTHETIC-29' },
  rows: [
    {
      index1: 1,
      account: 5170,
      debitOre: 29,
      creditOre: 0,
      costCenter: null,
      project: null,
      removed: false,
    },
    {
      index1: 2,
      account: 2440,
      debitOre: 0,
      creditOre: 29,
      costCenter: null,
      project: null,
      removed: false,
    },
  ],
}
const BUCKET = 'fortnox:synthetic-resume-adapter:db900002'
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
function isolatedUrl(pool = 3) {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Resume adapter requires explicit synthetic DATABASE_URL')
  const url = new URL(raw)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(
      database === 'eveno_fortnox_capacity_test' ||
      (process.env.CI === 'true' && database === 'eken_dev')
    )
  )
    throw new Error('Resume adapter permits only isolated local database or CI')
  url.searchParams.set('connection_limit', String(pool))
  return url.toString()
}
const DATABASE_URL = isolatedUrl()
jest.setTimeout(30_000)
class TestPrisma extends PrismaClient {
  async onModuleInit() {
    await this.$connect()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}
class ShortLeaseService extends FortnoxReadSourceRunService {
  protected override leaseDurationMs() {
    return 1000
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const running = new Set<Promise<void>>()
const fetching = new Set<Promise<Response>>()
const unblock = new Set<() => void>()
function tracked(work: () => Promise<void>) {
  return () => {
    const job = Promise.resolve().then(work)
    running.add(job)
    void job.then(
      () => running.delete(job),
      () => running.delete(job),
    )
    return job
  }
}
async function reached(entered: Promise<void>, settled: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entered,
      settled.then(() => {
        throw new Error('Advance settled before synthetic fetch barrier')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fetch barrier not reached')), 5000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('Fortnox resume adapter: real DB composition', () => {
  let prisma: TestPrisma
  const orgs = new Set<string>()
  const clients = new Set<TestPrisma>()
  const marker = (id: string) => `synthetic-resume-adapter-${id}`
  const config = new ConfigService({ FORTNOX_TOKEN_KEY: 'ab'.repeat(32) })
  const crypto = new FortnoxTokenCryptoService(config)
  async function connect(service: FortnoxConnectionService, org: string) {
    const { authUrl } = await service.begin(org, 'synthetic-adapter-user')
    const state = new URL(authUrl).searchParams.get('state')
    if (!state) throw new Error('Synthetic OAuth state missing')
    await service.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
  }
  async function fixture() {
    const org = randomUUID()
    orgs.add(org) // Intended ownership survives a lost create response.
    await prisma.organization.create({
      data: {
        id: org,
        name: marker(org),
        email: `${org}@example.invalid`,
        street: 'Syntetisk gata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    const auth = new MockFortnoxAuthProvider()
    const company = new MockFortnoxLedgerReader()
    company.company.DatabaseNumber = 900002
    const identity = new FortnoxRateIdentity()
    const connections = new FortnoxConnectionService(
      prisma,
      crypto,
      config,
      auth,
      company,
      identity,
    )
    await connect(connections, org)
    const connection = await prisma.fortnoxConnection.findUniqueOrThrow({
      where: { organizationId: org },
    })
    const runs = new FortnoxReadSourceRunService(prisma)
    const run = await runs.start(org, null, INPUT)
    const lease = await runs.claim(org, run.id)
    if (!lease) throw new Error('Fixture preparation claim missing')
    expect(await runs.prepareNormalization(lease)).toMatchObject({
      status: 'NORMALIZED',
      mappingCount: 0,
      exportCount: 0,
      next: null,
    })
    const catalog: CheckpointCatalog = {
      version: 1,
      companyDatabaseNumber: 900002,
      financialYear: { ...YEAR, accountingMethod: 'ACCRUAL' },
      accounts: [{ number: 5170, active: null, balanceBroughtForwardOre: null }],
      dimensions: [],
      coverage: { costCenters: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 } },
    }
    await runs.commitCatalog(lease, catalog)
    await runs.release(lease)
    return { org, run, connection, auth, company, identity, connections }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function durable(f: Fixture) {
    const observer = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
    try {
      const where = { organizationId: f.org, runId: f.run.id }
      return {
        connection: await observer.fortnoxConnection.findUniqueOrThrow({
          where: { organizationId: f.org },
        }),
        run: await observer.fortnoxReadRun.findUniqueOrThrow({
          where: { id: f.run.id, organizationId: f.org },
        }),
        source: await observer.fortnoxReadSourceCapture.findUniqueOrThrow({
          where: { id: f.run.id, organizationId: f.org },
        }),
        pages: await observer.fortnoxReadManifestPage.findMany({ where, orderBy: { page: 'asc' } }),
        details: await observer.fortnoxReadVoucherCheckpoint.findMany({
          where,
          orderBy: { key: 'asc' },
        }),
        publications: await observer.fortnoxReadPublication.findMany({ where }),
      }
    } finally {
      await observer.$disconnect()
    }
  }
  type FetchRecord = { path: string; query: Record<string, string>; token: string | null }
  function worker(
    f: Fixture,
    respond: (call: FetchRecord, index: number) => Promise<Response>,
    short = false,
  ) {
    const db = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
    clients.add(db)
    const runs = short ? new ShortLeaseService(db) : new FortnoxReadSourceRunService(db)
    const connections = new FortnoxConnectionService(
      db,
      crypto,
      config,
      f.auth,
      f.company,
      f.identity,
    )
    const bound = jest.spyOn(connections, 'boundAccessToken')
    const pageCommit = jest.spyOn(runs, 'commitVoucherPage')
    const detailCommit = jest.spyOn(runs, 'commitVoucherDetail')
    const release = jest.spyOn(runs, 'release')
    const calls: FetchRecord[] = []
    const acquire = jest.fn<Promise<void>, [string, AbortSignal]>(async () => {})
    const defer = jest.fn<Promise<void>, [string, number]>(async () => {
      throw new Error('Unexpected defer')
    })
    const limiter: FortnoxRateLimiter = { acquire, defer } // Synthetic scheduling boundary, not Redis proof.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api.fortnox.se')
      expect(['/3/vouchers/sublist', '/3/vouchers/L/1']).toContain(url.pathname)
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(init?.body).toBeUndefined()
      const headers = new Headers(init?.headers)
      expect(headers.get('Accept')).toBe('application/json')
      expect(init?.signal?.aborted).toBe(false)
      const call = {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        token: headers.get('Authorization'),
      }
      calls.push(call)
      const job = respond(call, calls.length)
      fetching.add(job)
      void job.then(
        () => fetching.delete(job),
        () => fetching.delete(job),
      )
      return job
    }
    const transport = new FortnoxTransport({ fetch, rateLimiter: limiter })
    const reader = new RealFortnoxLedgerReader({
      transport,
      clientId: 'synthetic-resume-adapter',
      enabled: true,
      identity: f.identity,
    })
    const adapter = new FortnoxResumeReadAdapter(connections, reader)
    const driver = new FortnoxReadResumeDriver(runs, adapter)
    return { driver, calls, acquire, defer, bound, pageCommit, detailCommit, release }
  }
  const expectedBinding = (f: Fixture) => ({
    organizationId: f.org,
    connectionId: f.connection.id,
    connectionGeneration: f.connection.generation,
    fortnoxDatabaseNumber: 900002,
    fortnoxOrgNumber: f.connection.fortnoxOrgNumber,
  })
  const manifestCall = {
    path: '/3/vouchers/sublist',
    query: { financialyear: '2', page: '1', limit: '100' },
    token: 'Bearer mock-access-1',
  }
  function expectBuckets(w: ReturnType<typeof worker>, count: number) {
    expect(w.acquire.mock.calls.map(([key]) => key)).toEqual(
      Array.from({ length: count }, () => BUCKET),
    )
    expect(w.defer).not.toHaveBeenCalled()
  }
  function heldResponse(status: number) {
    const entered = deferred(),
      release = deferred()
    unblock.add(release.resolve)
    return {
      entered,
      release,
      respond: async (call: FetchRecord, index: number) => {
        expect(index).toBe(1)
        expect(call).toStrictEqual(manifestCall)
        entered.resolve()
        await release.promise
        return response(status === 200 ? MANIFEST : {}, status)
      },
    }
  }
  async function databaseExpired(f: Fixture) {
    const end = Date.now() + 4000
    while (Date.now() < end) {
      const [clock] = await prisma.$queryRaw<Array<{ expired: boolean | null }>>`
        SELECT timezone('UTC', clock_timestamp()) > "leaseUntil" AS expired
        FROM "FortnoxReadRun" WHERE id = ${f.run.id} AND "organizationId" = ${f.org}`
      if (!clock || clock.expired === null) throw new Error('Committed lease missing')
      if (clock.expired) return
      await pause(10)
    }
    throw new Error('Actual PostgreSQL lease expiry not observed')
  }
  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
  })
  afterEach(async () => {
    for (const release of unblock) release()
    await Promise.allSettled([...running])
    await Promise.allSettled([...fetching])
    unblock.clear()
    await Promise.all([...clients].map((db) => db.$disconnect()))
    clients.clear()
    jest.restoreAllMocks()
  })
  afterAll(async () => {
    // A Jest timeout is not cancellation: no DELETE until all operations really settle.
    for (const release of unblock) release()
    await Promise.allSettled([...running])
    await Promise.allSettled([...fetching])
    try {
      for (const org of orgs) {
        const row = await prisma.organization.findUnique({
          where: { id: org },
          select: { name: true },
        })
        if (!row) continue
        expect(row.name).toBe(marker(org))
        await prisma.organization.delete({ where: { id: org } })
      }
      const observer = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
      try {
        const where = { organizationId: { in: [...orgs] } }
        expect(await observer.organization.count({ where: { id: { in: [...orgs] } } })).toBe(0)
        expect(await observer.fortnoxConnection.count({ where })).toBe(0)
        expect(await observer.fortnoxOAuthState.count({ where })).toBe(0)
        expect(await observer.fortnoxCustomerActivation.count({ where })).toBe(0)
        expect(await observer.fortnoxReadRun.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceCapture.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceMapping.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceExport.count({ where })).toBe(0)
        expect(await observer.fortnoxReadNormalizationStage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadNormalizationPage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadContextSnapshot.count({ where })).toBe(0)
        expect(await observer.fortnoxReadContextPage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadManifestPage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadVoucherCheckpoint.count({ where })).toBe(0)
        expect(await observer.fortnoxReadPublication.count({ where })).toBe(0)
      } finally {
        await observer.$disconnect()
      }
    } finally {
      await Promise.allSettled([...clients].map((db) => db.$disconnect()))
      await prisma.$disconnect()
    }
  }, 30_000)

  it(
    'commits MANIFEST then DETAIL on a new advance; one bound 401 refresh preserves company/year',
    tracked(async () => {
      const f = await fixture(),
        initial = await durable(f)
      const first = worker(f, async (call, index) => {
        expect(index).toBe(1)
        expect(call).toStrictEqual(manifestCall)
        return response(MANIFEST)
      })
      const manifestResult = await first.driver.advance(f.org, f.run.id)
      expect(manifestResult).toMatchObject({
        kind: 'MANIFEST_SAVED',
        receipt: { runId: f.run.id, page: 1 },
      })
      const listed = await durable(f)
      expect(listed.run).toMatchObject({
        phase: 'DETAILS',
        status: 'RUNNING',
        claimVersion: initial.run.claimVersion + 1,
        claimToken: null,
        leaseUntil: null,
        nextManifestPage: 2,
      })
      expect(listed.pages).toHaveLength(1)
      expect(listed.details).toHaveLength(1)
      expect(listed.details[0]).toMatchObject({ key: '2|L|1', detailDigest: null, validated: null })
      expect(first.pageCommit).toHaveBeenCalledTimes(1)
      expect(first.detailCommit).not.toHaveBeenCalled()
      expect(first.release).toHaveBeenCalledTimes(1)
      expect(first.bound.mock.calls).toEqual([[expectedBinding(f)]])
      expectBuckets(first, 1)

      const next = worker(f, async (call, index) => {
        expect([1, 2]).toContain(index)
        expect(call).toStrictEqual({
          path: '/3/vouchers/L/1',
          query: { financialyear: '2' },
          token: index === 1 ? 'Bearer mock-access-1' : 'Bearer mock-access-2',
        })
        return response(index === 1 ? {} : DETAIL, index === 1 ? 401 : 200)
      })
      const detailResult = await next.driver.advance(f.org, f.run.id)
      expect(detailResult).toMatchObject({
        kind: 'DETAIL_SAVED',
        receipt: { runId: f.run.id, key: '2|L|1' },
      })
      const saved = await durable(f)
      expect(saved.run).toMatchObject({
        phase: 'READY_TO_REDUCE',
        status: 'RUNNING',
        claimVersion: listed.run.claimVersion + 1,
        claimToken: null,
        leaseUntil: null,
      })
      expect(saved.pages).toStrictEqual(listed.pages)
      expect(saved.details).toHaveLength(1)
      expect(saved.details[0]?.validated).toStrictEqual(NORMAL_FORM)
      expect(saved.details[0]?.detailDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(saved.source).toStrictEqual(initial.source)
      expect(saved.publications).toEqual([])
      expect(saved.connection).toMatchObject({
        id: f.connection.id,
        generation: f.connection.generation,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 900002,
        fortnoxOrgNumber: f.connection.fortnoxOrgNumber,
        tokenVersion: f.connection.tokenVersion + 1,
      })
      expect(crypto.decrypt(saved.connection.accessTokenEnc)).toBe('mock-access-2')
      expect(f.auth.calls).toEqual({ exchange: 1, refresh: 1, revoke: 0 })
      expect(next.bound.mock.calls).toEqual([
        [expectedBinding(f)],
        [expectedBinding(f), { afterUnauthorizedVersion: f.connection.tokenVersion }],
      ])
      expect(next.pageCommit).not.toHaveBeenCalled()
      expect(next.detailCommit).toHaveBeenCalledTimes(1)
      expect(next.release).toHaveBeenCalledTimes(1)
      expect([...first.calls, ...next.calls]).toHaveLength(3)
      expectBuckets(next, 2)
    }),
  )

  it(
    'normal disconnect/reconnect during GET prevents a second GET and every commit after late 401',
    tracked(async () => {
      const f = await fixture(),
        gate = heldResponse(401),
        w = worker(f, gate.respond)
      const work = w.driver.advance(f.org, f.run.id)
      const settled = Promise.allSettled([work])
      try {
        await reached(gate.entered.promise, settled)
        const pending = await durable(f)
        expect(pending.run.claimToken).not.toBeNull()
        expect(pending.pages).toEqual([])
        expect(pending.details).toEqual([])
        await f.connections.disconnect(f.org)
        await connect(f.connections, f.org)
        const later = await durable(f)
        expect(later.connection).toMatchObject({
          status: 'ACTIVE',
          generation: f.connection.generation + 1,
          fortnoxDatabaseNumber: 900002,
        })
        expect(crypto.decrypt(later.connection.accessTokenEnc)).toBe('mock-access-2')
        expect(later.run).toStrictEqual(pending.run)
        gate.release.resolve()
        await expect(work).rejects.toBeInstanceOf(FortnoxCredentialBindingError)
        expect(w.calls).toEqual([manifestCall])
        expect(w.bound.mock.calls).toEqual([
          [expectedBinding(f)],
          [expectedBinding(f), { afterUnauthorizedVersion: f.connection.tokenVersion }],
        ])
        expect(f.auth.calls).toEqual({ exchange: 2, refresh: 0, revoke: 1 })
        expect(w.pageCommit).not.toHaveBeenCalled()
        expect(w.detailCommit).not.toHaveBeenCalled()
        expect(w.release).not.toHaveBeenCalled()
        expectBuckets(w, 1)
        expect(await durable(f)).toStrictEqual(later)
        // Credential rejection occurs before commit: RUNNING is not falsely asserted FAILED.
        expect(later.run.status).toBe('RUNNING')
        expect(later.publications).toEqual([])
      } finally {
        gate.release.resolve()
        await settled
      }
    }),
  )

  it(
    'actual PostgreSQL lease expiry fences the real commit after a delayed successful GET',
    tracked(async () => {
      const f = await fixture(),
        gate = heldResponse(200),
        w = worker(f, gate.respond, true)
      const work = w.driver.advance(f.org, f.run.id)
      const settled = Promise.allSettled([work])
      try {
        await reached(gate.entered.promise, settled)
        const pending = await durable(f)
        expect(pending.run.claimToken).not.toBeNull()
        expect(pending.pages).toEqual([])
        expect(pending.details).toEqual([])
        await databaseExpired(f)
        gate.release.resolve()
        await expect(work).rejects.toThrow('Läsanspråket har upphört')
        expect(w.calls).toEqual([manifestCall])
        expect(w.pageCommit).toHaveBeenCalledTimes(1)
        expect(w.pageCommit.mock.calls[0]?.[1]).toEqual(MANIFEST)
        expect(w.detailCommit).not.toHaveBeenCalled()
        expect(w.release).not.toHaveBeenCalled()
        expect(f.auth.calls).toEqual({ exchange: 1, refresh: 0, revoke: 0 })
        expect(w.bound.mock.calls).toEqual([[expectedBinding(f)]])
        expectBuckets(w, 1)
        expect(await durable(f)).toStrictEqual(pending)
        expect(pending.publications).toEqual([])
      } finally {
        gate.release.resolve()
        await settled
      }
    }),
  )
})
