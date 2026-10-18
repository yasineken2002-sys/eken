/** Real PostgreSQL/CAS with synthetic auth only. No provider/network calls.
 * Generation-only/company-only writes below are deliberately synthetic contracts,
 * not normal OAuth flows. A returned credential is not a fence for a later GET.
 */
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { Prisma, PrismaClient, type FortnoxConnection } from '@prisma/client'
import {
  FortnoxConnectionService,
  FortnoxCredentialBindingError,
  type FortnoxCredentialBinding,
} from './fortnox-connection.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { FortnoxRateIdentity } from './provider/fortnox-rate-limiter'

function isolatedUrl(pool = 3) {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Bound credential requires explicit synthetic DATABASE_URL')
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
    throw new Error('Bound credential permits only the isolated local database or CI')
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
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const running = new Set<Promise<void>>()
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
        throw new Error('Credential operation settled before barrier')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Credential barrier not reached')), 5000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected record')
  return value as Record<string, unknown>
}
function binding(row: FortnoxConnection): FortnoxCredentialBinding {
  return {
    organizationId: row.organizationId,
    connectionId: row.id,
    connectionGeneration: row.generation,
    fortnoxDatabaseNumber: row.fortnoxDatabaseNumber,
    fortnoxOrgNumber: row.fortnoxOrgNumber,
  }
}
type Hook = (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
type Event = { action: string; count: number | null }

// Track full test lifetimes; teardown never races an outstanding refresh/query.
// A Jest/hook timeout is not cancellation and is not a successful cleanup receipt.
describe('Fortnox bound credentials: real storage fences', () => {
  let prisma: TestPrisma
  const orgs = new Set<string>()
  const clients = new Set<TestPrisma>()
  const marker = (org: string) => `synthetic-bound-credential-${org}`
  const config = new ConfigService({ FORTNOX_TOKEN_KEY: 'ab'.repeat(32) })
  const crypto = new FortnoxTokenCryptoService(config)
  function client(hook?: Hook) {
    const db = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
    clients.add(db)
    const events: Event[] = []
    db.$use(async (params, next) => {
      const result: unknown = await next(params)
      if (params.model === 'FortnoxConnection') {
        events.push({
          action: params.action,
          count: params.action === 'updateMany' ? Number(record(result).count) : null,
        })
        await hook?.(params, result)
      }
      return result
    })
    return { db, events }
  }
  function owner(db: TestPrisma, auth: MockFortnoxAuthProvider, reader: MockFortnoxLedgerReader) {
    const identity = new FortnoxRateIdentity()
    const bind = jest.spyOn(identity, 'bind') // Call-through; no replacement of identity logic.
    return {
      service: new FortnoxConnectionService(db, crypto, config, auth, reader, identity),
      bind,
      identity,
    }
  }
  async function connect(service: FortnoxConnectionService, org: string) {
    const { authUrl } = await service.begin(org, 'synthetic-bound-user')
    const state = new URL(authUrl).searchParams.get('state')
    if (!state) throw new Error('Synthetic OAuth state absent')
    await service.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
  }
  async function fixture(expired = true) {
    const org = randomUUID()
    orgs.add(org) // Pre-register ownership even if a create response is lost.
    await prisma.organization.create({
      data: {
        id: org,
        name: marker(org),
        email: `${org}@example.invalid`,
        street: 'Syntetisk gata 1',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    const auth = new MockFortnoxAuthProvider()
    const reader = new MockFortnoxLedgerReader()
    const control = owner(prisma, auth, reader)
    await connect(control.service, org)
    if (expired)
      await prisma.fortnoxConnection.update({
        where: { organizationId: org },
        data: { accessTokenExpiresAt: new Date(0) },
      })
    const row = await prisma.fortnoxConnection.findUniqueOrThrow({ where: { organizationId: org } })
    return { org, auth, reader, control, row, expected: binding(row) }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function durable(org: string) {
    const observer = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
    try {
      return await observer.fortnoxConnection.findUniqueOrThrow({ where: { organizationId: org } })
    } finally {
      await observer.$disconnect()
    }
  }
  async function reconnect(f: Fixture) {
    await f.control.service.disconnect(f.org)
    await connect(f.control.service, f.org)
    const next = await durable(f.org)
    expect(next.status).toBe('ACTIVE')
    expect(next.id).toBe(f.row.id)
    expect(next.generation).toBe(f.row.generation + 1)
    expect(next.tokenVersion).toBeGreaterThan(f.row.tokenVersion)
    return next
  }
  function pauseRead(number = 1) {
    const entered = deferred(),
      release = deferred()
    unblock.add(release.resolve)
    let reads = 0
    const hook: Hook = async (params) => {
      if (params.action === 'findUnique' && ++reads === number) {
        entered.resolve()
        await release.promise
      }
    }
    return { entered, release, hook }
  }
  function pauseRefresh(f: Fixture) {
    const entered = deferred(),
      release = deferred()
    unblock.add(release.resolve)
    const actual = f.auth.refresh.bind(f.auth)
    const refresh = jest.spyOn(f.auth, 'refresh').mockImplementationOnce(async (token) => {
      entered.resolve()
      await release.promise
      return actual(token)
    })
    return { entered, release, refresh }
  }
  function pauseSave() {
    const entered = deferred(),
      release = deferred()
    unblock.add(release.resolve)
    let actualSaved = false
    const hook: Hook = async (params, result) => {
      if (
        params.action === 'updateMany' &&
        typeof record(params.args.data).accessTokenEnc === 'string'
      ) {
        expect(record(result).count).toBe(1)
        actualSaved = true
        entered.resolve()
        await release.promise
      }
    }
    return { entered, release, hook, saved: () => actualSaved }
  }
  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
  })
  afterEach(async () => {
    for (const release of unblock) release()
    await Promise.allSettled([...running])
    unblock.clear()
    await Promise.all([...clients].map((db) => db.$disconnect()))
    clients.clear()
  })
  afterAll(async () => {
    for (const release of unblock) release()
    await Promise.allSettled([...running])
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
      } finally {
        await observer.$disconnect()
      }
    } finally {
      await Promise.allSettled([...clients].map((db) => db.$disconnect()))
      await prisma.$disconnect()
      jest.restoreAllMocks()
    }
  }, 30_000)

  it(
    'refreshes matching scope and returns token/version/binding from the committed row',
    tracked(async () => {
      const f = await fixture()
      // NULL is a real stored value, not an omitted binding predicate.
      await prisma.fortnoxConnection.update({
        where: { id: f.row.id },
        data: { fortnoxOrgNumber: null },
      })
      const expected = { ...f.expected, fortnoxOrgNumber: null }
      const c = client(),
        run = owner(c.db, f.auth, f.reader)
      const result = await run.service.boundAccessToken(expected)
      const saved = await durable(f.org)
      expect(result).toStrictEqual({
        token: 'mock-access-2',
        tokenVersion: f.row.tokenVersion + 1,
        binding: expected,
      })
      expect(crypto.decrypt(saved.accessTokenEnc)).toBe(result.token)
      expect(crypto.decrypt(saved.refreshTokenEnc!)).toBe('mock-refresh-2')
      expect(saved).toMatchObject({
        status: 'ACTIVE',
        tokenVersion: result.tokenVersion,
        refreshAttemptId: null,
        refreshLeaseUntil: null,
      })
      expect(c.events).toEqual([
        { action: 'findUnique', count: null },
        { action: 'updateMany', count: 1 },
        { action: 'updateMany', count: 1 },
        { action: 'findUnique', count: null },
      ])
      expect(f.auth.calls.refresh).toBe(1)
      expect(run.bind.mock.calls).toEqual([[result.token, expected.fortnoxDatabaseNumber]])
    }),
  )

  it.each(['normal reconnect', 'synthetic generation-only'] as const)(
    'expired initial snapshot reaches real losing lease CAS after %s',
    (mode) =>
      tracked(async () => {
        const f = await fixture(),
          gate = pauseRead()
        const c = client(gate.hook),
          run = owner(c.db, f.auth, f.reader)
        const operation = run.service.boundAccessToken(f.expected)
        const settled = Promise.allSettled([operation])
        try {
          await reached(gate.entered.promise, settled)
          const later =
            mode === 'normal reconnect'
              ? await reconnect(f)
              : await prisma.fortnoxConnection.update({
                  where: { id: f.row.id },
                  data: { generation: { increment: 1 } },
                })
          if (mode === 'synthetic generation-only')
            expect(later).toMatchObject({
              id: f.row.id,
              tokenVersion: f.row.tokenVersion,
              refreshAttemptId: null,
              status: 'ACTIVE',
            })
          gate.release.resolve()
          await expect(operation).rejects.toBeInstanceOf(FortnoxCredentialBindingError)
          expect(c.events).toEqual([
            { action: 'findUnique', count: null },
            { action: 'updateMany', count: 0 },
            { action: 'findUnique', count: null },
          ])
          expect(f.auth.calls.refresh).toBe(0)
          expect(run.bind).not.toHaveBeenCalled()
          expect(await durable(f.org)).toStrictEqual(later)
        } finally {
          gate.release.resolve()
          await settled
        }
      })(),
  )

  const errors = [
    ['rate_limited', 'REFRESH_RATE_LIMITED'],
    ['not_sent', 'REFRESH_IN_PROGRESS'],
    ['unknown', 'AUTH_LOST'],
    ['rejected', 'AUTH_LOST'],
  ] as const
  it.each(errors)(
    'synthetic generation-only change fences late %s write (caller still receives %s)',
    (kind, reason) =>
      tracked(async () => {
        const f = await fixture(),
          gate = pauseRefresh(f)
        f.auth.failRefresh = kind
        const c = client(),
          run = owner(c.db, f.auth, f.reader)
        const operation = run.service.boundAccessToken(f.expected)
        const settled = Promise.allSettled([operation])
        try {
          await reached(gate.entered.promise, settled)
          const leased = await durable(f.org)
          expect(leased.refreshAttemptId).toEqual(expect.any(String))
          const later = await prisma.fortnoxConnection.update({
            where: { id: f.row.id },
            data: { generation: { increment: 1 } },
          })
          expect(later).toMatchObject({
            id: leased.id,
            tokenVersion: leased.tokenVersion,
            refreshAttemptId: leased.refreshAttemptId,
            status: 'ACTIVE',
          })
          gate.release.resolve()
          await expect(operation).rejects.toMatchObject({
            name: 'FortnoxNotConnectedError',
            reason,
          })
          expect(c.events.filter((e) => e.action === 'updateMany').map((e) => e.count)).toEqual([
            1, 0,
          ])
          expect(f.auth.calls.refresh).toBe(1)
          expect(run.bind).not.toHaveBeenCalled()
          expect(await durable(f.org)).toStrictEqual(later)
        } finally {
          gate.release.resolve()
          await settled
          gate.refresh.mockRestore()
        }
      })(),
  )

  it.each(['generation', 'fortnoxDatabaseNumber', 'fortnoxOrgNumber'] as const)(
    'synthetic %s-only change fences late successful token save',
    (field) =>
      tracked(async () => {
        const f = await fixture(),
          gate = pauseRefresh(f)
        const c = client(),
          run = owner(c.db, f.auth, f.reader)
        const operation = run.service.boundAccessToken(f.expected)
        const settled = Promise.allSettled([operation])
        try {
          await reached(gate.entered.promise, settled)
          const leased = await durable(f.org)
          const data =
            field === 'generation'
              ? { generation: { increment: 1 } }
              : field === 'fortnoxDatabaseNumber'
                ? { fortnoxDatabaseNumber: 900002 }
                : { fortnoxOrgNumber: null }
          const later = await prisma.fortnoxConnection.update({ where: { id: f.row.id }, data })
          expect(later).toMatchObject({
            id: leased.id,
            tokenVersion: leased.tokenVersion,
            refreshAttemptId: leased.refreshAttemptId,
            status: 'ACTIVE',
          })
          gate.release.resolve()
          await expect(operation).rejects.toMatchObject({ reason: 'DISCONNECTED' })
          expect(c.events.filter((e) => e.action === 'updateMany').map((e) => e.count)).toEqual([
            1, 0,
          ])
          expect(f.auth.calls.refresh).toBe(1)
          expect(run.bind).not.toHaveBeenCalled()
          expect(await durable(f.org)).toStrictEqual(later)
        } finally {
          gate.release.resolve()
          await settled
          gate.refresh.mockRestore()
        }
      })(),
  )

  it(
    'normal disconnect/reconnect while refresh is held preserves the new encrypted tokens',
    tracked(async () => {
      const f = await fixture(),
        gate = pauseRefresh(f)
      const c = client(),
        run = owner(c.db, f.auth, f.reader)
      const operation = run.service.boundAccessToken(f.expected)
      const settled = Promise.allSettled([operation])
      try {
        await reached(gate.entered.promise, settled)
        const later = await reconnect(f)
        expect(crypto.decrypt(later.accessTokenEnc)).toBe('mock-access-2')
        gate.release.resolve()
        await expect(operation).rejects.toMatchObject({ reason: 'DISCONNECTED' })
        expect(c.events.filter((e) => e.action === 'updateMany').map((e) => e.count)).toEqual([
          1, 0,
        ])
        expect(run.bind).not.toHaveBeenCalled()
        expect(await durable(f.org)).toStrictEqual(later)
      } finally {
        gate.release.resolve()
        await settled
        gate.refresh.mockRestore()
      }
    }),
  )

  it(
    'synthetic generation change after actual expired-attempt read fences AUTH_LOST write',
    tracked(async () => {
      const f = await fixture()
      const attempt = randomUUID()
      await prisma.fortnoxConnection.update({
        where: { id: f.row.id },
        data: { refreshAttemptId: attempt, refreshLeaseUntil: new Date(0) },
      })
      const [clock] = await prisma.$queryRaw<
        Array<{ expired: boolean }>
      >`SELECT "refreshLeaseUntil" < CURRENT_TIMESTAMP AS expired FROM "FortnoxConnection" WHERE id = ${f.row.id}`
      expect(clock?.expired).toBe(true)
      const gate = pauseRead(2),
        c = client(gate.hook),
        run = owner(c.db, f.auth, f.reader)
      const operation = run.service.boundAccessToken(f.expected)
      const settled = Promise.allSettled([operation])
      try {
        await reached(gate.entered.promise, settled)
        const later = await prisma.fortnoxConnection.update({
          where: { id: f.row.id },
          data: { generation: { increment: 1 } },
        })
        expect(later).toMatchObject({
          tokenVersion: f.row.tokenVersion,
          refreshAttemptId: attempt,
          status: 'ACTIVE',
        })
        gate.release.resolve()
        await expect(operation).rejects.toMatchObject({ reason: 'AUTH_LOST' })
        expect(c.events.filter((e) => e.action === 'updateMany').map((e) => e.count)).toEqual([
          0, 0,
        ])
        expect(f.auth.calls.refresh).toBe(0)
        expect(run.bind).not.toHaveBeenCalled()
        expect(await durable(f.org)).toStrictEqual(later)
      } finally {
        gate.release.resolve()
        await settled
      }
    }),
  )

  it.each(['reconnect', 'legitimate later version'] as const)(
    'post-save real reread observes %s',
    (mode) =>
      tracked(async () => {
        const f = await fixture(),
          gate = pauseSave()
        const c = client(gate.hook),
          run = owner(c.db, f.auth, f.reader)
        const operation = run.service.boundAccessToken(f.expected)
        const settled = Promise.allSettled([operation])
        try {
          await reached(gate.entered.promise, settled)
          expect(gate.saved()).toBe(true)
          const saved = await durable(f.org)
          expect(saved.tokenVersion).toBe(f.row.tokenVersion + 1)
          expect(crypto.decrypt(saved.accessTokenEnc)).toBe('mock-access-2')
          if (mode === 'reconnect') await f.control.service.disconnect(f.org)
          await connect(f.control.service, f.org)
          const later = await durable(f.org)
          gate.release.resolve()
          if (mode === 'reconnect') {
            await expect(operation).rejects.toBeInstanceOf(FortnoxCredentialBindingError)
            expect(run.bind).not.toHaveBeenCalled()
          } else {
            expect(binding(later)).toStrictEqual(f.expected)
            expect(later.tokenVersion).toBe(saved.tokenVersion + 1)
            expect(crypto.decrypt(later.accessTokenEnc)).toBe('mock-access-3')
            await expect(operation).resolves.toStrictEqual({
              token: 'mock-access-3',
              tokenVersion: later.tokenVersion,
              binding: f.expected,
            })
            expect(run.bind.mock.calls).toEqual([
              ['mock-access-3', f.expected.fortnoxDatabaseNumber],
            ])
          }
          expect(c.events).toEqual([
            { action: 'findUnique', count: null },
            { action: 'updateMany', count: 1 },
            { action: 'updateMany', count: 1 },
            { action: 'findUnique', count: null },
          ])
          expect(await durable(f.org)).toStrictEqual(later)
        } finally {
          gate.release.resolve()
          await settled
        }
      })(),
  )

  it.each(['fast', 'refreshed', 'CAS loser reread', 'bound CAS loser reread'] as const)(
    '%s returns its exact credential shape with the original query count',
    (mode) =>
      tracked(async () => {
        const f = await fixture(mode !== 'fast'),
          gate = pauseRead()
        const loser = mode === 'CAS loser reread' || mode === 'bound CAS loser reread'
        const c = client(loser ? gate.hook : undefined),
          run = owner(c.db, f.auth, f.reader)
        const operation =
          mode === 'bound CAS loser reread'
            ? run.service.boundAccessToken(f.expected)
            : run.service.accessToken(f.org)
        const settled = Promise.allSettled([operation])
        try {
          if (loser) {
            await reached(gate.entered.promise, settled)
            await f.control.service.boundAccessToken(f.expected) // A real winning refresh on another client.
            gate.release.resolve()
          }
          const result = await operation
          if (mode === 'bound CAS loser reread') {
            expect(result).toStrictEqual({
              token: 'mock-access-2',
              tokenVersion: f.row.tokenVersion + 1,
              binding: f.expected,
            })
            if (!('binding' in result)) throw new Error('Bound credential omitted binding')
            expect(Object.isFrozen(result.binding)).toBe(true)
            expect(Object.isFrozen(result)).toBe(true)
          } else {
            expect(result).toStrictEqual({
              token: mode === 'fast' ? 'mock-access-1' : 'mock-access-2',
              connectionId: f.row.id,
              databaseNumber: 900001,
              tokenVersion: f.row.tokenVersion + (mode === 'fast' ? 0 : 1),
            })
            expect(Object.keys(result).sort()).toEqual([
              'connectionId',
              'databaseNumber',
              'token',
              'tokenVersion',
            ])
          }
          const expectedEvents =
            mode === 'fast'
              ? [{ action: 'findUnique', count: null }]
              : mode === 'refreshed'
                ? [
                    { action: 'findUnique', count: null },
                    { action: 'updateMany', count: 1 },
                    { action: 'updateMany', count: 1 },
                  ]
                : [
                    { action: 'findUnique', count: null },
                    { action: 'updateMany', count: 0 },
                    { action: 'findUnique', count: null },
                  ]
          expect(c.events).toEqual(expectedEvents)
          expect(f.auth.calls.refresh).toBe(mode === 'fast' ? 0 : 1)
          expect(run.bind.mock.calls).toEqual([[result.token, 900001]])
          const saved = await durable(f.org)
          expect(crypto.decrypt(saved.accessTokenEnc)).toBe(result.token)
          expect(saved.tokenVersion).toBe(result.tokenVersion)
        } finally {
          gate.release.resolve()
          await settled
        }
      })(),
  )
})
