/** Riktig PostgreSQL och egna syntetiska källor, inga provideranrop.
 * Barriärer omger verkliga queries. Leaseutgång observeras med DB-klockan;
 * inga fake timers, omskrivna deadlines eller avstängda SQL-spärrar används.
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient, type FortnoxReadRun } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { type StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import { FortnoxReadSourceRunService, type SourceRunLease } from './fortnox-read-source-run.service'

const INPUT = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
const COMPANY = 900001

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Source-lease kräver uttrycklig lokal testdatabas')
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Source-lease tillåter bara egen lokal testdatabas eller CI:s eken_dev')
  url.searchParams.set('connection_limit', '4')
  return url.toString()
}
const DATABASE_URL = isolatedUrl() // Ovillkorlig grind även när andra prov väljs.

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
    return 500
  }
}
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function ownership(lease: SourceRunLease) {
  return {
    claimVersion: lease.claimVersion,
    claimToken: lease.claimToken,
    leaseUntil: lease.leaseUntil,
  }
}
function withoutOwnership(run: FortnoxReadRun) {
  return {
    ...run,
    claimVersion: 0,
    claimToken: null,
    leaseUntil: null,
    checkpointUpdatedAt: null,
  }
}

describe('Fortnox v2: ägarskap och fenced råkällsläsning i PostgreSQL', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>()
  const journalIds = new Set<string>()
  const exportIds = new Set<string>()
  const accountIds = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Source-lease-fixture har inte startat')
    return prisma
  }
  const service = (client = db()) => new FortnoxReadSourceRunService(client)
  const tx = <T>(work: (client: Prisma.TransactionClient) => Promise<T>, client = db()) =>
    client.$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  const current = (runId: string, client = db()) =>
    client.fortnoxReadRun.findUniqueOrThrow({ where: { id: runId } })
  async function mustClaim(org: string, runId: string, owner = service()) {
    const lease = await owner.claim(org, runId)
    expect(lease).not.toBeNull()
    if (!lease) throw new Error('Förväntat anspråk saknas')
    return lease
  }
  async function controlled() {
    const url = new URL(DATABASE_URL)
    url.searchParams.set('connection_limit', '1')
    const client = new TestPrisma({ datasources: { db: { url: url.toString() } } })
    const hooks: Hooks = {}
    client.$use(async (params, next) => {
      await hooks.before?.(params)
      const result = await next(params)
      await hooks.after?.(params, result)
      return result
    })
    await client.$connect()
    const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    if (!row) throw new Error('Kontrollerad anslutning saknar PID')
    return { client, hooks, pid: row.pid }
  }
  async function fixture(rich = false) {
    const org = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-source-lease-${org}`,
        email: `${org}@example.invalid`,
        street: 'Syntetisk gata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    orgs.add(org)
    const connection = await db().fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: COMPANY,
        fortnoxOrgNumber: 'SYNTHETIC_LEASE_COMPANY',
      },
    })
    const propertyId = randomUUID()
    const exportId = randomUUID()
    if (rich) {
      const journalId = randomUUID(),
        bank = randomUUID(),
        expense = randomUUID()
      journalIds.add(journalId)
      exportIds.add(exportId)
      accountIds.add(bank)
      accountIds.add(expense)
      await tx(async (c) => {
        await c.property.create({
          data: {
            id: propertyId,
            organizationId: org,
            name: 'Syntetisk oföränderlig fastighet',
            propertyDesignation: `SYNTHETIC ${propertyId}`,
            type: 'RESIDENTIAL',
            street: 'Syntetisk gata 2',
            city: 'Teststad',
            postalCode: '11111',
            totalArea: '100.00',
          },
        })
        await c.fortnoxDimensionMapping.createMany({
          data: Array.from(
            { length: 101 },
            (_, i) =>
              ({
                organizationId: org,
                propertyId,
                dimensionType: 'COST_CENTER',
                code: String(i + 1).padStart(3, '0'),
              }) satisfies Prisma.FortnoxDimensionMappingCreateManyInput,
          ),
        })
        await c.account.createMany({
          data: [
            { id: bank, organizationId: org, number: 1930, name: 'Syntetisk bank', type: 'ASSET' },
            {
              id: expense,
              organizationId: org,
              number: 5170,
              name: 'Syntetisk kostnad',
              type: 'EXPENSE',
            },
          ],
        })
        await c.journalEntry.create({
          data: {
            id: journalId,
            organizationId: org,
            date: new Date('2026-01-01T00:00:00Z'),
            description: 'SYNTHETIC_LEASE_ONLY',
            source: 'MANUAL',
            sourceId: `synthetic:${journalId}`,
            fiscalYear: 2026,
            series: 'A',
            verNumber: 1,
            lines: {
              create: [
                { accountId: bank, debit: '0.00', credit: '100.00' },
                { accountId: expense, debit: '100.00', credit: '0.00' },
              ],
            },
          },
        })
        await c.fortnoxVoucherExport.create({
          data: {
            id: exportId,
            organizationId: org,
            journalEntryId: journalId,
            state: 'CONFIRMED',
            fortnoxDatabaseNumber: COMPANY,
            externalYear: 1,
            externalSeries: 'L',
            externalNumber: 1,
            draft: {
              provenance: { lines: [{ localAccountNumber: 5170, externalAccountNumber: 5171 }] },
            },
          },
        })
      })
    }
    return { org, connection, propertyId, exportId }
  }
  async function state(org: string, client = db()) {
    return {
      runs: await client.fortnoxReadRun.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      captures: await client.fortnoxReadSourceCapture.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      mappings: await client.fortnoxReadSourceMapping.findMany({
        where: { organizationId: org },
        orderBy: [{ captureId: 'asc' }, { ordinal: 'asc' }],
      }),
      exports: await client.fortnoxReadSourceExport.findMany({
        where: { organizationId: org },
        orderBy: [{ captureId: 'asc' }, { ordinal: 'asc' }],
      }),
    }
  }
  async function durableState(org: string) {
    const observer = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      await observer.$connect()
      return await state(org, observer)
    } finally {
      await observer.$disconnect()
    }
  }
  async function databaseAfter(deadline: Date) {
    const limit = Date.now() + 2000
    while (Date.now() < limit) {
      const [row] = await db().$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (row && row.now > deadline) return row.now
    }
    throw new Error('Verklig DB-tid nådde inte den korta testgränsen inom två sekunder')
  }
  async function waitBlocked(pid: number, blocker: number) {
    const limit = Date.now() + 1500
    while (Date.now() < limit) {
      const [row] = await db().$queryRaw<Array<{ blockers: number[]; query: string }>>`
        SELECT pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE pid=${pid}`
      if (row?.blockers.includes(blocker)) {
        expect(row.query).toContain('FortnoxConnection')
        return
      }
    }
    throw new Error('Den verkliga anslutningslåsväntan observerades inte')
  }
  async function sqlRejected(run: FortnoxReadRun, change: Prisma.Sql) {
    const before = await state(run.organizationId)
    await expect(
      tx((c) =>
        c.$executeRaw(Prisma.sql`
      UPDATE "FortnoxReadRun" SET ${change} WHERE id=${run.id} AND "organizationId"=${run.organizationId}`),
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    expect(await state(run.organizationId)).toStrictEqual(before)
  }

  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
  })
  afterAll(async () => {
    if (!prisma) return
    try {
      for (const org of orgs)
        expect((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).name).toBe(
          `synthetic-source-lease-${org}`,
        )
      await prisma.fortnoxVoucherExport.deleteMany({ where: { id: { in: [...exportIds] } } })
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntryId: { in: [...journalIds] } },
      })
      await prisma.journalEntry.deleteMany({ where: { id: { in: [...journalIds] } } })
      await prisma.account.deleteMany({ where: { id: { in: [...accountIds] } } })
      for (const org of orgs) await prisma.organization.delete({ where: { id: org } })
    } finally {
      await prisma.$disconnect()
    }
  })

  it('KANARIEFÅGEL: första claim har beständigt ägarskap men ingen bearbetningsprogress', async () => {
    expect(await db().$queryRaw`SELECT current_database() AS name`).toStrictEqual([
      { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    const before = await state(f.org)
    const lease = await mustClaim(f.org, run.id)
    const after = await durableState(f.org)
    expect(lease).toStrictEqual({ organizationId: f.org, runId: run.id, ...ownership(lease) })
    expect(lease.claimVersion).toBe(1)
    expect(lease.claimToken).toMatch(/^[a-f0-9-]{36}$/)
    expect(after.runs[0]).toMatchObject(ownership(lease))
    expect(withoutOwnership(after.runs[0]!)).toStrictEqual(withoutOwnership(run))
    expect({ ...after, runs: before.runs }).toStrictEqual(before)
    expect(await service().claim(f.org, run.id)).toBeNull()
    expect(await state(f.org)).toStrictEqual(after)
  })

  it('två verkligt konkurrerande claims ger en vinnare och en upptagen utan versionshopp', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    const a = await controlled(),
      b = await controlled(),
      written = deferred(),
      resume = deferred()
    a.hooks.after = async (params, result) => {
      if (params.model !== 'FortnoxReadRun' || params.action !== 'update') return
      expect(params.runInTransaction).toBe(true)
      expect(params.args).toMatchObject({ where: { id: run.id } })
      expect(result).toMatchObject({ claimVersion: 1 })
      written.resolve()
      await resume.promise
    }
    const first = service(a.client).claim(f.org, run.id),
      firstDone = Promise.allSettled([first])
    let secondDone: Promise<PromiseSettledResult<SourceRunLease | null>[]> | undefined
    try {
      await Promise.race([
        written.promise,
        first.then(() => {
          throw new Error('Barriären missades')
        }),
      ])
      expect((await current(run.id)).claimVersion).toBe(0)
      const second = service(b.client).claim(f.org, run.id)
      secondDone = Promise.allSettled([second])
      await waitBlocked(b.pid, a.pid)
      resume.resolve()
      const lease = await first
      expect(lease).not.toBeNull()
      expect(await second).toBeNull()
      if (!lease) throw new Error('Vinnande claim saknas')
      expect(await current(run.id)).toMatchObject(ownership(lease))
      expect((await current(run.id)).claimVersion).toBe(1)
    } finally {
      resume.resolve()
      await firstDone
      if (secondDone) await secondDone
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it('första/sista/tom sida är fryst efter omstart och liveändring, aldrig normaliserad eller COMPLETE', async () => {
    const f = await fixture(true),
      run = await service().start(f.org, null, INPUT)
    const lease = await mustClaim(f.org, run.id),
      before = await state(f.org)
    await db().property.update({ where: { id: f.propertyId }, data: { name: 'SYNTHETIC_LATER' } })
    await db().fortnoxVoucherExport.update({
      where: { id: f.exportId },
      data: { externalNumber: 999, draft: {} },
    })
    const other = await controlled()
    try {
      const restarted = service(other.client)
      const first = await restarted.readSourcePage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n })
      expect(first).toStrictEqual({ items: before.mappings.slice(0, 100), nextAfterOrdinal: 100n })
      expect(first.items.map((row) => row.ordinal)).toStrictEqual(
        Array.from({ length: 100 }, (_, i) => BigInt(i + 1)),
      )
      if (first.nextAfterOrdinal === null) throw new Error('Förväntad sidcursor saknas')
      expect(
        await restarted.readSourcePage(lease, {
          kind: 'MAPPINGS',
          afterOrdinal: first.nextAfterOrdinal,
        }),
      ).toStrictEqual({ items: before.mappings.slice(100), nextAfterOrdinal: null })
      expect(before.mappings.map((row) => row.code)).toStrictEqual(
        Array.from({ length: 101 }, (_, i) => String(i + 1).padStart(3, '0')),
      )
      expect(
        await restarted.readSourcePage(lease, { kind: 'MAPPINGS', afterOrdinal: 101n }),
      ).toStrictEqual({ items: [], nextAfterOrdinal: null })
      expect(
        await restarted.readSourcePage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 0n }),
      ).toStrictEqual({ items: before.exports, nextAfterOrdinal: null })
      expect(
        await restarted.readSourcePage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 1n }),
      ).toStrictEqual({ items: [], nextAfterOrdinal: null })
      expect(await state(f.org)).toStrictEqual(before)
      expect(
        await db().fortnoxReadContextSnapshot.count({ where: { organizationId: f.org } }),
      ).toBe(0)
      expect(await db().fortnoxReadManifestPage.count({ where: { organizationId: f.org } })).toBe(0)
      expect(
        await db().fortnoxReadVoucherCheckpoint.count({ where: { organizationId: f.org } }),
      ).toBe(0)
    } finally {
      await other.client.$disconnect()
    }
  })

  it('fel org/run/token/version nekas utan data eller ändring; v1 och legacy kan inte claimas av v2', async () => {
    const a = await fixture(),
      b = await fixture()
    const ar = await service().start(a.org, null, INPUT),
      br = await service().start(b.org, null, INPUT)
    const al = await mustClaim(a.org, ar.id),
      bl = await mustClaim(b.org, br.id)
    const beforeA = await state(a.org),
      beforeB = await state(b.org)
    for (const invalid of [
      { ...al, organizationId: b.org },
      { ...al, runId: br.id },
      { ...al, claimToken: bl.claimToken },
      { ...al, claimVersion: al.claimVersion + 1 },
    ]) {
      await expect(
        service().readSourcePage(invalid, { kind: 'OWN_EXPORTS', afterOrdinal: 0n }),
      ).rejects.toBeInstanceOf(ConflictException)
      await expect(service().renew(invalid)).rejects.toBeInstanceOf(ConflictException)
      await expect(service().release(invalid)).rejects.toBeInstanceOf(ConflictException)
    }
    await expect(service().claim(b.org, ar.id)).rejects.toBeInstanceOf(ConflictException)
    await expect(service().claim(a.org, randomUUID())).rejects.toBeInstanceOf(ConflictException)
    expect(await state(a.org)).toStrictEqual(beforeA)
    expect(await state(b.org)).toStrictEqual(beforeB)
    const c = await fixture()
    const v1 = await new FortnoxReadCheckpointService(db()).start(c.org, null, INPUT)
    const legacy = await db().fortnoxReadRun.create({
      data: {
        organizationId: c.org,
        connectionId: c.connection.id,
        fortnoxDatabaseNumber: COMPANY,
        financialYearId: 1,
        periodFrom: new Date('2026-10-01T00:00:00Z'),
        periodTo: new Date('2026-10-31T00:00:00Z'),
        costAccounts: [5170],
      },
    })
    const beforeC = await state(c.org)
    expect(await service().claim(c.org, v1.id)).toBeNull()
    expect(await service().claim(c.org, legacy.id)).toBeNull()
    expect(await state(c.org)).toStrictEqual(beforeC)
  })

  it('ogiltiga leasefält och fria sidnycklar nekas, callerens giltiga Date styr inte DB-deadline', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      lease = await mustClaim(f.org, run.id)
    const before = await state(f.org)
    for (const invalid of [
      { ...lease, claimVersion: 0 },
      { ...lease, claimVersion: 1.5 },
      { ...lease, claimToken: 'invalid' },
      { ...lease, leaseUntil: new Date(NaN) },
      { ...lease, sourceCaptureId: randomUUID() },
    ])
      await expect(service().renew(invalid)).rejects.toBeInstanceOf(BadRequestException)
    const extra = { kind: 'MAPPINGS' as const, afterOrdinal: 0n, captureId: randomUUID() }
    await expect(service().readSourcePage(lease, extra)).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      service().readSourcePage(lease, { kind: 'MAPPINGS', afterOrdinal: -1n }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(
      await service().readSourcePage(
        { ...lease, leaseUntil: new Date(0) },
        { kind: 'MAPPINGS', afterOrdinal: 0n },
      ),
    ).toStrictEqual({ items: [], nextAfterOrdinal: null })
    expect(await state(f.org)).toStrictEqual(before)
  })

  it('startreplay under aktiv lease bevarar hela ägarskapet och v1/annat input stannar vid konflikt', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    await mustClaim(f.org, run.id)
    const before = await state(f.org)
    expect(await service().start(f.org, randomUUID(), INPUT)).toStrictEqual(before.runs[0])
    await expect(
      service().start(f.org, null, { ...INPUT, periodTo: '2026-10-30' }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      new FortnoxReadCheckpointService(db()).start(f.org, null, INPUT),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await state(f.org)).toStrictEqual(before)
  })

  it('claim efter startcommit före dess separata kvitto ogiltigförklarar inte den beständiga starten', async () => {
    const f = await fixture(),
      c = await controlled()
    let createdId: string | undefined,
      observed = false,
      claimed: SourceRunLease | undefined
    c.hooks.after = async (params, result) => {
      if (params.model === 'FortnoxReadRun' && params.action === 'create') {
        if (!record(result) || typeof result.id !== 'string')
          throw new Error('Verklig runINSERT saknar id')
        createdId = result.id
      }
    }
    c.hooks.before = async (params) => {
      if (
        !createdId ||
        observed ||
        params.model !== 'FortnoxReadRun' ||
        params.action !== 'findUnique'
      )
        return
      expect(await current(createdId)).toMatchObject({ id: createdId, claimVersion: 0 })
      claimed = await mustClaim(f.org, createdId)
      observed = true
    }
    try {
      const returned = await service(c.client).start(f.org, null, INPUT)
      expect(observed).toBe(true)
      expect(claimed).toBeDefined()
      expect(returned).toStrictEqual(await current(returned.id))
      expect(returned.claimVersion).toBe(1)
      expect((await state(f.org)).captures).toHaveLength(1)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('verkligt utgången lease nekas före takeover; startreplay förnyar den aldrig', async () => {
    const f = await fixture(),
      short = new ShortLeaseService(db()),
      run = await service().start(f.org, null, INPUT)
    const lease = await mustClaim(f.org, run.id, short)
    expect(await databaseAfter(lease.leaseUntil)).toBeInstanceOf(Date)
    const before = await state(f.org)
    expect(await service().start(f.org, null, INPUT)).toStrictEqual(before.runs[0])
    await expect(
      service().readSourcePage(
        { ...lease, leaseUntil: new Date('2099-01-01T00:00:00Z') },
        { kind: 'MAPPINGS', afterOrdinal: 0n },
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(service().renew(lease)).rejects.toBeInstanceOf(ConflictException)
    await expect(service().release(lease)).rejects.toBeInstanceOf(ConflictException)
    expect(await state(f.org)).toStrictEqual(before)
    const replacement = await mustClaim(f.org, run.id)
    expect(replacement.claimVersion).toBe(lease.claimVersion + 1)
    expect(replacement.claimToken).not.toBe(lease.claimToken)
    expect(await current(run.id)).toMatchObject(ownership(replacement))
  })

  it('gammal fence får inte terminalisera ny ägare efter takeover och generationsbyte', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    const old = await mustClaim(f.org, run.id, new ShortLeaseService(db()))
    await databaseAfter(old.leaseUntil)
    const next = await mustClaim(f.org, run.id)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { generation: { increment: 1 } },
    })
    const before = await state(f.org)
    await expect(
      service().readSourcePage(old, { kind: 'MAPPINGS', afterOrdinal: 0n }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(service().renew(old)).rejects.toBeInstanceOf(ConflictException)
    await expect(service().release(old)).rejects.toBeInstanceOf(ConflictException)
    expect(await service().claim(f.org, run.id)).toBeNull()
    expect(await state(f.org)).toStrictEqual(before)
    await expect(
      service().readSourcePage(next, { kind: 'MAPPINGS', afterOrdinal: 0n }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await current(run.id)).toMatchObject({
      status: 'FAILED',
      claimVersion: 2,
      claimToken: null,
      leaseUntil: null,
    })
  })

  it('renew förlänger samma fence, release frigör en ny version och återanvänder aldrig gammalt token', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      lease = await mustClaim(f.org, run.id)
    await databaseAfter(new Date(lease.leaseUntil.getTime() - 60_000 + 2))
    const before = await current(run.id),
      renewed = await service().renew(lease)
    expect(renewed).toMatchObject({
      organizationId: f.org,
      runId: run.id,
      claimVersion: lease.claimVersion,
      claimToken: lease.claimToken,
    })
    expect(renewed.leaseUntil.getTime()).toBeGreaterThan(lease.leaseUntil.getTime())
    expect(withoutOwnership(await current(run.id))).toStrictEqual(withoutOwnership(before))
    expect(await current(run.id)).toMatchObject(ownership(renewed))
    await service().release(renewed)
    const released = await current(run.id)
    expect(released).toMatchObject({ claimVersion: 1, claimToken: null, leaseUntil: null })
    await expect(service().release(renewed)).rejects.toBeInstanceOf(ConflictException)
    const next = await mustClaim(f.org, run.id)
    expect(next.claimVersion).toBe(2)
    expect(next.claimToken).not.toBe(lease.claimToken)
    expect(withoutOwnership(await current(run.id))).toStrictEqual(withoutOwnership(run))
  })

  it('kort förnyelse är en exakt no-op men kräver fortfarande korrekt fence', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      lease = await mustClaim(f.org, run.id)
    const before = await state(f.org),
      short = new ShortLeaseService(db())
    expect(await short.renew(lease)).toStrictEqual(lease)
    await expect(short.renew({ ...lease, claimToken: randomUUID() })).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(await state(f.org)).toStrictEqual(before)
  })

  it('claim/renew/release använder rätt UTC-instant även i en Europe/Stockholm-session', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      c = await controlled()
    try {
      await c.client.$executeRaw`SET TIME ZONE 'Europe/Stockholm'`
      const [before] = await c.client.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`
      if (!before) throw new Error('DB-tid saknas')
      const lease = await mustClaim(f.org, run.id, service(c.client))
      const [stored] = await c.client.$queryRaw<Array<{ now: Date; epoch: number }>>`
        SELECT clock_timestamp() AS now,
          (extract(epoch FROM ("leaseUntil" AT TIME ZONE 'UTC')) * 1000)::float8 AS epoch
        FROM "FortnoxReadRun" WHERE id=${run.id}`
      if (!stored) throw new Error('Sparad lease saknas')
      expect(lease.leaseUntil.getTime()).toBe(stored.epoch)
      expect(lease.leaseUntil.getTime()).toBeGreaterThanOrEqual(before.now.getTime() + 59_999)
      expect(lease.leaseUntil.getTime()).toBeLessThanOrEqual(stored.now.getTime() + 60_001)
      await databaseAfter(new Date(lease.leaseUntil.getTime() - 60_000 + 2))
      const renewed = await service(c.client).renew(lease)
      expect(renewed.leaseUntil.getTime()).toBeGreaterThan(lease.leaseUntil.getTime())
      await service(c.client).release(renewed)
      expect(await current(run.id)).toMatchObject({
        claimVersion: 1,
        claimToken: null,
        leaseUntil: null,
      })
    } finally {
      await c.client.$disconnect()
    }
  })

  it('tokenVersion-refresh tillåter fortsatt läsning och replay av samma källa', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      lease = await mustClaim(f.org, run.id)
    const before = await state(f.org)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { tokenVersion: { increment: 1 } },
    })
    expect(
      await service().readSourcePage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 0n }),
    ).toStrictEqual({ items: [], nextAfterOrdinal: null })
    expect(await service().start(f.org, null, INPUT)).toStrictEqual(before.runs[0])
    expect(await state(f.org)).toStrictEqual(before)
  })

  it.each(['read-generation', 'renew-disconnected', 'release-generation'] as const)(
    '%s stoppar beständigt vid giltig fence, med rensad lease men bevarad källa',
    async (kind) => {
      const f = await fixture(),
        run = await service().start(f.org, null, INPUT),
        lease = await mustClaim(f.org, run.id)
      const before = await state(f.org)
      await db().fortnoxConnection.update({
        where: { organizationId: f.org },
        data:
          kind === 'renew-disconnected'
            ? { status: 'DISCONNECTED' }
            : { generation: { increment: 1 } },
      })
      const operation =
        kind === 'read-generation'
          ? service().readSourcePage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n })
          : kind === 'renew-disconnected'
            ? service().renew(lease)
            : service().release(lease)
      await expect(operation).rejects.toBeInstanceOf(ConflictException)
      const after = await durableState(f.org)
      expect(after.runs[0]).toMatchObject({
        status: 'FAILED',
        claimVersion: 1,
        claimToken: null,
        leaseUntil: null,
        completedAt: expect.any(Date),
      })
      expect(after.runs[0]!.reason).toBeTruthy()
      expect({ ...after, runs: before.runs }).toStrictEqual(before)
      expect(await service().claim(f.org, run.id)).toBeNull()
      expect(await state(f.org)).toStrictEqual(after)
    },
  )

  it.each(['connection-first', 'read-first'] as const)(
    'verkliga lås ordnar anslutningsbyte och läsning: %s',
    async (order) => {
      const f = await fixture(),
        run = await service().start(f.org, null, INPUT),
        lease = await mustClaim(f.org, run.id)
      const reader = await controlled(),
        changer = await controlled(),
        held = deferred(),
        resume = deferred()
      let reached = false
      reader.hooks.after = async (params, result) => {
        if (
          order !== 'read-first' ||
          reached ||
          params.model !== 'FortnoxReadRun' ||
          params.action !== 'findUnique'
        )
          return
        expect(result).toMatchObject({ id: run.id, claimToken: lease.claimToken })
        reached = true
        held.resolve()
        await resume.promise
      }
      changer.hooks.after = async (params) => {
        if (
          order !== 'connection-first' ||
          params.model !== 'FortnoxConnection' ||
          params.action !== 'update'
        )
          return
        reached = true
        held.resolve()
        await resume.promise
      }
      const read = () =>
        service(reader.client).readSourcePage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n })
      const change = () =>
        tx(
          (c) =>
            c.fortnoxConnection.update({
              where: { organizationId: f.org },
              data: { generation: { increment: 1 } },
            }),
          changer.client,
        )
      const first = order === 'connection-first' ? change() : read(),
        firstDone = Promise.allSettled([first])
      let secondDone: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        await Promise.race([
          held.promise,
          first.then(() => {
            throw new Error('Låsbarriären missades')
          }),
        ])
        const second = order === 'connection-first' ? read() : change()
        secondDone = Promise.allSettled([second])
        await waitBlocked(
          order === 'connection-first' ? reader.pid : changer.pid,
          order === 'connection-first' ? changer.pid : reader.pid,
        )
        resume.resolve()
        if (order === 'connection-first') {
          await first
          await expect(second).rejects.toBeInstanceOf(ConflictException)
        } else {
          expect(await first).toStrictEqual({ items: [], nextAfterOrdinal: null })
          await second
          await expect(read()).rejects.toBeInstanceOf(ConflictException)
        }
        expect(reached).toBe(true)
        expect(await current(run.id)).toMatchObject({
          status: 'FAILED',
          claimToken: null,
          leaseUntil: null,
        })
      } finally {
        resume.resolve()
        await firstDone
        if (secondDone) await secondDone
        await reader.client.$disconnect()
        await changer.client.$disconnect()
      }
    },
  )

  it('start byter legitim stale källa under aktiv lease atomiskt; v1 får inte stoppa den', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    await mustClaim(f.org, run.id)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { generation: { increment: 1 } },
    })
    const before = await state(f.org)
    await expect(
      new FortnoxReadCheckpointService(db()).start(f.org, null, INPUT),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await state(f.org)).toStrictEqual(before)
    const next = await service().start(f.org, null, INPUT),
      after = await durableState(f.org)
    expect(next.id).not.toBe(run.id)
    expect(next).toMatchObject({
      claimVersion: 0,
      claimToken: null,
      leaseUntil: null,
      connectionGeneration: 1,
    })
    expect(after.runs.find((row) => row.id === run.id)).toMatchObject({
      status: 'FAILED',
      claimVersion: 1,
      claimToken: null,
      leaseUntil: null,
    })
    expect(after.runs.filter((row) => row.status === 'RUNNING')).toStrictEqual([next])
    expect(after.captures).toHaveLength(2)
    expect(after.captures.find((row) => row.id === run.id)).toStrictEqual(before.captures[0])
  })

  it('ledig claim på ändrad anslutning stoppar körningen och ger null', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { status: 'DISCONNECTED' },
    })
    expect(await service().claim(f.org, run.id)).toBeNull()
    expect((await durableState(f.org)).runs[0]).toMatchObject({
      status: 'FAILED',
      claimVersion: 0,
      claimToken: null,
      leaseUntil: null,
    })
  })

  it.each(['claim', 'renew'] as const)(
    'fel efter verklig %s-UPDATE rullar tillbaka hela anspråksändringen',
    async (kind) => {
      const f = await fixture(),
        run = await service().start(f.org, null, INPUT)
      const lease = kind === 'renew' ? await mustClaim(f.org, run.id) : null
      if (lease) await databaseAfter(new Date(lease.leaseUntil.getTime() - 60_000 + 2))
      const before = await state(f.org),
        c = await controlled(),
        failure = new Error(`SYNTHETIC_${kind}_ROLLBACK`)
      let updated = false
      c.hooks.after = async (params, result) => {
        if (params.model !== 'FortnoxReadRun' || params.action !== 'update') return
        expect(params.runInTransaction).toBe(true)
        expect(params.args).toMatchObject({ where: { id: run.id } })
        expect(result).toMatchObject({ claimVersion: 1, claimToken: expect.any(String) })
        updated = true
        throw failure
      }
      try {
        await expect(
          lease ? service(c.client).renew(lease) : service(c.client).claim(f.org, run.id),
        ).rejects.toBe(failure)
        expect(updated).toBe(true)
        expect(await durableState(f.org)).toStrictEqual(before)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it('förlorat claim-kvitto ger inget nytt ägarskap: startreplay bevarar vinnaren', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      failure = new Error('SYNTHETIC_LOST_CLAIM_RECEIPT')
    let issued: SourceRunLease | undefined
    await expect(
      (async () => {
        issued = await mustClaim(f.org, run.id)
        throw failure
      })(),
    ).rejects.toBe(failure)
    expect(issued).toBeDefined()
    const before = await durableState(f.org)
    expect(await service().claim(f.org, run.id)).toBeNull()
    expect(await service().start(f.org, null, INPUT)).toStrictEqual(before.runs[0])
    expect(await state(f.org)).toStrictEqual(before)
  })

  it.each([
    { name: 'token utan deadline', set: Prisma.sql`"leaseUntil"=NULL` },
    { name: 'versionsminskning', set: Prisma.sql`"claimVersion"=0` },
    {
      name: 'versionshopp',
      set: Prisma.sql`"claimVersion"="claimVersion"+2, "claimToken"=${randomUUID()}`,
    },
    {
      name: 'stulen tokenförnyelse',
      set: Prisma.sql`"claimToken"=${randomUUID()}, "leaseUntil"=timezone('UTC',clock_timestamp())+interval '60 seconds'`,
    },
    {
      name: 'över 60 sekunder',
      set: Prisma.sql`"leaseUntil"=timezone('UTC',clock_timestamp())+interval '61 seconds'`,
    },
    {
      name: 'framtida checkpointtid',
      set: Prisma.sql`"checkpointUpdatedAt"=timezone('UTC',clock_timestamp())+interval '1 second', "claimToken"=NULL, "leaseUntil"=NULL`,
    },
    { name: 'förkortning', set: Prisma.sql`"leaseUntil"="leaseUntil"-interval '1 second'` },
    { name: 'ny progress', set: Prisma.sql`"nextManifestPage"=2` },
    { name: 'främmande källa', set: Prisma.sql`"sourceCaptureId"=${randomUUID()}` },
  ])('SQL nekar $name efter en positiv giltig claim', async ({ set }) => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      lease = await mustClaim(f.org, run.id)
    expect(await current(run.id)).toMatchObject(ownership(lease))
    await sqlRejected(run, set)
  })

  it('SQL tillåter 60-sekundersanspråk och omedelbart legitimt stopp med samma UTC-ms-precision', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      token = randomUUID()
    await tx(async (c) => {
      await c.$executeRaw`SET LOCAL TIME ZONE 'Europe/Stockholm'`
      expect(
        await c.$executeRaw`
        UPDATE "FortnoxReadRun" SET "claimVersion"=1, "claimToken"=${token},
          "leaseUntil"=timezone('UTC',clock_timestamp())::timestamp(3)+interval '60 seconds',
          "checkpointUpdatedAt"=timezone('UTC',clock_timestamp())::timestamp(3)
        WHERE id=${run.id} AND "organizationId"=${f.org}`,
      ).toBe(1)
    })
    const claimed = await current(run.id)
    expect(claimed).toMatchObject({
      claimVersion: 1,
      claimToken: token,
      leaseUntil: expect.any(Date),
    })
    await tx(async (c) => {
      await c.$executeRaw`SET LOCAL TIME ZONE 'Europe/Stockholm'`
      expect(
        await c.$executeRaw`
        UPDATE "FortnoxReadRun" SET status='FAILED', reason='SYNTHETIC_LEGITIMATE_STOP',
          "completedAt"=timezone('UTC',clock_timestamp())::timestamp(3),
          "checkpointUpdatedAt"=timezone('UTC',clock_timestamp())::timestamp(3),
          "claimToken"=NULL, "leaseUntil"=NULL
        WHERE id=${run.id} AND "organizationId"=${f.org}`,
      ).toBe(1)
    })
    expect((await durableState(f.org)).runs[0]).toMatchObject({
      status: 'FAILED',
      claimVersion: 1,
      claimToken: null,
      leaseUntil: null,
      reason: 'SYNTHETIC_LEGITIMATE_STOP',
    })
  })

  it('SQL nekar förnyelse och release efter faktisk DB-utgång, men korrekt takeover går', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT)
    const lease = await mustClaim(f.org, run.id, new ShortLeaseService(db()))
    await databaseAfter(lease.leaseUntil)
    await sqlRejected(
      run,
      Prisma.sql`"leaseUntil"=timezone('UTC',clock_timestamp())+interval '60 seconds'`,
    )
    await sqlRejected(run, Prisma.sql`"claimToken"=NULL,"leaseUntil"=NULL`)
    const next = await mustClaim(f.org, run.id)
    expect(next.claimVersion).toBe(2)
    expect(next.claimToken).not.toBe(lease.claimToken)
  })

  it('terminal v2 kan inte återöppnas/raderas direkt; riktig orgcascade bevarar främmande ägare', async () => {
    const f = await fixture(),
      other = await fixture(),
      run = await service().start(f.org, null, INPUT)
    const foreign = await service().start(other.org, null, INPUT)
    await mustClaim(other.org, foreign.id)
    const foreignBefore = await state(other.org)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { generation: { increment: 1 } },
    })
    expect(await service().claim(f.org, run.id)).toBeNull()
    await sqlRejected(run, Prisma.sql`status='RUNNING',reason=NULL,"completedAt"=NULL`)
    await expect(
      tx((c) => c.$executeRaw`DELETE FROM "FortnoxReadRun" WHERE id=${run.id}`),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    expect((await current(run.id)).status).toBe('FAILED')
    await db().organization.delete({ where: { id: f.org } })
    orgs.delete(f.org)
    expect(await state(f.org)).toStrictEqual({ runs: [], captures: [], mappings: [], exports: [] })
    expect(await state(other.org)).toStrictEqual(foreignBefore)
  })
})
