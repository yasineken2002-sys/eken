/** Riktig syntetisk PostgreSQL, offentlig v2-kedja och små katalogfacit.
 * Inga provider-/HTTP-anrop. Barriärer omger verkliga queries/publika metoder;
 * ingen triggerbypass, testhook i produkten eller hämtning av omgivningens data.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import {
  FortnoxReadSourceRunService,
  type SourceCatalogReceipt,
} from './fortnox-read-source-run.service'

const INPUT = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
const CATALOG_CONFLICT = 'Katalogunderlaget ändrades under läsningen.'
const EXPIRED = 'Läsanspråket har upphört'
const RAW_MARKER = 'SYNTHETIC_CATALOG_RAW_BODY_NOT_A_REASON'
const emptyCoverage = () => ({ pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 })
function catalog(projects = false): CheckpointCatalog {
  return {
    version: 1,
    companyDatabaseNumber: 900001,
    financialYear: {
      id: 1,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      accountingMethod: 'ACCRUAL',
    },
    accounts: [{ number: 5170, active: null, balanceBroughtForwardOre: -125 }],
    dimensions: [],
    coverage: { costCenters: emptyCoverage(), ...(projects ? { projects: emptyCoverage() } : {}) },
  }
}
function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('V2-katalog kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw),
    name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('V2-katalog tillåter endast egen lokal testdatabas eller CI')
  url.searchParams.set('connection_limit', '4')
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
class ShortLeaseService extends FortnoxReadSourceRunService {
  protected override leaseDurationMs() {
    return 500
  }
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    )
  return value
}
function hash(value: unknown) {
  const text = JSON.stringify(ordered(value))
  if (text === undefined) throw new Error('Facit kräver JSON')
  return createHash('sha256').update(text).digest('hex')
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function barrier(signal: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    signal,
    operation.then(() => {
      throw new Error('Arbetet avslutades innan den verkliga barriären')
    }),
  ])
}
function rawContains(params: Prisma.MiddlewareParams, text: string) {
  return (
    (params.action === 'queryRaw' || params.action === 'executeRaw') &&
    JSON.stringify(params.args, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ).includes(text)
  )
}
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
  transform?: (params: Prisma.MiddlewareParams, result: unknown) => unknown
}
function runWrite(params: Prisma.MiddlewareParams, field: 'phase' | 'status', value: string) {
  return (
    params.model === 'FortnoxReadRun' &&
    params.action === 'update' &&
    record(params.args) &&
    record(params.args.data) &&
    params.args.data[field] === value
  )
}
type Mapping = {
  type: 'COST_CENTER' | 'PROJECT'
  code: string
  propertyId: string
  propertyName: string
}

describe('Fortnox v2-katalog: återupptagbar SOURCE_CAPTURED → MANIFEST', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>(),
    accounts = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Katalogfixturen har inte startats')
    return prisma
  }
  const service = (client = db()) => new FortnoxReadSourceRunService(client)
  const tx = <T>(work: (c: Prisma.TransactionClient) => Promise<T>, client = db()) =>
    client.$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  async function controlled() {
    const url = new URL(DATABASE_URL)
    url.searchParams.set('connection_limit', '1')
    const client = new TestPrisma({ datasources: { db: { url: url.toString() } } }),
      hooks: Hooks = {}
    client.$use(async (params, next) => {
      await hooks.before?.(params)
      const result = await next(params)
      await hooks.after?.(params, result)
      return hooks.transform ? hooks.transform(params, result) : result
    })
    await client.$connect()
    const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    if (!row) throw new Error('Testklientens PID saknas')
    return { client, hooks, pid: row.pid }
  }
  async function mustClaim(org: string, id: string, owner = service()) {
    const lease = await owner.claim(org, id)
    if (!lease) throw new Error('Syntetiskt anspråk saknas')
    return lease
  }
  async function fixture(options: { projectOnSecondPage?: boolean; normalize?: boolean } = {}) {
    const org = randomUUID(),
      propertyId = randomUUID(),
      journalId = randomUUID(),
      exportId = randomUUID(),
      bank = randomUUID(),
      expense = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-v2-catalog-${org}`,
        email: `${org}@example.invalid`,
        street: 'Testgata 1',
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
        fortnoxOrgNumber: 'SYNTHETIC_V2_CATALOG',
      },
    })
    const mappings: Mapping[] = Array.from(
      { length: options.projectOnSecondPage ? 100 : 1 },
      (_, i): Mapping => ({
        type: 'COST_CENTER',
        code: String(i + 1).padStart(3, '0'),
        propertyId,
        propertyName: 'Syntetisk Å A\u030A 🏡',
      }),
    )
    if (options.projectOnSecondPage)
      mappings.push({
        type: 'PROJECT',
        code: 'P-SISTA',
        propertyId,
        propertyName: mappings[0]!.propertyName,
      })
    journals.add(journalId)
    exports.add(exportId)
    accounts.add(bank)
    accounts.add(expense)
    await tx(async (c) => {
      await c.property.create({
        data: {
          id: propertyId,
          organizationId: org,
          name: mappings[0]!.propertyName,
          propertyDesignation: `SYNTHETIC ${propertyId}`,
          type: 'RESIDENTIAL',
          street: 'Testgata 2',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: '100.00',
        },
      })
      await c.fortnoxDimensionMapping.createMany({
        data: mappings.map((item) => ({
          organizationId: org,
          propertyId,
          dimensionType: item.type,
          code: item.code,
        })),
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
          description: 'SYNTHETIC_V2_CATALOG',
          source: 'MANUAL',
          sourceId: journalId,
          fiscalYear: 2026,
          series: 'A',
          verNumber: 1,
          lines: {
            create: [
              { accountId: bank, credit: '100.00', debit: '0.00' },
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
          fortnoxDatabaseNumber: 900001,
          externalYear: 1,
          externalSeries: 'L',
          externalNumber: 1,
          draft: {
            kontomappning: { revision: -7 },
            provenance: { lines: [{ localAccountNumber: 5170, externalAccountNumber: 5170 }] },
          },
        },
      })
    })
    const owner = service(),
      run = await owner.start(org, null, INPUT),
      lease = await mustClaim(org, run.id, owner)
    let progress = await owner.prepareNormalization(lease)
    if (options.normalize !== false)
      while (progress.next) {
        await owner.normalizePage(lease, progress.next)
        progress = await owner.prepareNormalization(lease)
      }
    const context = {
      version: 1,
      input: INPUT,
      mappings,
      ownExports: [
        {
          voucher: '1|L|1',
          journalEntryId: journalId,
          revision: -7,
          perMal: [{ account: 5170, sources: [5170] }],
        },
      ],
    }
    return { org, connection, run, lease, propertyId, context }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function state(org: string, client = db()) {
    return {
      runs: await client.fortnoxReadRun.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      sources: await client.fortnoxReadSourceCapture.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      stages: await client.fortnoxReadNormalizationStage.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      stagePages: await client.fortnoxReadNormalizationPage.findMany({
        where: { organizationId: org },
        orderBy: [{ kind: 'asc' }, { afterOrdinal: 'asc' }],
      }),
      snapshots: await client.fortnoxReadContextSnapshot.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      pages: await client.fortnoxReadContextPage.findMany({
        where: { organizationId: org },
        orderBy: [{ kind: 'asc' }, { page: 'asc' }],
      }),
      manifestPages: await client.fortnoxReadManifestPage.findMany({
        where: { organizationId: org },
      }),
      details: await client.fortnoxReadVoucherCheckpoint.findMany({
        where: { organizationId: org },
      }),
    }
  }
  async function durable(org: string) {
    const observer = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      await observer.$connect()
      return await state(org, observer)
    } finally {
      await observer.$disconnect()
    }
  }
  function artifacts(observed: Awaited<ReturnType<typeof state>>) {
    return {
      sources: observed.sources,
      stages: observed.stages,
      stagePages: observed.stagePages,
      snapshots: observed.snapshots,
      pages: observed.pages,
      manifestPages: observed.manifestPages,
      details: observed.details,
    }
  }
  async function expectManifest(
    f: Fixture,
    expected: CheckpointCatalog,
    receipt: SourceCatalogReceipt,
  ) {
    const saved = await durable(f.org)
    expect(receipt).toStrictEqual({
      runId: f.run.id,
      catalogDigest: hash(expected),
    })
    expect(saved.runs[0]).toMatchObject({
      id: f.run.id,
      status: 'RUNNING',
      phase: 'MANIFEST',
      workVersion: 2,
      catalog: expected,
      financialYearStart: new Date('2026-01-01T00:00:00Z'),
      financialYearEnd: new Date('2026-12-31T00:00:00Z'),
      frozenContext: null,
      summary: null,
      rows: null,
      coverage: {},
      uncertainties: [],
      nextManifestPage: 1,
      completedAt: null,
      reason: null,
    })
    expect(saved.manifestPages).toStrictEqual([])
    expect(saved.details).toStrictEqual([])
    expect(saved.snapshots).toHaveLength(1)
    expect(saved.snapshots[0]?.manifest).toMatchObject({ sourceDigest: hash(f.context) })
    return saved
  }
  async function expectCatalogFailure(
    f: Fixture,
    expectedPhase: 'SOURCE_CAPTURED' | 'MANIFEST',
    oldCatalog: CheckpointCatalog | null = null,
  ) {
    const saved = await durable(f.org)
    expect(saved.runs[0]).toMatchObject({
      phase: expectedPhase,
      status: 'FAILED',
      catalog: oldCatalog,
      reason: CATALOG_CONFLICT,
      claimVersion: f.lease.claimVersion,
      claimToken: null,
      leaseUntil: null,
      completedAt: expect.any(Date),
      frozenContext: null,
      summary: null,
      rows: null,
    })
    expect(saved.manifestPages).toStrictEqual([])
    expect(saved.details).toStrictEqual([])
    expect(
      JSON.stringify(saved, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(RAW_MARKER)
    return saved
  }
  async function databaseAfter(deadline: Date) {
    const end = Date.now() + 2000
    while (Date.now() < end) {
      const [clock] = await db().$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (clock && clock.now > deadline) return
    }
    throw new Error('Verklig DB-deadline passerades inte inom provgränsen')
  }
  async function waitBlocked(pid: number, blocker: number) {
    const end = Date.now() + 1500
    while (Date.now() < end) {
      const [row] = await db().$queryRaw<
        Array<{ blockers: number[] }>
      >`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${pid}`
      if (row?.blockers.includes(blocker)) return
    }
    throw new Error('Verklig låsväntan observerades inte')
  }
  function pauseAfterFreeze(owner: FortnoxReadSourceRunService) {
    const actual = owner.freezeNormalizedContext.bind(owner),
      reached = deferred(),
      release = deferred()
    const spy = jest
      .spyOn(owner, 'freezeNormalizedContext')
      .mockImplementationOnce(async (lease) => {
        const value = await actual(lease)
        reached.resolve()
        await release.promise
        return value
      })
    return { reached, release, spy }
  }
  async function sqlReject(
    work: (c: Prisma.TransactionClient) => Promise<unknown>,
    code = '23514',
  ) {
    await expect(
      tx(async (c) => {
        await work(c)
        throw new Error('SYNTHETIC_SQL_UNEXPECTED_SUCCESS')
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code } })
  }
  const sqlCommit = (c: Prisma.TransactionClient, f: Fixture, candidate: unknown = catalog()) =>
    c.$executeRaw`UPDATE "FortnoxReadRun" SET phase='MANIFEST',catalog=${JSON.stringify(candidate)}::jsonb,"financialYearStart"='2026-01-01'::date,"financialYearEnd"='2026-12-31'::date,"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()) WHERE id=${f.run.id} AND "organizationId"=${f.org}`

  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
    expect(await prisma.$queryRaw`SELECT current_database() AS name`).toStrictEqual([
      { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
  })
  afterAll(async () => {
    if (!prisma) return
    try {
      for (const org of orgs)
        expect((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).name).toBe(
          `synthetic-v2-catalog-${org}`,
        )
      await prisma.fortnoxVoucherExport.deleteMany({ where: { id: { in: [...exports] } } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntryId: { in: [...journals] } } })
      await prisma.journalEntry.deleteMany({ where: { id: { in: [...journals] } } })
      await prisma.account.deleteMany({ where: { id: { in: [...accounts] } } })
      for (const org of orgs) await prisma.organization.delete({ where: { id: org } })
    } finally {
      await prisma.$disconnect()
    }
  })

  it('riktig kedja återupptas efter MANIFEST med null frozenContext och oförändrat fryst underlag', async () => {
    const f = await fixture(),
      owner = service()
    expect(await owner.getCatalogStep(f.lease)).toStrictEqual({
      kind: 'READ_CATALOG',
      input: INPUT,
      databaseNumber: 900001,
      readProjects: false,
    })
    const before = await durable(f.org)
    expect(before.runs[0]).toMatchObject({ phase: 'SOURCE_CAPTURED', catalog: null })
    await db().fortnoxDimensionMapping.updateMany({
      where: { organizationId: f.org },
      data: { dimensionType: 'PROJECT' },
    })
    await owner.release(f.lease)
    const lease = await mustClaim(f.org, f.run.id)
    expect(await service().getCatalogStep(lease)).toStrictEqual({
      kind: 'READ_CATALOG',
      input: INPUT,
      databaseNumber: 900001,
      readProjects: false,
    })
    const receipt = await service().commitCatalog(lease, catalog()),
      saved = await expectManifest(f, catalog(), receipt)
    expect(artifacts(saved)).toStrictEqual(artifacts(before))
    await service().release(lease)
    const next = await mustClaim(f.org, f.run.id)
    expect(await service().start(f.org, null, INPUT)).toMatchObject({
      id: f.run.id,
      phase: 'MANIFEST',
      claimVersion: next.claimVersion,
      claimToken: next.claimToken,
    })
    expect(await service().getCatalogStep(next)).toStrictEqual({
      kind: 'MANIFEST',
      catalog: catalog(),
      nextManifestPage: 1,
    })
    const afterClaim = await durable(f.org)
    expect(await service().commitCatalog(next, catalog())).toStrictEqual(receipt)
    expect(await durable(f.org)).toStrictEqual(afterClaim)
    await expect(service().prepareNormalization(next)).rejects.toBeInstanceOf(ConflictException)
    await expect(
      service().normalizePage(next, { expectedKind: 'MAPPINGS', expectedAfterOrdinal: 0n }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(
      (await service().readNormalizedPage(next, { kind: 'MAPPINGS', afterOrdinal: 0n })).items,
    ).toStrictEqual(f.context.mappings)
    expect(
      (await service().readSourcePage(next, { kind: 'OWN_EXPORTS', afterOrdinal: 0n })).items,
    ).toHaveLength(1)
    expect(await service().freezeNormalizedContext(next)).toMatchObject({
      snapshotId: before.snapshots[0]!.id,
    })
  })

  it('direkt commit utan getCatalogStep skapar och verifierar själv den saknade kopian', async () => {
    const f = await fixture(),
      c = await controlled()
    try {
      expect((await durable(f.org)).snapshots).toStrictEqual([])
      const receipt = await service(c.client).commitCatalog(f.lease, catalog())
      await expectManifest(f, catalog(), receipt)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('PROJECT först på mapping-sida2 kräver projektcoverage och felkatalog stoppar beständigt', async () => {
    const f = await fixture({ projectOnSecondPage: true })
    expect(await service().getCatalogStep(f.lease)).toStrictEqual({
      kind: 'READ_CATALOG',
      input: INPUT,
      databaseNumber: 900001,
      readProjects: true,
    })
    const saved = await durable(f.org)
    expect(
      saved.pages.filter((page) => page.kind === 'MAPPINGS').map((page) => page.itemCount),
    ).toStrictEqual([100, 1])
    await expect(service().commitCatalog(f.lease, catalog())).rejects.toMatchObject({
      message: CATALOG_CONFLICT,
    })
    const after = await expectCatalogFailure(f, 'SOURCE_CAPTURED')
    expect(artifacts(after)).toStrictEqual(artifacts(saved))
  })

  it('tom fullständig projektkatalog godtas trots att den frysta mappingkoden saknas där', async () => {
    const f = await fixture({ projectOnSecondPage: true })
    await expectManifest(f, catalog(true), await service().commitCatalog(f.lease, catalog(true)))
  })

  it.each(['company', 'year', 'account', 'coverage', 'unknown-field'] as const)(
    'ogiltig katalog %s lämnar ingen delprogress eller rå feltext',
    async (kind) => {
      const f = await fixture(),
        good = catalog()
      const candidate =
        kind === 'company'
          ? { ...good, companyDatabaseNumber: 900002 }
          : kind === 'year'
            ? { ...good, financialYear: { ...good.financialYear, toDate: '2026-11-30' } }
            : kind === 'account'
              ? { ...good, accounts: [{ ...good.accounts[0]!, active: false }] }
              : kind === 'coverage'
                ? {
                    ...good,
                    coverage: {
                      costCenters: { pages: 0, totalPages: 0, totalResources: 0, itemsSeen: 0 },
                    },
                  }
                : { ...good, unexpectedProviderBody: RAW_MARKER }
      await expect(service().commitCatalog(f.lease, candidate)).rejects.toMatchObject({
        message: CATALOG_CONFLICT,
      })
      await expectCatalogFailure(f, 'SOURCE_CAPTURED')
    },
  )

  it('ofärdig normalisering och främmande org nekas utan katalog eller beständigt felstopp', async () => {
    const f = await fixture({ normalize: false }),
      foreign = await fixture(),
      before = await durable(f.org),
      foreignBefore = await durable(foreign.org)
    await expect(service().getCatalogStep(f.lease)).rejects.toBeInstanceOf(ConflictException)
    await expect(service().commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(
      service().commitCatalog({ ...f.lease, organizationId: foreign.org }, catalog()),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await durable(foreign.org)).toStrictEqual(foreignBefore)
  })

  it('korrupt faktiskt återläst sista contextsida ger inget katalogkvitto eller CATALOG_CONFLICT', async () => {
    const f = await fixture({ projectOnSecondPage: true }),
      c = await controlled()
    await service().freezeNormalizedContext(f.lease)
    const before = await durable(f.org)
    let touched = false
    c.hooks.transform = (params, result) => {
      if (
        params.model !== 'FortnoxReadContextPage' ||
        params.action !== 'findUnique' ||
        !record(result) ||
        result.kind !== 'MAPPINGS' ||
        result.page !== 2 ||
        !Array.isArray(result.items) ||
        !record(result.items[0])
      )
        return result
      touched = true
      return { ...result, items: [{ ...result.items[0], propertyName: 'SYNTHETIC_WRONG_RETURN' }] }
    }
    try {
      await expect(service(c.client).commitCatalog(f.lease, catalog(true))).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(touched).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('MANIFEST med saknad snapshot-retur nekas utan försök att skapa en ny kopia', async () => {
    const f = await fixture(),
      receipt = await service().commitCatalog(f.lease, catalog()),
      before = await durable(f.org),
      c = await controlled()
    let hidden = 0,
      writes = 0
    c.hooks.transform = (params, result) => {
      if (
        params.model === 'FortnoxReadContextSnapshot' &&
        params.action === 'findUnique' &&
        result !== null
      ) {
        hidden++
        return null
      }
      return result
    }
    c.hooks.after = async (params) => {
      if (
        (params.model === 'FortnoxReadContextSnapshot' && params.action === 'create') ||
        (rawContains(params, 'INSERT INTO') && rawContains(params, 'FortnoxReadContextPage'))
      )
        writes++
    }
    try {
      await expect(service(c.client).getCatalogStep(f.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      await expect(service(c.client).commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(hidden).toBeGreaterThan(0)
      expect(writes).toBe(0)
      expect(await durable(f.org)).toStrictEqual(before)
      expect(await service().commitCatalog(f.lease, catalog())).toStrictEqual(receipt)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('takeover efter verklig full verifiering nekar gammal commit även med ogiltig kandidat', async () => {
    const f = await fixture(),
      owner = service(),
      pause = pauseAfterFreeze(owner)
    const pending = Promise.allSettled([owner.commitCatalog(f.lease, { raw: RAW_MARKER })])
    try {
      await barrier(pause.reached.promise, pending)
      await service().release(f.lease)
      const next = await mustClaim(f.org, f.run.id),
        before = await durable(f.org)
      pause.release.resolve()
      const [result] = await pending
      expect(result?.status).toBe('rejected')
      if (result?.status !== 'rejected') throw new Error('Gammal ägare fick kvitto')
      expect(result.reason).toMatchObject({ message: EXPIRED })
      expect(await durable(f.org)).toStrictEqual(before)
      await expect(service().getCatalogStep(f.lease)).rejects.toMatchObject({ message: EXPIRED })
      await expectManifest(f, catalog(), await service().commitCatalog(next, catalog()))
    } finally {
      pause.release.resolve()
      await pending
      pause.spy.mockRestore()
    }
  })

  it.each(['valid', 'invalid'] as const)(
    'faktisk DB-expiry efter full verifiering avvisar %s kandidat utan progress',
    async (candidateKind) => {
      const f = await fixture(),
        owner = new ShortLeaseService(db())
      await service().release(f.lease)
      const lease = await mustClaim(f.org, f.run.id, owner),
        actual = owner.freezeNormalizedContext.bind(owner)
      let observed = false
      const spy = jest
        .spyOn(owner, 'freezeNormalizedContext')
        .mockImplementationOnce(async (input) => {
          const result = await actual(input),
            row = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
          if (!row.leaseUntil) throw new Error('Verklig förnyad deadline saknas')
          observed = true
          await databaseAfter(row.leaseUntil)
          return result
        })
      try {
        await expect(
          owner.commitCatalog(lease, candidateKind === 'valid' ? catalog() : { raw: RAW_MARKER }),
        ).rejects.toMatchObject({ message: EXPIRED })
        expect(observed).toBe(true)
        expect((await durable(f.org)).runs[0]).toMatchObject({
          phase: 'SOURCE_CAPTURED',
          status: 'RUNNING',
          catalog: null,
          reason: null,
          claimToken: lease.claimToken,
          claimVersion: lease.claimVersion,
        })
      } finally {
        spy.mockRestore()
      }
    },
  )

  it('generation ändrad mellan fullpass och commit stoppar körningen utan katalog', async () => {
    const f = await fixture(),
      owner = service(),
      actual = owner.freezeNormalizedContext.bind(owner)
    let changed = false
    const spy = jest
      .spyOn(owner, 'freezeNormalizedContext')
      .mockImplementationOnce(async (lease) => {
        const result = await actual(lease)
        await db().fortnoxConnection.update({
          where: { organizationId: f.org },
          data: { generation: { increment: 1 } },
        })
        changed = true
        return result
      })
    try {
      await expect(owner.commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(changed).toBe(true)
      const saved = await durable(f.org)
      expect(saved.runs[0]).toMatchObject({
        status: 'FAILED',
        phase: 'SOURCE_CAPTURED',
        catalog: null,
        claimToken: null,
        leaseUntil: null,
        summary: null,
        rows: null,
      })
      expect(saved.runs[0]?.reason).not.toBe(CATALOG_CONFLICT)
    } finally {
      spy.mockRestore()
    }
  })

  it('tokenVersion-refresh samt renew/release/ny claim fungerar efter MANIFEST', async () => {
    const f = await fixture(),
      receipt = await service().commitCatalog(f.lease, catalog())
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { tokenVersion: { increment: 1 } },
    })
    const renewed = await service().renew(f.lease)
    await service().release(renewed)
    const next = await mustClaim(f.org, f.run.id)
    expect(await service().commitCatalog(next, catalog())).toStrictEqual(receipt)
    await expectManifest(f, catalog(), receipt)
  })

  it('lease som går ut före terminal UPDATE ger rollback, aldrig beständigt katalogfel', async () => {
    const f = await fixture(),
      c = await controlled(),
      owner = new ShortLeaseService(c.client)
    await service().release(f.lease)
    const lease = await mustClaim(f.org, f.run.id, owner)
    let before: Awaited<ReturnType<typeof state>> | undefined,
      actualWrite = false
    c.hooks.before = async (params) => {
      if (!runWrite(params, 'status', 'FAILED')) return
      before = await durable(f.org)
      const deadline = before.runs[0]?.leaseUntil
      if (!deadline) throw new Error('Aktuell DB-deadline saknas före terminal UPDATE')
      await databaseAfter(deadline)
    }
    c.hooks.after = async (params) => {
      if (runWrite(params, 'status', 'FAILED')) actualWrite = true
    }
    try {
      await expect(owner.commitCatalog(lease, { raw: RAW_MARKER })).rejects.toMatchObject({
        message: EXPIRED,
      })
      expect(before).toBeDefined()
      expect(actualWrite).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('samtidiga identiska commit ger en riktig UPDATE och samma hållbara kvitto', async () => {
    const f = await fixture(),
      a = await controlled(),
      b = await controlled(),
      reached = deferred(),
      release = deferred()
    await service().freezeNormalizedContext(f.lease)
    let writes = 0
    a.hooks.after = async (params) => {
      if (runWrite(params, 'phase', 'MANIFEST')) {
        writes++
        reached.resolve()
        await release.promise
      }
    }
    b.hooks.after = async (params) => {
      if (runWrite(params, 'phase', 'MANIFEST')) writes++
    }
    const first = Promise.allSettled([service(a.client).commitCatalog(f.lease, catalog())])
    let second: typeof first | undefined
    try {
      await barrier(reached.promise, first)
      second = Promise.allSettled([service(b.client).commitCatalog(f.lease, catalog())])
      await waitBlocked(b.pid, a.pid)
      release.resolve()
      const [one] = await first,
        [two] = await second
      expect(one?.status).toBe('fulfilled')
      expect(two?.status).toBe('fulfilled')
      if (one?.status !== 'fulfilled' || two?.status !== 'fulfilled')
        throw new Error('Identiska katalogcommit misslyckades')
      expect(two.value).toStrictEqual(one.value)
      expect(writes).toBe(1)
      await expectManifest(f, catalog(), one.value)
    } finally {
      release.resolve()
      await first
      if (second) await second
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it('samtidigt förberedda olika kataloger ersätter aldrig den första committade katalogen', async () => {
    const f = await fixture(),
      a = service(),
      b = service(),
      pa = pauseAfterFreeze(a),
      pb = pauseAfterFreeze(b)
    await service().freezeNormalizedContext(f.lease)
    const firstCatalog = catalog(),
      otherCatalog = {
        ...catalog(),
        accounts: [{ number: 5170, active: true, balanceBroughtForwardOre: 500 }],
      }
    const first = Promise.allSettled([a.commitCatalog(f.lease, firstCatalog)]),
      second = Promise.allSettled([b.commitCatalog(f.lease, otherCatalog)])
    try {
      await Promise.all([barrier(pa.reached.promise, first), barrier(pb.reached.promise, second)])
      pa.release.resolve()
      const [one] = await first
      expect(one?.status).toBe('fulfilled')
      if (one?.status !== 'fulfilled') throw new Error('Första katalogcommit saknas')
      const before = await expectManifest(f, firstCatalog, one.value)
      pb.release.resolve()
      const [two] = await second
      expect(two?.status).toBe('rejected')
      if (two?.status !== 'rejected') throw new Error('Andra katalogen ersatte den första')
      expect(two.reason).toMatchObject({ message: CATALOG_CONFLICT })
      const saved = await expectCatalogFailure(f, 'MANIFEST', firstCatalog)
      expect(artifacts(saved)).toStrictEqual(artifacts(before))
      expect(saved.runs[0]?.financialYearStart).toEqual(before.runs[0]?.financialYearStart)
      expect(saved.runs[0]?.financialYearEnd).toEqual(before.runs[0]?.financialYearEnd)
    } finally {
      pa.release.resolve()
      pb.release.resolve()
      await first
      await second
      pa.spy.mockRestore()
      pb.spy.mockRestore()
    }
  })

  it('getCatalogStep väljer MANIFEST från sista låsta omläsningen efter konkurrerande commit', async () => {
    const f = await fixture(),
      c = await controlled(),
      reached = deferred(),
      release = deferred()
    await service().freezeNormalizedContext(f.lease)
    let mappingReads = 0,
      paused = false
    c.hooks.after = async (params, result) => {
      if (
        params.model === 'FortnoxReadContextPage' &&
        params.action === 'findUnique' &&
        record(result) &&
        result.kind === 'MAPPINGS'
      )
        mappingReads++
    }
    c.hooks.before = async (params) => {
      // En verklig mappingläsning i full verifiering, en i katalogpolicyn.
      // Policy-TX är därefter klar; slutstegets parentlås är ännu inte taget.
      if (
        paused ||
        mappingReads !== 2 ||
        !rawContains(params, 'FortnoxConnection') ||
        !rawContains(params, 'FOR UPDATE')
      )
        return
      paused = true
      reached.resolve()
      await release.promise
    }
    const reading = Promise.allSettled([service(c.client).getCatalogStep(f.lease)])
    try {
      await barrier(reached.promise, reading)
      expect(paused).toBe(true)
      expect(mappingReads).toBe(2)
      const receipt = await service().commitCatalog(f.lease, catalog())
      release.resolve()
      const [result] = await reading
      expect(result?.status).toBe('fulfilled')
      if (result?.status !== 'fulfilled') throw new Error('Katalogsteget kunde inte återläsas')
      expect(result.value).toStrictEqual({
        kind: 'MANIFEST',
        catalog: catalog(),
        nextManifestPage: 1,
      })
      await expectManifest(f, catalog(), receipt)
    } finally {
      release.resolve()
      await reading
      await c.client.$disconnect()
    }
  })

  it('verkligt SQL-fel efter fullpass maskeras inte till felaktig extern katalog', async () => {
    const f = await fixture(),
      owner = service(),
      actual = owner.freezeNormalizedContext.bind(owner)
    let reached = false
    const spy = jest
      .spyOn(owner, 'freezeNormalizedContext')
      .mockImplementationOnce(async (lease) => {
        const result = await actual(lease)
        reached = true
        await db().$queryRaw`SELECT 1 / 0`
        return result
      })
    try {
      await expect(owner.commitCatalog(f.lease, { raw: RAW_MARKER })).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '22012' },
      })
      expect(reached).toBe(true)
      expect((await durable(f.org)).runs[0]).toMatchObject({
        status: 'RUNNING',
        phase: 'SOURCE_CAPTURED',
        catalog: null,
        reason: null,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('fel efter faktisk katalog-UPDATE rullar tillbaka fas, årgränser och katalog tillsammans', async () => {
    const f = await fixture(),
      c = await controlled(),
      injected = new Error('SYNTHETIC_AFTER_CATALOG_UPDATE')
    await service().freezeNormalizedContext(f.lease)
    const before = await durable(f.org)
    let reached = false
    c.hooks.after = async (params, result) => {
      if (runWrite(params, 'phase', 'MANIFEST')) {
        expect(result).toMatchObject({ id: f.run.id })
        reached = true
        throw injected
      }
    }
    try {
      await expect(service(c.client).commitCatalog(f.lease, catalog())).rejects.toBe(injected)
      expect(reached).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
      await expectManifest(f, catalog(), await service().commitCatalog(f.lease, catalog()))
    } finally {
      await c.client.$disconnect()
    }
  })

  it.each(['ERROR', 'EXPIRED'] as const)(
    'eftercommit %s bevarar katalogen för samma kvitto efter ny claim',
    async (mode) => {
      const f = await fixture(),
        c = await controlled(),
        owner = mode === 'EXPIRED' ? new ShortLeaseService(c.client) : service(c.client)
      await service().release(f.lease)
      const lease = await mustClaim(f.org, f.run.id, owner),
        injected = new Error('SYNTHETIC_LOST_CATALOG_RESPONSE')
      let wrote = false,
        observed = false
      c.hooks.after = async (params, result) => {
        if (runWrite(params, 'phase', 'MANIFEST')) wrote = true
        if (
          !wrote ||
          observed ||
          params.model !== 'FortnoxReadRun' ||
          params.action !== 'findUnique' ||
          !record(result) ||
          result.phase !== 'MANIFEST'
        )
          return
        const saved = await durable(f.org)
        if (saved.runs[0]?.phase !== 'MANIFEST') return
        observed = true
        if (mode === 'ERROR') throw injected
        const deadline = saved.runs[0].leaseUntil
        if (!deadline) throw new Error('Aktuell kvitto-deadline saknas')
        await databaseAfter(deadline)
      }
      try {
        if (mode === 'ERROR')
          await expect(owner.commitCatalog(lease, catalog())).rejects.toBe(injected)
        else
          await expect(owner.commitCatalog(lease, catalog())).rejects.toMatchObject({
            message: EXPIRED,
          })
        expect(observed).toBe(true)
        const before = await durable(f.org)
        expect(before.runs[0]).toMatchObject({
          status: 'RUNNING',
          phase: 'MANIFEST',
          catalog: catalog(),
        })
        if (mode === 'ERROR') await service().release(lease)
        const next = await mustClaim(f.org, f.run.id),
          receipt = await service().commitCatalog(next, catalog())
        const after = await expectManifest(f, catalog(), receipt)
        expect(artifacts(after)).toStrictEqual(artifacts(before))
        expect(after.runs[0]?.catalog).toStrictEqual(before.runs[0]?.catalog)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it('SQL kräver förseglad kontext och aktiv lease; legitim katalogövergång fungerar', async () => {
    const f = await fixture()
    await sqlReject((c) => sqlCommit(c, f))
    await service().freezeNormalizedContext(f.lease)
    for (const candidate of [
      null,
      { ...catalog(), version: null },
      { ...catalog(), companyDatabaseNumber: null },
      { ...catalog(), financialYear: { ...catalog().financialYear, id: null } },
    ])
      await sqlReject((c) => sqlCommit(c, f, candidate))
    await service().release(f.lease)
    await sqlReject((c) => sqlCommit(c, f))
    const short = new ShortLeaseService(db()),
      expired = await mustClaim(f.org, f.run.id, short)
    await databaseAfter(expired.leaseUntil)
    await sqlReject((c) => sqlCommit(c, f))
    const next = await mustClaim(f.org, f.run.id)
    const before = await durable(f.org)
    await tx((c) => sqlCommit(c, f))
    const receipt = await service().commitCatalog(next, catalog()),
      after = await expectManifest(f, catalog(), receipt)
    expect(artifacts(after)).toStrictEqual(artifacts(before))
  })

  it('SQL i MANIFEST kan inte ändra katalog/identitet, backa, hoppa eller publicera resultat', async () => {
    const f = await fixture(),
      receipt = await service().commitCatalog(f.lease, catalog()),
      before = await durable(f.org)
    const mutations = [
      Prisma.sql`catalog='null'::jsonb`,
      Prisma.sql`catalog=${JSON.stringify({ ...catalog(), accounts: [] })}::jsonb`,
      Prisma.sql`"financialYearEnd"='2026-11-30'::date`,
      Prisma.sql`phase='SOURCE_CAPTURED',catalog=NULL,"financialYearStart"=NULL,"financialYearEnd"=NULL`,
      Prisma.sql`phase='DETAILS'`,
      Prisma.sql`phase=NULL`,
      Prisma.sql`status='COMPLETE',"completedAt"=timezone('UTC',clock_timestamp())`,
      Prisma.sql`summary='{}'::jsonb`,
      Prisma.sql`rows='[]'::jsonb`,
      Prisma.sql`"frozenContext"='{}'::jsonb`,
      Prisma.sql`"nextManifestPage"=2`,
      Prisma.sql`"sourceCaptureId"=NULL`,
    ]
    for (const mutation of mutations)
      await sqlReject((c) =>
        c.$executeRaw(
          Prisma.sql`UPDATE "FortnoxReadRun" SET ${mutation} WHERE id=${f.run.id} AND "organizationId"=${f.org}`,
        ),
      )
    await sqlReject((c) => c.$executeRaw`DELETE FROM "FortnoxReadRun" WHERE id=${f.run.id}`)
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await service().commitCatalog(f.lease, catalog())).toStrictEqual(receipt)
  })

  it('v1 får inte stoppa MANIFEST-v2 och oförändrad legacy COMPLETE kan inte adopteras', async () => {
    const f = await fixture(),
      receipt = await service().commitCatalog(f.lease, catalog()),
      legacyId = randomUUID()
    const legacy = await db().fortnoxReadRun.create({
      data: {
        id: legacyId,
        organizationId: f.org,
        connectionId: f.connection.id,
        fortnoxDatabaseNumber: 900001,
        status: 'COMPLETE',
        financialYearId: 1,
        periodFrom: new Date('2026-10-01T00:00:00Z'),
        periodTo: new Date('2026-10-31T00:00:00Z'),
        costAccounts: [5170],
        summary: { syntheticLegacy: true },
        rows: [],
        completedAt: new Date(),
      },
    })
    const before = await durable(f.org),
      v1 = new FortnoxReadCheckpointService(db())
    await expect(v1.start(f.org, null, INPUT)).rejects.toBeInstanceOf(ConflictException)
    expect(await v1.claim(f.org, f.run.id)).toBeNull()
    await expect(v1.commitCatalog(f.lease, catalog())).rejects.toMatchObject({ message: EXPIRED })
    expect(await service().claim(f.org, legacyId)).toBeNull()
    await expect(
      service().commitCatalog({ ...f.lease, runId: legacyId }, catalog()),
    ).rejects.toMatchObject({ message: EXPIRED })
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await db().fortnoxReadRun.findUnique({ where: { id: legacyId } })).toStrictEqual(legacy)
    expect(await service().commitCatalog(f.lease, catalog())).toStrictEqual(receipt)
  })

  it('riktig orgcascade efter MANIFEST lämnar främmande körning och katalog orörd', async () => {
    const f = await fixture(),
      foreign = await fixture()
    await service().commitCatalog(f.lease, catalog())
    const receipt = await service().commitCatalog(foreign.lease, catalog()),
      foreignBefore = await durable(foreign.org)
    // Bara den markerade fixturens bokföringsbarn tas bort före orgcascade.
    const journalIds = f.context.ownExports.map((item) => item.journalEntryId)
    await db().fortnoxVoucherExport.deleteMany({
      where: { organizationId: f.org, journalEntryId: { in: journalIds } },
    })
    await db().journalEntryLine.deleteMany({ where: { journalEntryId: { in: journalIds } } })
    await db().journalEntry.deleteMany({ where: { id: { in: journalIds }, organizationId: f.org } })
    await db().account.deleteMany({ where: { organizationId: f.org, id: { in: [...accounts] } } })
    await db().organization.delete({ where: { id: f.org } })
    orgs.delete(f.org)
    expect(await durable(f.org)).toStrictEqual({
      runs: [],
      sources: [],
      stages: [],
      stagePages: [],
      snapshots: [],
      pages: [],
      manifestPages: [],
      details: [],
    })
    expect(await durable(foreign.org)).toStrictEqual(foreignBefore)
    expect(await service().commitCatalog(foreign.lease, catalog())).toStrictEqual(receipt)
  })

  it('SQL-förseglad koherent header och sidhasher med falsk sourceDigest kan inte ge katalogcommit', async () => {
    const f = await fixture(),
      id = randomUUID(),
      sourceDigest = '0'.repeat(64)
    expect(hash(f.context)).not.toBe(sourceDigest)
    const connection = {
      id: f.connection.id,
      generation: f.connection.generation,
      databaseNumber: 900001,
      orgNumber: 'SYNTHETIC_V2_CATALOG',
    }
    const binding = hash({
      snapshotId: id,
      organizationId: f.org,
      runId: f.run.id,
      version: 1,
      input: INPUT,
      sourceDigest,
      connection,
    })
    const collections = {
      MAPPINGS: {
        itemCount: 1,
        pageCount: 1,
        root: hash({ version: 1, binding, kind: 'MAPPINGS' }),
      },
      OWN_EXPORTS: {
        itemCount: 1,
        pageCount: 1,
        root: hash({ version: 1, binding, kind: 'OWN_EXPORTS' }),
      },
    }
    const pages: Prisma.FortnoxReadContextPageCreateManyInput[] = []
    for (const kind of ['MAPPINGS', 'OWN_EXPORTS'] as const) {
      const items = kind === 'MAPPINGS' ? f.context.mappings : f.context.ownExports
      const digest = hash({ version: 1, binding, kind, page: 1, itemCount: 1, items })
      pages.push({
        snapshotId: id,
        organizationId: f.org,
        kind,
        page: 1,
        itemCount: 1,
        digest,
        items,
      })
      collections[kind].root = hash({
        previousRoot: collections[kind].root,
        page: 1,
        itemCount: 1,
        digest,
      })
    }
    const manifest = { version: 1, input: INPUT, sourceDigest, connection, collections }
    const headerDigest = hash({ id, organizationId: f.org, runId: f.run.id, manifest })
    await tx(async (c) => {
      await c.fortnoxReadContextSnapshot.create({
        data: { id, organizationId: f.org, runId: f.run.id, manifest, digest: headerDigest },
      })
      await c.fortnoxReadContextPage.createMany({ data: pages })
      await c.$executeRaw`UPDATE "FortnoxReadContextSnapshot" SET "sealedAt"=timezone('UTC',clock_timestamp()) WHERE id=${id}`
      await c.$executeRaw`SET CONSTRAINTS "fortnox_context_snapshot_must_be_sealed" IMMEDIATE`
    })
    const before = await durable(f.org)
    expect(before.snapshots[0]).toMatchObject({
      id,
      digest: headerDigest,
      manifest,
      sealedAt: expect.any(Date),
    })
    expect(before.pages.map(({ digest }) => digest)).toStrictEqual(
      pages.map(({ digest }) => digest),
    )
    await expect(service().commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(await durable(f.org)).toStrictEqual(before)
  })
})
