/** Real synthetic PostgreSQL P17–P19. Actual A–F/serialization and publication
 * locks; no provider, private product hooks, trigger bypass or customer activation.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { FortnoxReadSourceRunService } from './fortnox-read-source-run.service'
import type { PublicationReceipt } from './fortnox-read-source-run.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import * as publicationFormat from './fortnox-read-publication-format'

const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const CATALOG: CheckpointCatalog = {
  version: 1,
  companyDatabaseNumber: 900001,
  financialYear: {
    id: 1,
    fromDate: '2026-01-01',
    toDate: '2026-12-31',
    accountingMethod: 'ACCRUAL',
  },
  accounts: [{ number: 5170, active: true, balanceBroughtForwardOre: 0 }],
  dimensions: [],
  coverage: { costCenters: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 } },
}
const EXPIRED = 'Läsanspråket har upphört'
const CONNECTION_CHANGED = 'Fortnox-anslutningen har ändrats; starta en ny läsning.'

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Publiceringsracen kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Publiceringsracen tillåter endast egen lokal testdatabas eller CI')
  url.searchParams.set('connection_limit', '1')
  return url.toString()
}
const DATABASE_URL = isolatedUrl()
class TestPrisma extends PrismaClient {
  async onModuleInit() {
    await this.$connect()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function rawText(params: Prisma.MiddlewareParams): string {
  // Only SQL text. Never stringify args: those contain tokens/full JSON payloads.
  if (params.action !== 'queryRaw' && params.action !== 'executeRaw') return ''
  const args: unknown = params.args
  const first: unknown = Array.isArray(args) ? args[0] : args
  if (typeof first === 'string') return first
  if (Array.isArray(first) && first.every((part) => typeof part === 'string'))
    return first.join('?')
  if (record(first) && typeof first.sql === 'string') return first.sql
  return ''
}
const connectionLock = (p: Prisma.MiddlewareParams) =>
  /SELECT\s+"id"\s+FROM\s+"FortnoxConnection"[\s\S]*FOR UPDATE/u.test(rawText(p))
const publicationInsert = (p: Prisma.MiddlewareParams) =>
  /INSERT INTO "FortnoxReadPublication"/u.test(rawText(p))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Tracked<T> = { settled: Promise<PromiseSettledResult<T>>; finished(): boolean }
function track<T>(operation: Promise<T>): Tracked<T> {
  let finished = false
  const settled = operation.then<PromiseSettledResult<T>, PromiseSettledResult<T>>(
    (value) => {
      finished = true
      return { status: 'fulfilled', value }
    },
    (reason: unknown) => {
      finished = true
      return { status: 'rejected', reason }
    },
  )
  return { settled, finished: () => finished }
}
async function whilePending(signal: Promise<unknown>, operations: readonly Tracked<unknown>[]) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal,
      ...operations.map((operation) =>
        operation.settled.then(() => {
          throw new Error('Publiceringsanropet avslutades före den observerade barriären')
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Den verkliga racebarriären nåddes inte')), 2500)
      }),
    ])
    if (operations.some((operation) => operation.finished()))
      throw new Error('Publiceringsanropet var redan avslutat vid barriären')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('Intern v2-publicering: takeover, anslutningsbyte och verklig låskonkurrens', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Racefixturen har inte startat')
    return prisma
  }
  const service = (client = db()) => new FortnoxReadSourceRunService(client)
  const newClient = () => new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })

  beforeAll(async () => {
    prisma = newClient()
    await prisma.$connect()
    expect(await prisma.$queryRaw`SELECT current_database() AS name`).toEqual([
      { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
  })
  afterAll(async () => {
    const cleanup = newClient()
    try {
      for (const id of orgs) {
        expect((await cleanup.organization.findUniqueOrThrow({ where: { id } })).name).toBe(
          `synthetic-publication-race-${id}`,
        )
      }
      await cleanup.organization.deleteMany({ where: { id: { in: [...orgs] } } })
      const where = { organizationId: { in: [...orgs] } }
      expect(await cleanup.organization.count({ where: { id: { in: [...orgs] } } })).toBe(0)
      expect(await cleanup.fortnoxReadPublication.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadRun.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadSourceCapture.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadSourceMapping.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadSourceExport.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadNormalizationStage.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadNormalizationPage.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadContextSnapshot.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadContextPage.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadManifestPage.count({ where })).toBe(0)
      expect(await cleanup.fortnoxReadVoucherCheckpoint.count({ where })).toBe(0)
    } finally {
      await Promise.allSettled([cleanup.$disconnect(), prisma?.$disconnect()])
      prisma = undefined
    }
  })

  async function fixture() {
    const org = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-publication-race-${org}`,
        email: `${org}@example.invalid`,
        street: 'Syntetgatan 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    orgs.add(org)
    const connection = await db().fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 900001,
        fortnoxOrgNumber: 'SYNTHETIC_PUBLICATION_RACE',
      },
    })
    const owner = service(),
      run = await owner.start(org, null, INPUT)
    const lease = await owner.claim(org, run.id)
    if (!lease) throw new Error('Eget läsanspråk saknas')
    const stage = await owner.prepareNormalization(lease)
    expect(stage).toMatchObject({
      status: 'NORMALIZED',
      mappingCount: 0,
      exportCount: 0,
      next: null,
    })
    await owner.commitCatalog(lease, CATALOG)
    await owner.commitVoucherPage(lease, {
      MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 1 },
      Vouchers: [{ Year: 1, VoucherSeries: 'L', VoucherNumber: 1 }],
    })
    await owner.commitVoucherDetail(lease, '1|L|1', {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 1,
      TransactionDate: '2026-10-01',
      ReferenceNumber: 'SYNTHETIC_RACE',
      VoucherRows: [
        { Account: 5170, Debit: 1 },
        { Account: 2440, Credit: 1 },
      ],
    })
    return { org, runId: run.id, connection, lease }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function durable(f: Fixture) {
    const observer = newClient()
    try {
      return {
        run: await observer.fortnoxReadRun.findUniqueOrThrow({
          where: { id: f.runId, organizationId: f.org },
        }),
        publications: await observer.fortnoxReadPublication.findMany({
          where: { runId: f.runId, organizationId: f.org },
        }),
      }
    } finally {
      await observer.$disconnect()
    }
  }
  async function historical(f: Fixture) {
    const observer = newClient()
    try {
      return await service(observer).readPublicationReceipt(f.org, f.runId)
    } finally {
      await observer.$disconnect()
    }
  }

  async function publisher(f: Fixture) {
    const client = newClient()
    const owner = service(client)
    const ready = deferred(),
      allowLock = deferred(),
      inserted = deferred(),
      allowInsertReturn = deferred()
    let awaitingFinalLock = false,
      prepared = 0,
      locksAfterPreparation = 0,
      inserts = 0
    let publicationId: string | null = null,
      holdInsert = false
    const renew = jest.spyOn(owner, 'renew') // call-through; no manufactured lease/time.
    client.$use(async (params, next) => {
      if (awaitingFinalLock && connectionLock(params)) {
        awaitingFinalLock = false
        locksAfterPreparation++
        // If a short/expired lease instead routed here through renew, fail
        // explicitly: this test must pause at the publication write TX.
        expect(renew).not.toHaveBeenCalled()
        ready.resolve()
        await allowLock.promise
      }
      const result: unknown = await next(params)
      if (publicationInsert(params)) {
        inserts++
        expect(result).toEqual([{ id: publicationId, publishedAt: expect.any(Date) }])
        inserted.resolve()
        if (holdInsert) await allowInsertReturn.promise
      }
      return result
    })
    let pid: number
    try {
      await client.$connect()
      const [backend] = await client.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`
      if (!backend || !Number.isSafeInteger(backend.pid)) throw new Error('Egen pool1-PID saknas')
      pid = backend.pid
    } catch (error) {
      renew.mockRestore()
      await Promise.allSettled([client.$disconnect()])
      throw error
    }
    return {
      client,
      owner,
      pid,
      ready,
      allowLock,
      inserted,
      allowInsertReturn,
      holdAfterInsert() {
        holdInsert = true
      },
      serialized(encoded: publicationFormat.EncodedPublication) {
        expect(encoded.organizationId).toBe(f.org)
        expect(encoded.runId).toBe(f.runId)
        expect(encoded.status).toBe('COMPLETE')
        expect(encoded.resultDigest).toMatch(/^[a-f0-9]{64}$/u)
        expect(encoded.canonicalBytes).toBeGreaterThan(0)
        prepared++
        expect(prepared).toBe(1)
        publicationId = encoded.id
        awaitingFinalLock = true
      },
      stats: () => ({ prepared, locksAfterPreparation, inserts, publicationId }),
      async close() {
        allowLock.resolve()
        allowInsertReturn.resolve()
        renew.mockRestore()
        await client.$disconnect()
      },
    }
  }
  type Publisher = Awaited<ReturnType<typeof publisher>>

  function serializationObserver() {
    // Both writers are prepared one at a time until their own P2 gate. Their
    // final writes then race. The original synchronous codec always runs and
    // its exact result is returned; no private service method is intercepted.
    const original = publicationFormat.encodeLedgerPublication
    let next: Publisher | null = null
    const spy = jest
      .spyOn(publicationFormat, 'encodeLedgerPublication')
      .mockImplementation((...args) => {
        const encoded = original(...args)
        if (!next) throw new Error('Oväntad serialisering utanför den beväpnade publiceringen')
        next.serialized(encoded)
        next = null
        return encoded
      })
    return {
      arm(target: Publisher) {
        if (next) throw new Error('Tidigare serialisering har inte observerats')
        next = target
      },
      restore() {
        spy.mockRestore()
      },
    }
  }

  async function waitBlocked(
    waiter: Publisher,
    holder: Publisher,
    operations: readonly Tracked<unknown>[],
  ) {
    const until = Date.now() + 1500
    while (Date.now() < until) {
      let observed = false
      await whilePending(
        (async () => {
          const [row] = await db().$queryRaw<
            Array<{ blockers: number[]; waitEvent: string | null; state: string | null }>
          >`
          SELECT pg_blocking_pids(pid) AS blockers, wait_event_type AS "waitEvent", state
          FROM pg_stat_activity WHERE pid = ${waiter.pid}`
          observed =
            row?.blockers.includes(holder.pid) === true &&
            row.waitEvent === 'Lock' &&
            row.state === 'active'
        })(),
        operations,
      )
      if (observed) return
      await whilePending(pause(5), operations)
    }
    throw new Error('B:s verkliga låsväntan bakom A observerades inte')
  }

  function rejected(result: PromiseSettledResult<unknown>, message: string) {
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('Publiceringen saknar förväntat avslag')
    expect(result.reason).toBeInstanceOf(ConflictException)
    expect(result.reason).toMatchObject({ status: 409, message })
  }

  it('P17: takeover efter verklig serialisering nekar A; B måste publicera sin egen A–F-kedja', async () => {
    const f = await fixture()
    let a: Publisher | undefined, codec: ReturnType<typeof serializationObserver> | undefined
    let operation: Tracked<PublicationReceipt> | undefined
    const successor = newClient()
    try {
      a = await publisher(f)
      codec = serializationObserver()
      codec.arm(a)
      operation = track(a.owner.publishReadyLedger(f.lease))
      await whilePending(a.ready.promise, [operation])
      expect(a.stats()).toMatchObject({ prepared: 1, locksAfterPreparation: 1, inserts: 0 })
      const nextOwner = service(successor)
      await nextOwner.release(f.lease)
      const nextLease = await nextOwner.claim(f.org, f.runId)
      if (!nextLease) throw new Error('B saknar eget övertaget anspråk')
      expect(nextLease.claimVersion).toBe(f.lease.claimVersion + 1)
      expect(nextLease.claimToken).not.toBe(f.lease.claimToken)
      const takenOver = await durable(f)
      expect(takenOver.publications).toEqual([])
      a.allowLock.resolve()
      rejected(await operation.settled, EXPIRED)
      expect(a.stats().inserts).toBe(0)
      expect(await durable(f)).toStrictEqual(takenOver)
      codec.restore()
      const winner = await nextOwner.publishReadyLedger(nextLease)
      expect(winner.proof.claimVersion).toBe(nextLease.claimVersion)
      expect(winner.id).not.toBe(a.stats().publicationId)
      const saved = await durable(f)
      expect(saved.publications).toHaveLength(1)
      expect(saved.publications[0]?.id).toBe(winner.id)
      expect(saved.run).toMatchObject({ status: 'COMPLETE', claimToken: null, leaseUntil: null })
      expect(await historical(f)).toStrictEqual(winner)
    } finally {
      a?.allowLock.resolve()
      a?.allowInsertReturn.resolve()
      if (operation) await Promise.allSettled([operation.settled])
      codec?.restore()
      await Promise.allSettled([a?.close(), successor.$disconnect()])
    }
  }, 20_000)

  it('P18: generationsbyte efter verklig serialisering stoppar körningen utan publiceringspar', async () => {
    const f = await fixture()
    let a: Publisher | undefined, codec: ReturnType<typeof serializationObserver> | undefined
    let operation: Tracked<PublicationReceipt> | undefined
    const changer = newClient()
    try {
      a = await publisher(f)
      codec = serializationObserver()
      codec.arm(a)
      operation = track(a.owner.publishReadyLedger(f.lease))
      await whilePending(a.ready.promise, [operation])
      expect(a.stats()).toMatchObject({ prepared: 1, locksAfterPreparation: 1, inserts: 0 })
      const changed = await changer.fortnoxConnection.update({
        where: { id: f.connection.id, organizationId: f.org },
        data: { generation: { increment: 1 } },
      })
      expect(changed.generation).toBe(f.connection.generation + 1)
      a.allowLock.resolve()
      rejected(await operation.settled, CONNECTION_CHANGED)
      expect(a.stats().inserts).toBe(0)
      const saved = await durable(f)
      expect(saved.publications).toEqual([])
      expect(saved.run).toMatchObject({
        status: 'FAILED',
        reason: CONNECTION_CHANGED,
        claimVersion: f.lease.claimVersion,
        claimToken: null,
        leaseUntil: null,
        summary: null,
        rows: null,
      })
      expect(await historical(f)).toBeNull()
    } finally {
      a?.allowLock.resolve()
      a?.allowInsertReturn.resolve()
      if (operation) await Promise.allSettled([operation.settled])
      codec?.restore()
      await Promise.allSettled([a?.close(), changer.$disconnect()])
    }
  }, 20_000)

  it('P19: två förberedda publish väntar på samma verkliga lås och exakt ett slutpar vinner', async () => {
    const f = await fixture()
    let a: Publisher | undefined, b: Publisher | undefined
    let codec: ReturnType<typeof serializationObserver> | undefined
    let first: Tracked<PublicationReceipt> | undefined,
      second: Tracked<PublicationReceipt> | undefined
    try {
      a = await publisher(f)
      b = await publisher(f)
      codec = serializationObserver()
      codec.arm(a)
      first = track(a.owner.publishReadyLedger(f.lease))
      await whilePending(a.ready.promise, [first])
      codec.arm(b)
      second = track(b.owner.publishReadyLedger(f.lease))
      await whilePending(b.ready.promise, [first, second])
      expect(a.stats()).toMatchObject({ prepared: 1, locksAfterPreparation: 1, inserts: 0 })
      expect(b.stats()).toMatchObject({ prepared: 1, locksAfterPreparation: 1, inserts: 0 })
      expect(a.pid).not.toBe(b.pid)
      expect(a.stats().publicationId).not.toBe(b.stats().publicationId)
      a.holdAfterInsert()
      a.allowLock.resolve()
      await whilePending(a.inserted.promise, [first, second])
      // A really inserted and still holds connection→run→stage. B's SELECT
      // must now be seen waiting on A, not merely delayed by our JS barrier.
      expect(a.stats().inserts).toBe(1)
      b.allowLock.resolve()
      await waitBlocked(b, a, [first, second])
      expect(b.stats().inserts).toBe(0)
      a.allowInsertReturn.resolve()
      const [winner, loser] = await Promise.all([first.settled, second.settled])
      expect(winner.status).toBe('fulfilled')
      if (winner.status !== 'fulfilled')
        throw new Error('A måste lyckas efter uttryckligt låssläpp')
      rejected(loser, EXPIRED)
      expect(a.stats().inserts + b.stats().inserts).toBe(1)
      const saved = await durable(f)
      expect(saved.publications).toHaveLength(1)
      expect(saved.publications[0]?.id).toBe(winner.value.id)
      expect(winner.value.id).toBe(a.stats().publicationId)
      expect(saved.run).toMatchObject({
        status: 'COMPLETE',
        completedAt: winner.value.publishedAt,
        claimVersion: f.lease.claimVersion,
        claimToken: null,
        leaseUntil: null,
      })
      expect(await historical(f)).toStrictEqual(winner.value)
    } finally {
      a?.allowLock.resolve()
      b?.allowLock.resolve()
      a?.allowInsertReturn.resolve()
      b?.allowInsertReturn.resolve()
      await Promise.allSettled([first?.settled, second?.settled])
      codec?.restore()
      await Promise.allSettled([a?.close(), b?.close()])
    }
  }, 20_000)
})
