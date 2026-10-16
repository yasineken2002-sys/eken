/** Riktig PostgreSQL, egna syntetiska underlag. Inga provideranrop eller köer.
 * Testar endast atomisk SOURCE_CAPTURED-start; de 72 källproven behåller sitt
 * eget form-/pagingfacit. Barriärer omger riktiga queries, aldrig låtsasresultat.
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient, type FortnoxReadRun } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import { FortnoxReadSourceRunService } from './fortnox-read-source-run.service'
import { captureCheckpointSource, readCheckpointSourceHeader } from './fortnox-read-source-capture'
import { checkpointDigest, type StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { kallkonton } from './fortnox-read-provenance'

const COMPANY = 900001
const INPUT = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170, 5190],
} satisfies StartCheckpointInput
const RAW = 'SYNTHETIC_SOURCE_RUN_PRIVATE_DRAFT'
const DRAFT = {
  payload: { marker: RAW },
  kontomappning: { revision: 7 },
  provenance: { lines: [{ localAccountNumber: 5170, externalAccountNumber: 5171 }] },
}

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Source-run kräver uttrycklig lokal testdatabas')
  const value = new URL(raw),
    name = decodeURIComponent(value.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(value.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Source-run tillåter bara egen lokal kapacitetsdatabas eller CI:s eken_dev')
  value.searchParams.set('connection_limit', '4')
  return value.toString()
}
const DATABASE_URL = isolatedUrl() // Ovillkorlig grind, aldrig describe.skip.

class TestPrisma extends PrismaClient {
  async onModuleInit() {
    await this.$connect()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
  transform?: (params: Prisma.MiddlewareParams, result: unknown) => unknown
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

describe('Inert Fortnox source-run mot riktig PostgreSQL', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>()
  const accountIds = new Set<string>()
  let sequence = 0
  function db() {
    if (!prisma) throw new Error('Source-run-fixture har inte startat')
    return prisma
  }
  const service = (client = db()) => new FortnoxReadSourceRunService(client)
  const v1 = (client = db()) => new FortnoxReadCheckpointService(client)
  const tx = <T>(work: (client: Prisma.TransactionClient) => Promise<T>, client = db()) =>
    client.$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  const rr = <T>(work: (client: Prisma.TransactionClient) => Promise<T>, client = db()) =>
    client.$transaction(work, {
      ...PRISMA_DEFAULT_TX_LIMITS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    })

  async function controlled() {
    const url = new URL(DATABASE_URL)
    // Egen pool med en anslutning: uppmätt PID är samma som startens verkliga Tx.
    url.searchParams.set('connection_limit', '1')
    const client = new TestPrisma({ datasources: { db: { url: url.toString() } } })
    const hooks: Hooks = {}
    client.$use(async (params, next) => {
      await hooks.before?.(params)
      const result = await next(params)
      await hooks.after?.(params, result)
      return hooks.transform ? hooks.transform(params, result) : result
    })
    await client.$connect()
    const pid = (await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!
      .pid
    return { client, hooks, pid }
  }
  async function fixture() {
    const org = randomUUID(),
      propertyId = randomUUID(),
      journalId = randomUUID(),
      exportId = randomUUID()
    const bank = randomUUID(),
      expense = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-source-run-${org}`,
        email: `${org}@example.invalid`,
        street: 'Syntetisk gata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    orgs.add(org)
    journals.add(journalId)
    exports.add(exportId)
    accountIds.add(bank)
    accountIds.add(expense)
    const connection = await db().fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: COMPANY,
        fortnoxOrgNumber: 'SYNTHETIC_COMPANY',
      },
    })
    await tx(async (client) => {
      await client.property.create({
        data: {
          id: propertyId,
          organizationId: org,
          name: 'Syntetiskt hus',
          propertyDesignation: `TEST ${propertyId} 1:1`,
          type: 'RESIDENTIAL',
          street: 'Testgata 2',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: '100.00',
        },
      })
      await client.fortnoxDimensionMapping.create({
        data: { organizationId: org, propertyId, dimensionType: 'COST_CENTER', code: 'A' },
      })
      await client.account.createMany({
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
      await client.journalEntry.create({
        data: {
          id: journalId,
          organizationId: org,
          date: new Date('2026-01-01T00:00:00Z'),
          description: RAW,
          source: 'MANUAL',
          sourceId: `synthetic:${journalId}`,
          fiscalYear: 2026,
          series: 'A',
          verNumber: ++sequence,
          lines: {
            create: [
              { accountId: bank, debit: '0.00', credit: '100.00' },
              { accountId: expense, debit: '100.00', credit: '0.00' },
            ],
          },
        },
      })
      await client.fortnoxVoucherExport.create({
        data: {
          id: exportId,
          organizationId: org,
          journalEntryId: journalId,
          state: 'CONFIRMED',
          fortnoxDatabaseNumber: COMPANY,
          externalYear: 1,
          externalSeries: 'L',
          externalNumber: ++sequence,
          draft: DRAFT,
        },
      })
    })
    return { org, propertyId, journalId, exportId, bank, expense, connection }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
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
  async function independentlyEmpty(org: string) {
    const observer = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      await observer.$connect()
      expect(await state(org, observer)).toStrictEqual({
        runs: [],
        captures: [],
        mappings: [],
        exports: [],
      })
    } finally {
      await observer.$disconnect()
    }
  }
  async function removeFixture(f: Fixture, client = db()) {
    const owner = await client.organization.findUniqueOrThrow({
      where: { id: f.org },
      select: { name: true },
    })
    expect(owner.name).toBe(`synthetic-source-run-${f.org}`)
    await tx(async (c) => {
      await c.fortnoxVoucherExport.deleteMany({ where: { id: f.exportId, organizationId: f.org } })
      await c.journalEntryLine.deleteMany({ where: { journalEntryId: f.journalId } })
      await c.journalEntry.deleteMany({ where: { id: f.journalId, organizationId: f.org } })
      await c.account.deleteMany({
        where: { id: { in: [f.bank, f.expense] }, organizationId: f.org },
      })
      await c.organization.delete({ where: { id: f.org } })
    }, client)
    orgs.delete(f.org)
  }
  async function waitBlocked(pid: number, blocker: number) {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const rows = await db().$queryRaw<Array<{ blockers: number[]; query: string }>>(Prisma.sql`
        SELECT pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE pid=${pid}`)
      if (rows[0]?.blockers.includes(blocker)) {
        expect(rows[0].query).toContain('FortnoxConnection')
        expect(rows[0].query).toContain('FOR UPDATE')
        return
      }
    }
    throw new Error('Startens verkliga connection-låsväntan observerades inte')
  }
  function expectedConcurrentFailure(error: unknown) {
    if (error instanceof ConflictException) return
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error
    expect(
      error.code === 'P2002' ||
        error.code === 'P2034' ||
        (error.code === 'P2010' && error.meta?.code === '40001'),
    ).toBe(true)
  }
  async function source(f: Fixture, id: string = randomUUID()) {
    return rr((c) => captureCheckpointSource(c, f.org, id, INPUT))
  }
  function rawRun(
    f: Fixture,
    capture: Awaited<ReturnType<typeof source>>,
  ): Prisma.FortnoxReadRunUncheckedCreateInput {
    return {
      id: capture.id,
      organizationId: f.org,
      connectionId: capture.connectionId,
      connectionGeneration: capture.connectionGeneration,
      fortnoxDatabaseNumber: capture.fortnoxDatabaseNumber,
      fortnoxOrgNumber: capture.fortnoxOrgNumber,
      sourceCaptureId: capture.id,
      workVersion: 2,
      phase: 'SOURCE_CAPTURED',
      requestHash: capture.requestHash,
      financialYearId: INPUT.financialYearId,
      periodFrom: new Date(`${INPUT.periodFrom}T00:00:00Z`),
      periodTo: new Date(`${INPUT.periodTo}T00:00:00Z`),
      costAccounts: INPUT.costAccounts,
      checkpointUpdatedAt: capture.createdAt,
    }
  }
  function insertRawRun(
    c: Prisma.TransactionClient,
    f: Fixture,
    capture: Awaited<ReturnType<typeof source>>,
    patch: Partial<Prisma.FortnoxReadRunUncheckedCreateInput> = {},
  ) {
    const d = { ...rawRun(f, capture), ...patch }
    return c.$queryRaw<FortnoxReadRun[]>(Prisma.sql`
      INSERT INTO "FortnoxReadRun" (id,"organizationId","connectionId","connectionGeneration",
        "fortnoxDatabaseNumber","fortnoxOrgNumber","sourceCaptureId","workVersion",phase,
        "requestHash","financialYearId","periodFrom","periodTo","costAccounts","checkpointUpdatedAt")
      VALUES (${d.id},${d.organizationId},${d.connectionId},${d.connectionGeneration},
        ${d.fortnoxDatabaseNumber},${d.fortnoxOrgNumber ?? null},${d.sourceCaptureId ?? null},
        ${d.workVersion ?? null},${d.phase ?? null}::"FortnoxReadPhase",${d.requestHash},
        ${d.financialYearId},${d.periodFrom}::date,${d.periodTo}::date,${d.costAccounts}::integer[],
        ${d.checkpointUpdatedAt}) RETURNING *`)
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
          `synthetic-source-run-${org}`,
        )
      await prisma.fortnoxVoucherExport.deleteMany({ where: { id: { in: [...exports] } } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntryId: { in: [...journals] } } })
      await prisma.journalEntry.deleteMany({ where: { id: { in: [...journals] } } })
      await prisma.account.deleteMany({ where: { id: { in: [...accountIds] } } })
      for (const org of orgs) await prisma.organization.delete({ where: { id: org } })
    } finally {
      await prisma.$disconnect()
    }
  })

  it('KANARIEFÅGEL: explicit lokal DB och inert start returnerar exakt committad run med egen källa', async () => {
    expect(await db().$queryRaw(Prisma.sql`SELECT current_database() AS name`)).toStrictEqual([
      { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
    const f = await fixture(),
      user = randomUUID()
    const run = await service().start(f.org, user, INPUT),
      actual = await state(f.org)
    expect(actual.runs).toStrictEqual([run])
    expect(actual.captures).toHaveLength(1)
    expect(actual.mappings).toHaveLength(1)
    expect(actual.exports).toHaveLength(1)
    expect(run).toMatchObject({
      sourceCaptureId: run.id,
      workVersion: 2,
      phase: 'SOURCE_CAPTURED',
      status: 'RUNNING',
      frozenContext: null,
      catalog: null,
      summary: null,
      rows: null,
      financialYearStart: null,
      financialYearEnd: null,
      completedAt: null,
      claimVersion: 0,
      claimToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      nextManifestPage: 1,
      triggeredByUserId: user,
      requestHash: checkpointDigest(INPUT),
    })
    expect(actual.captures[0]).toMatchObject({
      id: run.id,
      organizationId: f.org,
      sealedAt: expect.any(Date),
      input: INPUT,
      requestHash: run.requestHash,
      connectionId: run.connectionId,
      connectionGeneration: run.connectionGeneration,
      fortnoxDatabaseNumber: run.fortnoxDatabaseNumber,
      fortnoxOrgNumber: run.fortnoxOrgNumber,
    })
    expect(
      JSON.stringify(actual.exports, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(RAW)
    expect(await db().fortnoxReadContextSnapshot.count({ where: { organizationId: f.org } })).toBe(
      0,
    )
    expect(await db().fortnoxReadManifestPage.count({ where: { organizationId: f.org } })).toBe(0)
    expect(
      await db().fortnoxReadVoucherCheckpoint.count({ where: { organizationId: f.org } }),
    ).toBe(0)
  })

  it('rå kontokälla som senare ger TypeError är ändå SOURCE_CAPTURED, aldrig validerad kontext', async () => {
    const f = await fixture()
    await db().fortnoxVoucherExport.update({
      where: { id: f.exportId },
      data: { draft: { provenance: { lines: [null] } } },
    })
    const run = await service().start(f.org, null, INPUT),
      actual = await state(f.org)
    expect(actual.exports).toHaveLength(1)
    expect(() => kallkonton(actual.exports[0]!.accountSource)).toThrow(TypeError)
    expect(run).toMatchObject({
      status: 'RUNNING',
      phase: 'SOURCE_CAPTURED',
      frozenContext: null,
      summary: null,
      rows: null,
    })
  })

  it('ny instans replayar samma canonical input och första underlag trots live- och tokenVersionändring', async () => {
    const f = await fixture(),
      actor = randomUUID()
    const input = {
      financialYearId: 1,
      periodFrom: INPUT.periodFrom,
      periodTo: INPUT.periodTo,
      costAccounts: [5190, 5170, 5170],
      financialYearStart: undefined,
      financialYearEnd: undefined,
    }
    const first = await service().start(f.org, actor, input),
      before = await state(f.org)
    await db().property.update({
      where: { id: f.propertyId },
      data: { name: 'SYNTHETIC_LATER_NAME' },
    })
    await db().fortnoxVoucherExport.update({
      where: { id: f.exportId },
      data: { draft: {}, externalNumber: 999 },
    })
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { tokenVersion: { increment: 1 } },
    })
    const other = await controlled()
    try {
      expect(
        await service(other.client).start(f.org, randomUUID(), {
          financialYearId: 1,
          periodFrom: INPUT.periodFrom,
          periodTo: INPUT.periodTo,
          costAccounts: [5170, 5190],
        }),
      ).toStrictEqual(first)
      expect(await state(f.org, other.client)).toStrictEqual(before)
      expect(before.captures[0]!.input).not.toHaveProperty('financialYearStart')
      expect(before.captures[0]!.input).not.toHaveProperty('financialYearEnd')
    } finally {
      await other.client.$disconnect()
    }
  })

  it('förlorat kvitto efter verklig startcommit återhämtas utan en andra run eller källa', async () => {
    const f = await fixture(),
      lost = new Error('SYNTHETIC_LOST_START_RECEIPT')
    let persisted: FortnoxReadRun | undefined
    await expect(
      (async () => {
        persisted = await service().start(f.org, null, INPUT)
        throw lost
      })(),
    ).rejects.toBe(lost)
    expect(persisted).toBeDefined()
    const before = await state(f.org)
    expect(await service().start(f.org, null, INPUT)).toStrictEqual(persisted)
    expect(await state(f.org)).toStrictEqual(before)
  })

  it.each(['bad-input', 'inactive', 'other-input'] as const)(
    '%s nekas utan ny källa',
    async (kind) => {
      const f = await fixture()
      if (kind === 'other-input') await service().start(f.org, null, INPUT)
      if (kind === 'inactive')
        await db().fortnoxConnection.update({
          where: { organizationId: f.org },
          data: { status: 'DISCONNECTED' },
        })
      const before = await state(f.org)
      await expect(
        service().start(f.org, null, {
          ...INPUT,
          periodFrom: kind === 'bad-input' ? '2026-02-30' : '2026-10-02',
        }),
      ).rejects.toBeInstanceOf(kind === 'bad-input' ? BadRequestException : ConflictException)
      expect(await state(f.org)).toStrictEqual(before)
    },
  )

  it('stale v2 markeras FAILED och ersätts atomiskt med ny källa för ny aktiv generation', async () => {
    const f = await fixture(),
      first = await service().start(f.org, null, INPUT),
      before = await state(f.org)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: {
        generation: { increment: 1 },
        fortnoxOrgNumber: 'SYNTHETIC_ROTATED_COMPANY',
      },
    })
    const next = await service().start(f.org, null, INPUT),
      after = await state(f.org)
    expect(next.id).not.toBe(first.id)
    expect(next).toMatchObject({
      connectionGeneration: 1,
      fortnoxOrgNumber: 'SYNTHETIC_ROTATED_COMPANY',
      status: 'RUNNING',
    })
    const old = after.runs.find((run) => run.id === first.id)
    expect(old).toMatchObject({
      status: 'FAILED',
      completedAt: expect.any(Date),
      sourceCaptureId: first.sourceCaptureId,
    })
    expect(after.runs.filter((run) => run.status === 'RUNNING')).toStrictEqual([next])
    expect(after.captures.find((c) => c.id === first.sourceCaptureId)).toStrictEqual(
      before.captures[0],
    )
    expect(after.mappings.filter((c) => c.captureId === first.sourceCaptureId)).toStrictEqual(
      before.mappings,
    )
    expect(after.exports.filter((c) => c.captureId === first.sourceCaptureId)).toStrictEqual(
      before.exports,
    )
    expect(after.captures).toHaveLength(2)
  })

  it.each([false, true])(
    'v1 konflikterar före terminalisering av v2 även vid stale=%s',
    async (stale) => {
      const f = await fixture()
      const run = await service().start(f.org, null, INPUT)
      if (stale)
        await db().fortnoxConnection.update({
          where: { organizationId: f.org },
          data: { generation: { increment: 1 } },
        })
      const before = await state(f.org)
      await expect(v1().start(f.org, null, INPUT)).rejects.toBeInstanceOf(ConflictException)
      expect(await v1().claim(f.org, run.id)).toBeNull()
      expect(await state(f.org)).toStrictEqual(before)
    },
  )

  it.each([false, true])(
    'v2 adopterar eller terminaliserar aldrig v1 även vid stale=%s',
    async (stale) => {
      const f = await fixture()
      await v1().start(f.org, null, INPUT)
      if (stale)
        await db().fortnoxConnection.update({
          where: { organizationId: f.org },
          data: { generation: { increment: 1 } },
        })
      const before = await state(f.org)
      await expect(service().start(f.org, null, INPUT)).rejects.toBeInstanceOf(ConflictException)
      expect(await state(f.org)).toStrictEqual(before)
    },
  )

  it.each([
    { winner: 1, loser: 2, sameInput: true },
    { winner: 2, loser: 1, sameInput: true },
    { winner: 2, loser: 2, sameInput: true },
    { winner: 2, loser: 2, sameInput: false },
  ])(
    'verklig låsväntan: v$winner vinner mot v$loser, sameInput=$sameInput',
    async ({ winner, loser, sameInput }) => {
      const f = await fixture(),
        a = await controlled(),
        b = await controlled()
      const inserted = deferred(),
        release = deferred()
      let insertedId: string | undefined
      a.hooks.after = async (params, result) => {
        if (params.model !== 'FortnoxReadRun' || params.action !== 'create') return
        expect(params.runInTransaction).toBe(true)
        if (!record(result) || typeof result.id !== 'string')
          throw new Error('Verklig runINSERT saknade id')
        insertedId = result.id
        inserted.resolve()
        await release.promise
      }
      const launch = (version: number, client: TestPrisma, input: StartCheckpointInput) =>
        (version === 1 ? v1(client) : service(client)).start(f.org, null, input)
      const first = launch(winner, a.client, INPUT),
        firstOutcome = Promise.allSettled([first])
      let secondOutcome: Promise<PromiseSettledResult<FortnoxReadRun>[]> | undefined
      try {
        await Promise.race([
          inserted.promise,
          first.then(() => {
            throw new Error('Vinnaren passerade barriären')
          }),
        ])
        expect(insertedId).toBeDefined()
        expect(await db().fortnoxReadRun.findUnique({ where: { id: insertedId! } })).toBeNull()
        const second = launch(
          loser,
          b.client,
          sameInput ? INPUT : { ...INPUT, periodTo: '2026-10-30' },
        )
        secondOutcome = Promise.allSettled([second])
        await waitBlocked(b.pid, a.pid)
        release.resolve()
        const won = await first,
          [lost] = await secondOutcome
        expect(lost?.status).toBe('rejected')
        if (lost?.status === 'rejected') expectedConcurrentFailure(lost.reason)
        const actual = await state(f.org)
        expect(actual.runs).toStrictEqual([won])
        expect(actual.captures).toHaveLength(winner === 2 ? 1 : 0)
        expect(actual.mappings).toHaveLength(winner === 2 ? 1 : 0)
        expect(actual.exports).toHaveLength(winner === 2 ? 1 : 0)
        if (winner === 2 && loser === 2 && sameInput)
          expect(await service(b.client).start(f.org, null, INPUT)).toStrictEqual(won)
        else
          await expect(
            launch(loser, b.client, sameInput ? INPUT : { ...INPUT, periodTo: '2026-10-30' }),
          ).rejects.toBeInstanceOf(ConflictException)
        expect(await state(f.org)).toStrictEqual(actual)
      } finally {
        release.resolve()
        await firstOutcome
        if (secondOutcome) await secondOutcome
        await a.client.$disconnect()
        await b.client.$disconnect()
      }
    },
  )

  it.each(['before-run', 'after-run'] as const)(
    'fel %s efter verklig källseal rullar tillbaka run och alla källrader',
    async (stage) => {
      const f = await fixture(),
        c = await controlled(),
        injected = new Error(`SYNTHETIC_${stage}`)
      let sealed = false,
        inserted = false,
        faultReached = false
      c.hooks.after = async (params, result) => {
        if (
          params.action === 'queryRaw' &&
          Array.isArray(result) &&
          record(result[0]) &&
          result[0].organizationId === f.org &&
          result[0].sealedAt instanceof Date
        ) {
          expect(result[0]).toMatchObject({ mappingCount: 1, exportCount: 1 })
          sealed = true
        }
        if (params.model === 'FortnoxReadRun' && params.action === 'create') {
          inserted = true
          if (stage === 'after-run') {
            faultReached = true
            throw injected
          }
        }
      }
      c.hooks.before = async (params) => {
        if (
          stage === 'before-run' &&
          params.model === 'FortnoxReadRun' &&
          params.action === 'create'
        ) {
          expect(sealed).toBe(true)
          faultReached = true
          throw injected
        }
      }
      try {
        await expect(service(c.client).start(f.org, null, INPUT)).rejects.toBe(injected)
        expect(sealed).toBe(true)
        expect(faultReached).toBe(true)
        expect(inserted).toBe(stage === 'after-run')
        await independentlyEmpty(f.org)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it('misslyckad ersättning av stale v2 återställer även föregående RUNNING-status', async () => {
    const f = await fixture()
    await service().start(f.org, null, INPUT)
    const before = await state(f.org),
      c = await controlled(),
      injected = new Error('SYNTHETIC_REPLACEMENT_FAILURE')
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { generation: { increment: 1 } },
    })
    let oldFailed = false,
      newInserted = false
    c.hooks.after = async (params, result) => {
      if (params.model === 'FortnoxReadRun' && params.action === 'update') {
        expect(result).toMatchObject({ id: before.runs[0]!.id, status: 'FAILED' })
        oldFailed = true
      }
      if (params.model === 'FortnoxReadRun' && params.action === 'create') {
        newInserted = true
        throw injected
      }
    }
    try {
      await expect(service(c.client).start(f.org, null, INPUT)).rejects.toBe(injected)
      expect(oldFailed).toBe(true)
      expect(newInserted).toBe(true)
      expect(await state(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('postcommitläsningen nekar framgång om riktig commit följts av egen orgcascade', async () => {
    const f = await fixture(),
      c = await controlled()
    let createdId: string | undefined,
      committedObserved = false,
      removed = false
    c.hooks.after = async (params, result) => {
      if (params.model === 'FortnoxReadRun' && params.action === 'create') {
        if (!record(result) || typeof result.id !== 'string')
          throw new Error('RunINSERT saknar identitet')
        createdId = result.id
      }
    }
    c.hooks.before = async (params) => {
      if (
        !createdId ||
        removed ||
        params.model !== 'FortnoxReadRun' ||
        params.action !== 'findUnique'
      )
        return
      // Separat pool ser raden endast efter riktig COMMIT. Därefter sker en
      // verklig radering, inget mockat tomt ORM-resultat eller enginebuggspåstående.
      expect(await db().fortnoxReadRun.findUnique({ where: { id: createdId } })).toMatchObject({
        id: createdId,
        status: 'RUNNING',
      })
      committedObserved = true
      await removeFixture(f)
      removed = true
    }
    try {
      await expect(service(c.client).start(f.org, null, INPUT)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(committedObserved).toBe(true)
      expect(removed).toBe(true)
      await independentlyEmpty(f.org)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('managed-gate överför inte v1:s frozenContext innan versionskonflikten', async () => {
    const f = await fixture(),
      existing = await v1().start(f.org, null, INPUT),
      c = await controlled()
    let checked = false
    c.hooks.after = async (params, result) => {
      if (params.model !== 'FortnoxReadRun' || params.action !== 'findFirst') return
      expect(params.args).toMatchObject({
        select: { id: true, workVersion: true, requestHash: true },
      })
      if (!record(result)) throw new Error('Den riktiga v1-grinden saknade rad')
      expect(Object.keys(result).sort()).toStrictEqual(['id', 'requestHash', 'workVersion'])
      expect(result.id).toBe(existing.id)
      checked = true
    }
    try {
      await expect(service(c.client).start(f.org, null, INPUT)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(checked).toBe(true)
      expect((await state(f.org)).runs).toStrictEqual([existing])
    } finally {
      await c.client.$disconnect()
    }
  })

  it('korrupt verkligt v2-läsresultat får inte behandlas som legitim generationsrotation', async () => {
    const f = await fixture()
    await service().start(f.org, null, INPUT)
    const before = await state(f.org),
      c = await controlled()
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { generation: { increment: 1 } },
    })
    let transformed = false
    c.hooks.transform = (params, result) => {
      if (params.model !== 'FortnoxReadRun' || params.action !== 'findUnique' || !record(result))
        return result
      expect(result.id).toBe(before.runs[0]!.id)
      transformed = true
      // Bara den verkliga läsreturen förvrängs; DB-invariants stängs aldrig av.
      return { ...result, requestHash: 'a'.repeat(64) }
    }
    try {
      await expect(service(c.client).start(f.org, null, INPUT)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(transformed).toBe(true)
      expect(await state(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('positiv SQL-kanarie: en korrekt rå bindning accepteras innan negativa SQL-fall prövas', async () => {
    const f = await fixture(),
      cap = await source(f)
    const [inserted] = await tx((c) => insertRawRun(c, f, cap))
    expect(inserted).toMatchObject({
      id: cap.id,
      sourceCaptureId: cap.id,
      workVersion: 2,
      status: 'RUNNING',
      phase: 'SOURCE_CAPTURED',
      requestHash: cap.requestHash,
    })
    expect(await service().start(f.org, null, INPUT)).toStrictEqual(inserted)
    expect((await state(f.org)).captures).toStrictEqual([cap])
  })

  it.each([
    'foreign-source',
    'company',
    'hash',
    'input',
    'id-not-source',
    'legacy-with-source',
    'missing-source',
  ] as const)('direkt SQL nekar %s utan att skada den riktiga förseglade källan', async (kind) => {
    const f = await fixture(),
      other = kind === 'foreign-source' ? await fixture() : undefined
    const cap = await source(other ?? f)
    const patch: Partial<Prisma.FortnoxReadRunUncheckedCreateInput> =
      kind === 'company'
        ? { fortnoxDatabaseNumber: COMPANY + 1 }
        : kind === 'hash'
          ? { requestHash: 'a'.repeat(64) }
          : kind === 'input'
            ? { costAccounts: [5170] }
            : kind === 'id-not-source'
              ? { id: randomUUID() }
              : kind === 'legacy-with-source'
                ? { workVersion: null }
                : kind === 'missing-source'
                  ? { sourceCaptureId: randomUUID() }
                  : {}
    await expect(tx((c) => insertRawRun(c, f, cap, patch))).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: kind === 'foreign-source' || kind === 'missing-source' ? '23503' : '23514' },
    })
    expect(await db().fortnoxReadRun.count({ where: { organizationId: f.org } })).toBe(0)
    expect(
      await tx((c) => readCheckpointSourceHeader(c, other?.org ?? f.org, cap.id)),
    ).toStrictEqual(cap)
  })

  it('oförseglad källa kan inte bindas till en run ens i samma transaktion', async () => {
    const f = await fixture(),
      id = randomUUID()
    await expect(
      tx(async (c) => {
        const raw = await c.fortnoxReadSourceCapture.create({
          data: {
            id,
            organizationId: f.org,
            connectionId: f.connection.id,
            connectionGeneration: 0,
            fortnoxDatabaseNumber: COMPANY,
            fortnoxOrgNumber: f.connection.fortnoxOrgNumber,
            input: INPUT,
            requestHash: checkpointDigest(INPUT),
          },
        })
        // Den förväntat giltiga inputformen typas separat; headern är avsiktligt oselad.
        await insertRawRun(c, f, { ...raw, input: INPUT })
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    await independentlyEmpty(f.org)
  })

  it('SQL skyddar v2-identitet, fas, resultat, direktdelete och FAILED från återöppning', async () => {
    const f = await fixture(),
      run = await service().start(f.org, null, INPUT),
      before = await state(f.org)
    const actions = [
      Prisma.sql`UPDATE "FortnoxReadRun" SET "connectionGeneration"=1 WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "organizationId"=${randomUUID()} WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "sourceCaptureId"=${randomUUID()} WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "workVersion"=NULL WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "workVersion"=1 WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET phase='CATALOG' WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET status='COMPLETE' WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET summary='{}'::jsonb WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET rows='[]'::jsonb WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "triggeredByUserId"=${randomUUID()} WHERE id=${run.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadRun" WHERE id=${run.id}`,
      Prisma.sql`TRUNCATE "FortnoxReadRun" CASCADE`,
    ]
    for (const sql of actions)
      await expect(tx((c) => c.$executeRaw(sql))).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '23514' },
      })
    expect(await state(f.org)).toStrictEqual(before)
    await tx((c) =>
      c.$executeRaw(Prisma.sql`UPDATE "FortnoxReadRun" SET status='FAILED',reason='SYNTHETIC_STOP',
      "completedAt"=timezone('UTC',clock_timestamp()),"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()) WHERE id=${run.id}`),
    )
    const failed = await state(f.org)
    expect(failed.runs[0]).toMatchObject({ status: 'FAILED', reason: 'SYNTHETIC_STOP' })
    await expect(
      tx((c) =>
        c.$executeRaw(
          Prisma.sql`UPDATE "FortnoxReadRun" SET status='RUNNING',reason=NULL,"completedAt"=NULL WHERE id=${run.id}`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    await expect(
      tx((c) => c.$executeRaw(Prisma.sql`DELETE FROM "FortnoxReadRun" WHERE id=${run.id}`)),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    expect(await state(f.org)).toStrictEqual(failed)
  })

  it.each([null, 1])(
    'befintlig version %s kan inte konverteras till v2 eller adoptera källa',
    async (version) => {
      const f = await fixture()
      const existing =
        version === 1
          ? await v1().start(f.org, null, INPUT)
          : await db().fortnoxReadRun.create({
              data: {
                organizationId: f.org,
                connectionId: f.connection.id,
                fortnoxDatabaseNumber: COMPANY,
                financialYearId: 1,
                periodFrom: new Date('2026-10-01T00:00:00Z'),
                periodTo: new Date('2026-10-31T00:00:00Z'),
                costAccounts: INPUT.costAccounts,
              },
            })
      const cap = await source(f, existing.id),
        before = await state(f.org)
      await expect(
        tx((c) =>
          c.$executeRaw(Prisma.sql`UPDATE "FortnoxReadRun" SET "workVersion"=2,
      "sourceCaptureId"=${cap.id},phase='SOURCE_CAPTURED',"frozenContext"=NULL,
      "connectionGeneration"=0,"requestHash"=${cap.requestHash},"checkpointUpdatedAt"=timezone('UTC',clock_timestamp())
      WHERE id=${existing.id}`),
        ),
      ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
      expect(await state(f.org)).toStrictEqual(before)
    },
  )

  it('gemensam SQL-unique stoppar två RUNNING även utan services versionsgrind i båda riktningar', async () => {
    const a = await fixture(),
      b = await fixture()
    await v1().start(a.org, null, INPUT)
    const cap = await source(a)
    await expect(tx((c) => insertRawRun(c, a, cap))).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: '23505' },
    })
    const run = await service().start(b.org, null, INPUT)
    const context = { version: 1, input: INPUT, mappings: [], ownExports: [] }
    await expect(
      tx((c) =>
        c.$executeRaw(Prisma.sql`INSERT INTO "FortnoxReadRun"
      (id,"organizationId","connectionId","fortnoxDatabaseNumber","financialYearId","periodFrom","periodTo","costAccounts",
       "workVersion",phase,"connectionGeneration","requestHash","frozenContext","checkpointUpdatedAt")
      VALUES (${randomUUID()},${b.org},${b.connection.id},${COMPANY},1,'2026-10-01'::date,'2026-10-31'::date,
        ${INPUT.costAccounts}::integer[],1,'CATALOG',0,${checkpointDigest(INPUT)},${JSON.stringify(context)}::jsonb,
        timezone('UTC',clock_timestamp()))`),
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23505' } })
    expect((await state(a.org)).runs).toHaveLength(1)
    expect((await state(b.org)).runs).toStrictEqual([run])
  })

  it('legacy-null RUNNING och COMPLETE bevaras exakt; de är ingen managed samtidighetsgaranti', async () => {
    const f = await fixture()
    const base = {
      organizationId: f.org,
      connectionId: f.connection.id,
      fortnoxDatabaseNumber: COMPANY,
      financialYearId: 1,
      periodFrom: new Date('2026-10-01T00:00:00Z'),
      periodTo: new Date('2026-10-31T00:00:00Z'),
      costAccounts: INPUT.costAccounts,
    }
    const running = await db().fortnoxReadRun.create({ data: base })
    const complete = await db().fortnoxReadRun.create({
      data: {
        ...base,
        status: 'COMPLETE',
        completedAt: new Date(),
        summary: { totalOre: 100, currency: 'SEK' },
        rows: [{ marker: 'SYNTHETIC_LEGACY' }],
      },
    })
    const next = await service().start(f.org, null, INPUT)
    expect(next.workVersion).toBe(2)
    expect(
      await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: running.id } }),
    ).toStrictEqual(running)
    expect(
      await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: complete.id } }),
    ).toStrictEqual(complete)
    expect((await state(f.org)).captures).toHaveLength(1)
  })

  it('två orgar får egna starter och riktig orgcascade lämnar främmande run/källa exakt orörd', async () => {
    const a = await fixture(),
      b = await fixture()
    const [own, foreign] = await Promise.all([
      service().start(a.org, null, INPUT),
      service().start(b.org, null, INPUT),
    ])
    expect(own.id).not.toBe(foreign.id)
    const otherBefore = await state(b.org)
    expect(otherBefore.runs).toStrictEqual([foreign])
    await removeFixture(a)
    await independentlyEmpty(a.org)
    expect(await state(b.org)).toStrictEqual(otherBefore)
  })
})
