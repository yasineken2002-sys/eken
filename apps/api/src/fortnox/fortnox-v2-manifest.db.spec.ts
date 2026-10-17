/** Riktig syntetisk PostgreSQL. Manifestfacit är handbyggt och hashat oberoende
 * av produktparsern. Inga provideranrop, triggerundantag eller produkt-testhooks.
 * Fel/barriärer omger verkliga queries; root kör sviten seriellt i egen test-DB.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import {
  FortnoxReadSourceRunService,
  type SourceRunLease,
  type VoucherManifestReceipt,
} from './fortnox-read-source-run.service'

const INPUT = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
const MANIFEST_CONFLICT = 'Verifikationslistan är ofullständig eller ändrades under läsningen.'
const WRONG_POSITION = 'Verifikationssidan hör inte till aktuellt lässteg'
const EXPIRED = 'Läsanspråket har upphört'
const RAW_MARKER = 'SYNTHETIC_MANIFEST_RAW_BODY_NOT_A_REASON'
function catalog(): CheckpointCatalog {
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
    coverage: { costCenters: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 } },
  }
}
function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('V2-manifest kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw),
    name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('V2-manifest tillåter endast egen lokal testdatabas eller CI')
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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    )
  return value
}
function hash(value: unknown) {
  const text = JSON.stringify(ordered(value))
  if (text === undefined) throw new Error('Manifestfacit kräver JSON')
  return createHash('sha256').update(text).digest('hex')
}
function voucher(number: number, body = RAW_MARKER) {
  return { Year: 1, VoucherSeries: 'L', VoucherNumber: number, UnknownProviderField: { body } }
}
type Voucher = ReturnType<typeof voucher>
function envelope(page: number, totalPages: number, totalResources: number, vouchers: Voucher[]) {
  return {
    MetaInformation: {
      '@CurrentPage': page,
      '@TotalPages': totalPages,
      '@TotalResources': totalResources,
    },
    Vouchers: vouchers,
  }
}
function oracle(page: number, totalPages: number, totalResources: number, vouchers: Voucher[]) {
  const value = {
    page,
    totalPages,
    totalResources,
    itemCount: vouchers.length,
    entries: vouchers.map((item) => ({ key: `1|L|${item.VoucherNumber}`, digest: hash(item) })),
  }
  return { ...value, digest: hash(value) }
}
type Page = ReturnType<typeof oracle>
const CHAIN = [
  {
    envelope: envelope(1, 3, 3, [voucher(2), voucher(1), voucher(2)]),
    page: oracle(1, 3, 3, [voucher(2), voucher(1), voucher(2)]),
  },
  { envelope: envelope(2, 3, 3, []), page: oracle(2, 3, 3, []) },
  {
    envelope: envelope(3, 3, 3, [voucher(10), voucher(1)]),
    page: oracle(3, 3, 3, [voucher(10), voucher(1)]),
  },
]
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
      throw new Error('Arbetet avslutades före verklig barriär')
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

describe('Fortnox v2-manifest: atomisk sida, nycklar och återupptagbar cursor', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>(),
    accounts = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Manifestfixturen har inte startats')
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
    if (!row) throw new Error('PID saknas')
    return { client, hooks, pid: row.pid }
  }
  async function baseFixture() {
    const org = randomUUID(),
      propertyId = randomUUID(),
      journalId = randomUUID(),
      exportId = randomUUID(),
      bank = randomUUID(),
      expense = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-v2-manifest-${org}`,
        email: `${org}@example.invalid`,
        street: 'Testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    orgs.add(org)
    journals.add(journalId)
    exports.add(exportId)
    accounts.add(bank)
    accounts.add(expense)
    const connection = await db().fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 900001,
        fortnoxOrgNumber: 'SYNTHETIC_V2_MANIFEST',
      },
    })
    await tx(async (c) => {
      await c.property.create({
        data: {
          id: propertyId,
          organizationId: org,
          name: 'Syntetisk Å A\u030A 🏡',
          propertyDesignation: `SYNTHETIC ${propertyId}`,
          type: 'RESIDENTIAL',
          street: 'Testgata 2',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: '100.00',
        },
      })
      await c.fortnoxDimensionMapping.create({
        data: { organizationId: org, propertyId, dimensionType: 'COST_CENTER', code: '001' },
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
          description: 'SYNTHETIC_V2_MANIFEST',
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
    return { org, connection, propertyId, journalId, exportId, bank, expense }
  }
  async function mustClaim(org: string, id: string, owner = service()) {
    const lease = await owner.claim(org, id)
    if (!lease) throw new Error('Anspråk saknas i syntetisk fixture')
    return lease
  }
  async function fixture(commitCatalog = true) {
    const base = await baseFixture(),
      owner = service(),
      run = await owner.start(base.org, null, INPUT),
      lease = await mustClaim(base.org, run.id, owner)
    let progress = await owner.prepareNormalization(lease)
    while (progress.next) {
      await owner.normalizePage(lease, progress.next)
      progress = await owner.prepareNormalization(lease)
    }
    if (commitCatalog) await owner.commitCatalog(lease, catalog())
    return { ...base, run, lease }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function v1Fixture() {
    const base = await baseFixture(),
      owner = new FortnoxReadCheckpointService(db()),
      run = await owner.start(base.org, null, INPUT),
      lease = await owner.claim(base.org, run.id)
    if (!lease) throw new Error('V1-anspråk saknas')
    await owner.commitCatalog(lease, catalog())
    return { ...base, run, lease, owner }
  }
  async function state(org: string, client = db()) {
    return {
      runs: await client.fortnoxReadRun.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      pages: await client.fortnoxReadManifestPage.findMany({
        where: { organizationId: org },
        orderBy: [{ runId: 'asc' }, { page: 'asc' }],
      }),
      checkpoints: await client.fortnoxReadVoucherCheckpoint.findMany({
        where: { organizationId: org },
        orderBy: [{ runId: 'asc' }, { key: 'asc' }],
      }),
      snapshots: await client.fortnoxReadContextSnapshot.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      properties: await client.property.findMany({
        where: { organizationId: org },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
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
  async function databaseAfter(deadline: Date) {
    const end = Date.now() + 2000
    while (Date.now() < end) {
      const [row] = await db().$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (row && row.now > deadline) return
    }
    throw new Error('Verklig DB-deadline passerades inte')
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
  async function shortLease(f: Fixture) {
    await service().release(f.lease)
    const owner = new ShortLeaseService(db()),
      lease = await mustClaim(f.org, f.run.id, owner)
    return { owner, lease }
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
  async function rawPage(c: Prisma.TransactionClient, f: Fixture, page: Page, org = f.org) {
    const id = randomUUID()
    await c.$executeRaw`INSERT INTO "FortnoxReadManifestPage" (id,"organizationId","runId",page,"totalPages","totalResources","itemCount",digest,entries) VALUES (${id},${org},${f.run.id},${page.page},${page.totalPages},${page.totalResources},${page.itemCount},${page.digest},${JSON.stringify(page.entries)}::jsonb)`
    return id
  }
  async function rawKey(
    c: Prisma.TransactionClient,
    f: Fixture,
    entry: Page['entries'][number],
    org = f.org,
  ) {
    return c.$executeRaw`INSERT INTO "FortnoxReadVoucherCheckpoint" (id,"organizationId","runId",key,"manifestDigest") VALUES (${randomUUID()},${org},${f.run.id},${entry.key},${entry.digest})`
  }
  async function rawAdvance(
    c: Prisma.TransactionClient,
    f: Fixture,
    page: Page,
    phase: 'MANIFEST' | 'DETAILS' | 'READY_TO_REDUCE',
  ) {
    return c.$executeRaw`UPDATE "FortnoxReadRun" SET phase=${phase}::"FortnoxReadPhase","nextManifestPage"=${page.page + 1},"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()) WHERE id=${f.run.id} AND "organizationId"=${f.org}`
  }
  async function expectFailed(f: Fixture, before: Awaited<ReturnType<typeof state>>) {
    const saved = await durable(f.org)
    expect(saved.pages).toStrictEqual(before.pages)
    expect(saved.checkpoints).toStrictEqual(before.checkpoints)
    expect(saved.snapshots).toStrictEqual(before.snapshots)
    expect(saved.runs[0]).toMatchObject({
      status: 'FAILED',
      reason: MANIFEST_CONFLICT,
      phase: before.runs[0]!.phase,
      nextManifestPage: before.runs[0]!.nextManifestPage,
      claimVersion: before.runs[0]!.claimVersion,
      claimToken: null,
      leaseUntil: null,
      completedAt: expect.any(Date),
      catalog: catalog(),
      frozenContext: null,
      summary: null,
      rows: null,
    })
    expect(saved.runs[0]!.reason).not.toContain(RAW_MARKER)
    return saved
  }
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
          `synthetic-v2-manifest-${org}`,
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

  it('bevarar oberoende tresidorsfacit, v1-paritet, dubbletter, tom mellansida och C-ordning efter omstart', async () => {
    const f = await fixture(),
      old = await v1Fixture(),
      receipts: VoucherManifestReceipt[] = []
    let owner = service(),
      currentLease = f.lease
    const catalogReceipt = await owner.commitCatalog(currentLease, catalog())
    expect(catalogReceipt).toStrictEqual({ runId: f.run.id, catalogDigest: hash(catalog()) })
    for (const item of CHAIN) {
      expect(await owner.getVoucherStep(currentLease)).toStrictEqual({
        phase: 'MANIFEST',
        page: item.page.page,
      })
      const receipt = await owner.commitVoucherPage(currentLease, item.envelope)
      receipts.push(receipt)
      expect(receipt).toStrictEqual({
        runId: f.run.id,
        pageId: expect.any(String),
        page: item.page.page,
        digest: item.page.digest,
      })
      await old.owner.commitVoucherPage(old.lease, item.envelope)
      const current = await durable(f.org)
      expect(current.pages.at(-1)).toMatchObject({
        id: receipt.pageId,
        organizationId: f.org,
        runId: f.run.id,
        ...item.page,
      })
      if (item.page.page < 3)
        expect(await owner.getCatalogStep(currentLease)).toStrictEqual({
          kind: 'MANIFEST',
          catalog: catalog(),
          nextManifestPage: item.page.page + 1,
        })
      if (item.page.page === 1) {
        await owner.release(currentLease)
        owner = service()
        expect(await owner.start(f.org, null, INPUT)).toMatchObject({
          id: f.run.id,
          phase: 'MANIFEST',
          nextManifestPage: 2,
        })
        currentLease = await mustClaim(f.org, f.run.id, owner)
        expect(await owner.getVoucherStep(currentLease)).toStrictEqual({
          phase: 'MANIFEST',
          page: 2,
        })
      }
    }
    const saved = await durable(f.org),
      previous = await durable(old.org)
    const pageData = (row: (typeof saved.pages)[number]) => ({
      page: row.page,
      totalPages: row.totalPages,
      totalResources: row.totalResources,
      itemCount: row.itemCount,
      entries: row.entries,
      digest: row.digest,
    })
    expect(saved.pages.map(pageData)).toStrictEqual(CHAIN.map((item) => item.page))
    expect(saved.pages.map(pageData)).toStrictEqual(previous.pages.map(pageData))
    const keyData = (row: (typeof saved.checkpoints)[number]) => ({
      key: row.key,
      manifestDigest: row.manifestDigest,
      detailDigest: row.detailDigest,
      validated: row.validated,
      observedAt: row.observedAt,
    })
    expect(saved.checkpoints.map(keyData)).toStrictEqual(
      [1, 10, 2].map((n) => ({
        key: `1|L|${n}`,
        manifestDigest: hash(voucher(n)),
        detailDigest: null,
        validated: null,
        observedAt: null,
      })),
    )
    expect(saved.checkpoints.map(keyData)).toStrictEqual(previous.checkpoints.map(keyData))
    expect(saved.runs[0]).toMatchObject({
      phase: 'DETAILS',
      nextManifestPage: 4,
      status: 'RUNNING',
      frozenContext: null,
      summary: null,
      rows: null,
      coverage: {},
      uncertainties: [],
    })
    await owner.release(currentLease)
    const restarted = service(),
      lease = await mustClaim(f.org, f.run.id, restarted)
    const beforeReplay = await durable(f.org)
    expect(await restarted.getVoucherStep(lease)).toStrictEqual({ phase: 'DETAILS', key: '1|L|1' })
    expect(await restarted.commitVoucherPage(lease, CHAIN[0]!.envelope)).toStrictEqual(receipts[0])
    expect(await restarted.commitCatalog(lease, catalog())).toStrictEqual(catalogReceipt)
    const freeze = jest.spyOn(restarted, 'freezeNormalizedContext')
    try {
      await expect(restarted.getCatalogStep(lease)).rejects.toBeInstanceOf(ConflictException)
      expect(freeze).not.toHaveBeenCalled()
    } finally {
      freeze.mockRestore()
    }
    expect(await durable(f.org)).toStrictEqual(beforeReplay)
  })

  it.each([0, 1])(
    'tom 1/%i-lista blir READY_TO_REDUCE utan resultat eller detaljskrivning',
    async (totalPages) => {
      const f = await fixture(),
        input = envelope(1, totalPages, 0, []),
        expected = oracle(1, totalPages, 0, [])
      const receipt = await service().commitVoucherPage(f.lease, input)
      expect(receipt.digest).toBe(expected.digest)
      expect(await service().getVoucherStep(f.lease)).toStrictEqual({ phase: 'READY_TO_REDUCE' })
      const saved = await durable(f.org)
      expect(saved.pages).toHaveLength(1)
      expect(saved.pages[0]).toMatchObject(expected)
      expect(saved.checkpoints).toStrictEqual([])
      expect(saved.runs[0]).toMatchObject({
        phase: 'READY_TO_REDUCE',
        nextManifestPage: 2,
        status: 'RUNNING',
        summary: null,
        rows: null,
        completedAt: null,
      })
      expect(await service().commitVoucherPage(f.lease, input)).toStrictEqual(receipt)
    },
  )

  it('100 identiska objekt sparas i sidan men ger exakt en nyckel, även vid replay', async () => {
    const f = await fixture(),
      values = Array.from({ length: 100 }, () => voucher(1)),
      input = envelope(1, 1, 1, values)
    const receipt = await service().commitVoucherPage(f.lease, input),
      before = await durable(f.org)
    expect(before.pages[0]).toMatchObject(oracle(1, 1, 1, values))
    expect(before.checkpoints).toHaveLength(1)
    expect(await service().commitVoucherPage(f.lease, input)).toStrictEqual(receipt)
    expect(await durable(f.org)).toStrictEqual(before)
  })

  const conflictCases = [
    {
      name: '101 objekt',
      first: null,
      bad: envelope(
        1,
        1,
        1,
        Array.from({ length: 101 }, () => voucher(1)),
      ),
    },
    {
      name: 'motsägande dubblett på samma sida',
      first: null,
      bad: envelope(1, 1, 1, [voucher(1), voucher(1, 'ANNAT')]),
    },
    {
      name: 'ändrat okänt råfält vid replay',
      first: envelope(1, 2, 2, [voucher(1)]),
      bad: envelope(1, 2, 2, [voucher(1, 'ANNAT')]),
    },
    {
      name: 'ändrade totalsiffror',
      first: envelope(1, 2, 2, [voucher(1)]),
      bad: envelope(2, 3, 2, [voucher(2)]),
    },
    {
      name: 'motsägande dubblett på senare sida',
      first: envelope(1, 2, 1, [voucher(1)]),
      bad: envelope(2, 2, 1, [voucher(1, 'ANNAT')]),
    },
    {
      name: 'ofullständigt unikt totalantal på sista sidan',
      first: envelope(1, 2, 3, [voucher(1)]),
      bad: envelope(2, 2, 3, [voucher(2)]),
    },
  ]
  it.each(conflictCases)(
    '$name stoppar v2 beständigt och bevarar redan godkänt underlag',
    async ({ first, bad }) => {
      const f = await fixture()
      if (first) await service().commitVoucherPage(f.lease, first)
      const before = await durable(f.org)
      await expect(service().commitVoucherPage(f.lease, bad)).rejects.toThrow(MANIFEST_CONFLICT)
      await expectFailed(f, before)
      expect(await service().claim(f.org, f.run.id)).toBeNull()
      // V1 har avsiktligt kvar PARTIAL och returvärde, inte v2:s FAILED/kast.
      const old = await v1Fixture()
      if (first) await old.owner.commitVoucherPage(old.lease, first)
      expect(await old.owner.commitVoucherPage(old.lease, bad)).toMatchObject({
        status: 'PARTIAL',
        reason: MANIFEST_CONFLICT,
        summary: null,
        rows: null,
      })
    },
  )

  it('framtida sida, extra sida efter slut och steg före katalog ändrar inget', async () => {
    const f = await fixture(),
      before = await durable(f.org)
    await expect(
      service().commitVoucherPage(f.lease, envelope(2, 2, 1, [voucher(1)])),
    ).rejects.toThrow(WRONG_POSITION)
    expect(await durable(f.org)).toStrictEqual(before)
    await service().commitVoucherPage(f.lease, envelope(1, 1, 1, [voucher(1)]))
    const complete = await durable(f.org)
    await expect(
      service().commitVoucherPage(f.lease, envelope(2, 2, 2, [voucher(2)])),
    ).rejects.toThrow(WRONG_POSITION)
    expect(await durable(f.org)).toStrictEqual(complete)
    const captured = await fixture(false),
      untouched = await durable(captured.org)
    await expect(service().getVoucherStep(captured.lease)).rejects.toBeInstanceOf(ConflictException)
    await expect(
      service().commitVoucherPage(captured.lease, envelope(1, 1, 1, [voucher(1)])),
    ).rejects.toThrow(WRONG_POSITION)
    expect(await durable(captured.org)).toStrictEqual(untouched)
  })

  it('två samtidiga försök på samma sida väntar på verkligt lås och ger samma kvitto med en INSERT', async () => {
    const f = await fixture(),
      a = await controlled(),
      b = await controlled(),
      reached = deferred(),
      release = deferred()
    let inserts = 0,
      writes = 0
    a.hooks.after = async (params) => {
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'create') {
        inserts++
        reached.resolve()
        await release.promise
      }
      if (runWrite(params, 'phase', 'DETAILS')) writes++
    }
    b.hooks.after = async (params) => {
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'create') inserts++
      if (runWrite(params, 'phase', 'DETAILS')) writes++
    }
    const input = envelope(1, 1, 1, [voucher(1)]),
      first = service(a.client).commitVoucherPage(f.lease, input),
      firstDone = Promise.allSettled([first])
    let secondDone: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await barrier(reached.promise, firstDone)
      const second = service(b.client).commitVoucherPage(f.lease, input)
      secondDone = Promise.allSettled([second])
      await barrier(waitBlocked(b.pid, a.pid), secondDone)
      release.resolve()
      expect(await first).toStrictEqual(await second)
      expect(inserts).toBe(1)
      expect(writes).toBe(1)
      const saved = await durable(f.org)
      expect(saved.pages).toHaveLength(1)
      expect(saved.checkpoints).toHaveLength(1)
      expect(saved.runs[0]?.nextManifestPage).toBe(2)
    } finally {
      release.resolve()
      await firstDone
      await secondDone
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it('två olika sidpositioner får båda lyckas när den andra blir aktuell efter låsväntan', async () => {
    const f = await fixture(),
      a = await controlled(),
      b = await controlled(),
      reached = deferred(),
      release = deferred()
    a.hooks.after = async (params) => {
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'create') {
        reached.resolve()
        await release.promise
      }
    }
    const first = service(a.client).commitVoucherPage(f.lease, envelope(1, 2, 2, [voucher(1)])),
      firstDone = Promise.allSettled([first])
    let secondDone: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await barrier(reached.promise, firstDone)
      const second = service(b.client).commitVoucherPage(f.lease, envelope(2, 2, 2, [voucher(2)]))
      secondDone = Promise.allSettled([second])
      await barrier(waitBlocked(b.pid, a.pid), secondDone)
      release.resolve()
      expect((await first).page).toBe(1)
      expect((await second).page).toBe(2)
      const saved = await durable(f.org)
      expect(saved.pages.map((p) => p.page)).toStrictEqual([1, 2])
      expect(saved.checkpoints.map((v) => v.key)).toStrictEqual(['1|L|1', '1|L|2'])
      expect(saved.runs[0]).toMatchObject({ phase: 'DETAILS', nextManifestPage: 3 })
    } finally {
      release.resolve()
      await firstDone
      await secondDone
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it('gammal fence nekas före replay och ogiltig kandidat utan att stoppa ny ägare', async () => {
    const f = await fixture(),
      input = envelope(1, 2, 2, [voucher(1)]),
      receipt = await service().commitVoucherPage(f.lease, input)
    await service().release(f.lease)
    const lease = await mustClaim(f.org, f.run.id),
      before = await durable(f.org)
    await expect(service().commitVoucherPage(f.lease, input)).rejects.toThrow(EXPIRED)
    await expect(service().commitVoucherPage(f.lease, { bad: RAW_MARKER })).rejects.toThrow(EXPIRED)
    await expect(service().getVoucherStep(f.lease)).rejects.toThrow(EXPIRED)
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await service().commitVoucherPage(lease, input)).toStrictEqual(receipt)
    expect(await service().getVoucherStep(lease)).toStrictEqual({ phase: 'MANIFEST', page: 2 })
  })

  it.each(['keys', 'immediate'] as const)(
    'verklig expiry efter %s rullar tillbaka sida, nycklar och eventuell cursor',
    async (seam) => {
      const f = await fixture(),
        { lease } = await shortLease(f),
        hooked = await controlled(),
        before = await durable(f.org)
      let reached = false,
        pageWritten = false,
        keysWritten = false,
        cursorWritten = false
      hooked.hooks.after = async (params) => {
        if (params.model === 'FortnoxReadManifestPage' && params.action === 'create')
          pageWritten = true
        if (params.model === 'FortnoxReadVoucherCheckpoint' && params.action === 'createMany')
          keysWritten = true
        if (runWrite(params, 'phase', 'DETAILS')) cursorWritten = true
        if (
          (seam === 'keys' &&
            params.model === 'FortnoxReadVoucherCheckpoint' &&
            params.action === 'createMany') ||
          (seam === 'immediate' &&
            rawContains(params, 'fortnox_manifest_page_must_advance') &&
            rawContains(params, 'IMMEDIATE'))
        ) {
          reached = true
          const current = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
          if (!current.leaseUntil) throw new Error('DB-deadline saknas')
          await databaseAfter(current.leaseUntil)
        }
      }
      try {
        await expect(
          service(hooked.client).commitVoucherPage(lease, envelope(1, 1, 1, [voucher(1)])),
        ).rejects.toThrow(EXPIRED)
        expect(reached).toBe(true)
        expect(pageWritten).toBe(true)
        expect(keysWritten).toBe(true)
        expect(cursorWritten).toBe(seam === 'immediate')
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it('expiry före terminal UPDATE får inte beständigt stoppa körningen som manifestkonflikt', async () => {
    const f = await fixture(),
      { lease } = await shortLease(f),
      hooked = await controlled(),
      before = await durable(f.org)
    let beforeWrite = false,
      actualWrite = false
    hooked.hooks.before = async (params) => {
      if (runWrite(params, 'status', 'FAILED')) {
        beforeWrite = true
        const current = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
        if (!current.leaseUntil) throw new Error('DB-deadline saknas')
        await databaseAfter(current.leaseUntil)
      }
    }
    hooked.hooks.after = async (params) => {
      if (runWrite(params, 'status', 'FAILED')) actualWrite = true
    }
    try {
      await expect(
        service(hooked.client).commitVoucherPage(lease, { bad: RAW_MARKER }),
      ).rejects.toThrow(EXPIRED)
      expect(beforeWrite).toBe(true)
      expect(actualWrite).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await hooked.client.$disconnect()
    }
  })

  it.each(['page', 'keys', 'cursor'] as const)(
    'fel efter riktig %s-skrivning propagerar och rullar tillbaka hela steget',
    async (seam) => {
      const f = await fixture(),
        hooked = await controlled(),
        before = await durable(f.org),
        injected = new Error(`SYNTHETIC_${seam}`)
      let written = false
      hooked.hooks.after = async (params) => {
        if (
          (seam === 'page' &&
            params.model === 'FortnoxReadManifestPage' &&
            params.action === 'create') ||
          (seam === 'keys' &&
            params.model === 'FortnoxReadVoucherCheckpoint' &&
            params.action === 'createMany') ||
          (seam === 'cursor' && runWrite(params, 'phase', 'DETAILS'))
        ) {
          written = true
          throw injected
        }
      }
      try {
        await expect(
          service(hooked.client).commitVoucherPage(f.lease, envelope(1, 1, 1, [voucher(1)])),
        ).rejects.toBe(injected)
        expect(written).toBe(true)
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it('verkligt SQL22012 efter sidINSERT propagerar utan manifestterminal och rullar tillbaka sidan', async () => {
    const f = await fixture(),
      hooked = await controlled(),
      before = await durable(f.org)
    let actualWrite = false
    hooked.hooks.after = async (params) => {
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'create') {
        actualWrite = true
        await db().$queryRaw`SELECT 1 / 0 AS synthetic_division_by_zero`
      }
    }
    try {
      await expect(
        service(hooked.client).commitVoucherPage(f.lease, envelope(1, 1, 1, [voucher(1)])),
      ).rejects.toMatchObject({ code: 'P2010', meta: { code: '22012' } })
      expect(actualWrite).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await hooked.client.$disconnect()
    }
  })

  it.each(['lost-response', 'expiry'] as const)(
    '%s i separat kvitto lämnar committad sida som ny ägare återupptar',
    async (mode) => {
      const f = await fixture(),
        lease = mode === 'expiry' ? (await shortLease(f)).lease : f.lease
      const hooked = await controlled(),
        injected = new Error('SYNTHETIC_LOST_RECEIPT'),
        input = envelope(1, 1, 1, [voucher(1)])
      let wrote = false,
        acknowledgedBoundary = false
      hooked.hooks.after = async (params, result) => {
        if (params.model === 'FortnoxReadManifestPage' && params.action === 'create') wrote = true
        if (
          wrote &&
          params.model === 'FortnoxReadManifestPage' &&
          params.action === 'findUnique' &&
          record(result) &&
          result.page === 1
        ) {
          acknowledgedBoundary = true
          const observed = await durable(f.org)
          expect(observed.pages).toHaveLength(1)
          expect(observed.runs[0]).toMatchObject({ phase: 'DETAILS', nextManifestPage: 2 })
          if (mode === 'lost-response') throw injected
          const deadline = observed.runs[0]?.leaseUntil
          if (!deadline) throw new Error('Commitsidans deadline saknas')
          await databaseAfter(deadline)
        }
      }
      try {
        const attempt = service(hooked.client).commitVoucherPage(lease, input)
        if (mode === 'lost-response') await expect(attempt).rejects.toBe(injected)
        else await expect(attempt).rejects.toThrow(EXPIRED)
        expect(acknowledgedBoundary).toBe(true)
        const committed = await durable(f.org)
        if (mode === 'lost-response') await service().release(lease)
        const replacement = await mustClaim(f.org, f.run.id),
          receipt = await service().commitVoucherPage(replacement, input)
        expect(receipt).toStrictEqual({
          runId: f.run.id,
          pageId: committed.pages[0]!.id,
          page: 1,
          digest: oracle(1, 1, 1, [voucher(1)]).digest,
        })
        const replayed = await durable(f.org)
        expect(replayed.pages).toStrictEqual(committed.pages)
        expect(replayed.checkpoints).toStrictEqual(committed.checkpoints)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it('förvrängt verkligt kvittoläsresultat ger inget lyckat kvitto och ändrar inte committad sida', async () => {
    const f = await fixture(),
      hooked = await controlled(),
      input = envelope(1, 1, 1, [voucher(1)])
    let wrote = false,
      corrupted = false
    hooked.hooks.after = async (params) => {
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'create') wrote = true
    }
    hooked.hooks.transform = (params, result) => {
      if (
        wrote &&
        params.model === 'FortnoxReadManifestPage' &&
        params.action === 'findUnique' &&
        record(result) &&
        result.page === 1
      ) {
        corrupted = true
        return { ...result, digest: '0'.repeat(64) }
      }
      return result
    }
    try {
      await expect(service(hooked.client).commitVoucherPage(f.lease, input)).rejects.toThrow(
        'Sparat manifestunderlag är ofullständigt eller ogiltigt',
      )
      expect(corrupted).toBe(true)
      const before = await durable(f.org)
      expect(before.pages[0]).toMatchObject(oracle(1, 1, 1, [voucher(1)]))
      expect(before.runs[0]).toMatchObject({
        phase: 'DETAILS',
        status: 'RUNNING',
        nextManifestPage: 2,
      })
      expect(await service().commitVoucherPage(f.lease, input)).toStrictEqual({
        runId: f.run.id,
        pageId: before.pages[0]!.id,
        page: 1,
        digest: before.pages[0]!.digest,
      })
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await hooked.client.$disconnect()
    }
  })

  it('positiv SQL-kanarie förbrukar alla entries och tom mellansida, med omedelbar constraint mellan stegen', async () => {
    const f = await fixture()
    const ids = await tx(async (c) => {
      await c.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
      const inserted: string[] = [],
        keys = new Set<string>()
      for (const item of CHAIN) {
        await c.$executeRaw`SET CONSTRAINTS "fortnox_manifest_page_must_advance" DEFERRED`
        inserted.push(await rawPage(c, f, item.page))
        for (const entry of item.page.entries)
          if (!keys.has(entry.key)) {
            await rawKey(c, f, entry)
            keys.add(entry.key)
          }
        await rawAdvance(c, f, item.page, item.page.page === 3 ? 'DETAILS' : 'MANIFEST')
        await c.$executeRaw`SET CONSTRAINTS "fortnox_manifest_page_must_advance" IMMEDIATE`
      }
      return inserted
    })
    const saved = await durable(f.org)
    expect(saved.pages.map((p) => p.id)).toStrictEqual(ids)
    expect(saved.checkpoints.map((v) => v.key)).toStrictEqual(['1|L|1', '1|L|10', '1|L|2'])
    for (const item of CHAIN)
      expect(await service().commitVoucherPage(f.lease, item.envelope)).toStrictEqual({
        runId: f.run.id,
        pageId: ids[item.page.page - 1],
        page: item.page.page,
        digest: item.page.digest,
      })
    expect(await durable(f.org)).toStrictEqual(saved)
  })

  it('fångat JS-fel utan cursor får inte committa halv sida, inte heller om caller därefter sätter FAILED', async () => {
    for (const failRun of [false, true]) {
      const f = await fixture(),
        before = await durable(f.org),
        injected = new Error('SYNTHETIC_CAUGHT_CHILD'),
        page = oracle(1, 2, 1, [voucher(1)])
      let inserted = false,
        caught = false,
        beforeCommit = false
      // Prisma 5.22 kan rapportera resolve trots COMMIT→ROLLBACK vid deferredfel.
      // Oberoende ny DB-klient, inklusive en markör i annan tabell, är facit.
      await Promise.allSettled([
        tx(async (c) => {
          await c.property.update({
            where: { id: f.propertyId },
            data: { name: 'SYNTHETIC_BEFORE_CHILD' },
          })
          try {
            await rawPage(c, f, page)
            await rawKey(c, f, page.entries[0]!)
            expect(
              await c.fortnoxReadManifestPage.count({
                where: { runId: f.run.id, organizationId: f.org },
              }),
            ).toBe(1)
            expect(
              await c.fortnoxReadVoucherCheckpoint.count({
                where: { runId: f.run.id, organizationId: f.org },
              }),
            ).toBe(1)
            inserted = true
            throw injected
          } catch (error) {
            expect(error).toBe(injected)
            caught = true
          }
          await c.property.update({
            where: { id: f.propertyId },
            data: { name: 'SYNTHETIC_AFTER_CAUGHT_CHILD' },
          })
          if (failRun)
            await c.$executeRaw`UPDATE "FortnoxReadRun" SET status='FAILED',reason='SYNTHETIC_CAUGHT_STOP',"completedAt"=timezone('UTC',clock_timestamp()),"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()),"claimToken"=NULL,"leaseUntil"=NULL WHERE id=${f.run.id} AND "organizationId"=${f.org}`
          expect(
            (await c.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })).status,
          ).toBe(failRun ? 'FAILED' : 'RUNNING')
          beforeCommit = true
        }),
      ])
      expect(inserted).toBe(true)
      expect(caught).toBe(true)
      expect(beforeCommit).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    }
  })

  it('named IMMEDIATE ger exakt SQL23514 före COMMIT för halv sida, även efter FAILED', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      page = oracle(1, 2, 1, [voucher(1)])
    let actualPage = false,
      terminal = false
    await sqlReject(async (c) => {
      await c.property.update({
        where: { id: f.propertyId },
        data: { name: 'SYNTHETIC_IMMEDIATE_MARKER' },
      })
      await rawPage(c, f, page)
      await rawKey(c, f, page.entries[0]!)
      actualPage = true
      await c.$executeRaw`UPDATE "FortnoxReadRun" SET status='FAILED',reason='SYNTHETIC_CAUGHT_STOP',"completedAt"=timezone('UTC',clock_timestamp()),"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()),"claimToken"=NULL,"leaseUntil"=NULL WHERE id=${f.run.id} AND "organizationId"=${f.org}`
      terminal = true
      await c.$executeRaw`SET CONSTRAINTS "fortnox_manifest_page_must_advance" IMMEDIATE`
    })
    expect(actualPage).toBe(true)
    expect(terminal).toBe(true)
    expect(await durable(f.org)).toStrictEqual(before)
  })

  it('SQL kräver alla aktuella nycklar även på mellansida, korrekt digest och full sista täckning', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      middle = oracle(1, 2, 2, [voucher(1), voucher(2)])
    let partialKeys = false
    await sqlReject(async (c) => {
      await rawPage(c, f, middle)
      await rawKey(c, f, middle.entries[0]!)
      expect(
        await c.fortnoxReadVoucherCheckpoint.count({
          where: { organizationId: f.org, runId: f.run.id },
        }),
      ).toBe(1)
      partialKeys = true
      await rawAdvance(c, f, middle, 'MANIFEST')
    })
    expect(partialKeys).toBe(true)
    await sqlReject(async (c) => {
      await rawPage(c, f, middle)
      await rawKey(c, f, { key: middle.entries[0]!.key, digest: '0'.repeat(64) })
    })
    await sqlReject(async (c) => {
      await rawPage(c, f, middle)
      await rawKey(c, f, { key: '1|L|99', digest: hash(voucher(99)) })
    })
    await sqlReject(async (c) => {
      const last = oracle(1, 1, 2, [voucher(1)])
      await rawPage(c, f, last)
      await rawKey(c, f, last.entries[0]!)
      await rawAdvance(c, f, last, 'DETAILS')
    })
    await sqlReject(async (c) => {
      await rawPage(c, f, middle)
      for (const entry of middle.entries) await rawKey(c, f, entry)
      await rawAdvance(c, f, middle, 'DETAILS')
    })
    await sqlReject(
      (c) =>
        c.$executeRaw`UPDATE "FortnoxReadRun" SET "nextManifestPage"=2,"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()) WHERE id=${f.run.id}`,
    )
    expect(await durable(f.org)).toStrictEqual(before)
  })

  it('SQL avvisar null/felform, främmande scope och detaljdata utan att tunna sidans positiva kontrakt', async () => {
    const f = await fixture(),
      other = await fixture(),
      before = await durable(f.org),
      foreignBefore = await durable(other.org),
      good = oracle(1, 1, 1, [voucher(1)])
    const invalidEntries = [
      null,
      {},
      [{ key: '2|L|1', digest: hash(voucher(1)) }],
      [{ key: '1|L|1', digest: hash(voucher(1)), extra: true }],
      [{ key: '1|L|1', digest: 'bad' }],
    ]
    for (const entries of invalidEntries)
      await sqlReject(
        (c) =>
          c.$executeRaw`INSERT INTO "FortnoxReadManifestPage" (id,"organizationId","runId",page,"totalPages","totalResources","itemCount",digest,entries) VALUES (${randomUUID()},${f.org},${f.run.id},1,1,1,1,${good.digest},${JSON.stringify(entries)}::jsonb)`,
      )
    await sqlReject(
      (c) =>
        c.$executeRaw`INSERT INTO "FortnoxReadManifestPage" (id,"organizationId","runId",page,"totalPages","totalResources","itemCount",digest,entries) VALUES (${randomUUID()},${f.org},${f.run.id},1,1,0,0,${good.digest},NULL)`,
    )
    await sqlReject((c) => rawPage(c, f, good, other.org), '23503')
    await sqlReject(async (c) => {
      await rawPage(c, f, good)
      await rawKey(c, f, good.entries[0]!, other.org)
    }, '23503')
    await sqlReject(async (c) => {
      await rawPage(c, f, good)
      await c.$executeRaw`INSERT INTO "FortnoxReadVoucherCheckpoint" (id,"organizationId","runId",key,"manifestDigest","detailDigest",validated,"observedAt") VALUES (${randomUUID()},${f.org},${f.run.id},${good.entries[0]!.key},${good.entries[0]!.digest},${'a'.repeat(64)},'{}'::jsonb,timezone('UTC',clock_timestamp()))`
    })
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await durable(other.org)).toStrictEqual(foreignBefore)
    // Positiv kontroll på samma run: det är inte en ogiltig grundfixture.
    expect(
      (await service().commitVoucherPage(f.lease, envelope(1, 1, 1, [voucher(1)]))).digest,
    ).toBe(good.digest)
  })

  it('v2-barn kan varken skrivas om, raderas, trunkeras eller adopteras från v1; rena v1-barn förblir skrivbara', async () => {
    const f = await fixture(),
      old = await v1Fixture(),
      input = envelope(1, 1, 1, [voucher(1)])
    await service().commitVoucherPage(f.lease, input)
    await old.owner.commitVoucherPage(old.lease, input)
    const before = await durable(f.org),
      legacy = await durable(old.org),
      p = before.pages[0]!,
      v = before.checkpoints[0]!,
      lp = legacy.pages[0]!,
      lv = legacy.checkpoints[0]!
    for (const sql of [
      Prisma.sql`UPDATE "FortnoxReadManifestPage" SET digest=digest WHERE id=${p.id}`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "detailDigest"=${'a'.repeat(64)},validated='{}'::jsonb,"observedAt"=timezone('UTC',clock_timestamp()) WHERE id=${v.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadManifestPage" WHERE id=${p.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadVoucherCheckpoint" WHERE id=${v.id}`,
      Prisma.sql`UPDATE "FortnoxReadManifestPage" SET "runId"=${f.run.id},"organizationId"=${f.org} WHERE id=${lp.id}`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "runId"=${f.run.id},"organizationId"=${f.org} WHERE id=${lv.id}`,
      Prisma.sql`TRUNCATE "FortnoxReadManifestPage"`,
      Prisma.sql`TRUNCATE "FortnoxReadVoucherCheckpoint"`,
    ])
      await sqlReject((c) => c.$executeRaw(sql))
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await durable(old.org)).toStrictEqual(legacy)
    // Den delade lagringen är avsiktligt inte globalt append-only för v1.
    await tx(async (c) => {
      expect(
        await c.$executeRaw`UPDATE "FortnoxReadManifestPage" SET digest=digest WHERE id=${lp.id}`,
      ).toBe(1)
      expect(
        await c.$executeRaw`UPDATE "FortnoxReadVoucherCheckpoint" SET "detailDigest"=${'b'.repeat(64)},validated='{}'::jsonb,"observedAt"=timezone('UTC',clock_timestamp()) WHERE id=${lv.id}`,
      ).toBe(1)
    })
    expect((await durable(old.org)).checkpoints[0]).toMatchObject({
      detailDigest: 'b'.repeat(64),
      validated: {},
      observedAt: expect.any(Date),
    })
    await tx(async (c) => {
      expect(await c.$executeRaw`DELETE FROM "FortnoxReadManifestPage" WHERE id=${lp.id}`).toBe(1)
      expect(
        await c.$executeRaw`DELETE FROM "FortnoxReadVoucherCheckpoint" WHERE id=${lv.id}`,
      ).toBe(1)
    })
    expect((await durable(old.org)).pages).toStrictEqual([])
    expect((await durable(old.org)).checkpoints).toStrictEqual([])
  })

  it('direkta SQL-sidor kräver aktuell lease och anslutning; tjänstens anslutningsstopp bevarar tidigare sidor', async () => {
    const f = await fixture(),
      page = oracle(1, 2, 2, [voucher(1)])
    await service().release(f.lease)
    const unclaimed = await durable(f.org)
    await sqlReject((c) => rawPage(c, f, page))
    expect(await durable(f.org)).toStrictEqual(unclaimed)
    const shortOwner = new ShortLeaseService(db()),
      short = await mustClaim(f.org, f.run.id, shortOwner)
    await databaseAfter(short.leaseUntil)
    const expired = await durable(f.org)
    await sqlReject((c) => rawPage(c, f, page))
    expect(await durable(f.org)).toStrictEqual(expired)
    const lease = await mustClaim(f.org, f.run.id)
    await service().commitVoucherPage(lease, envelope(1, 2, 2, [voucher(1)]))
    await db().fortnoxConnection.update({
      where: { id: f.connection.id },
      data: { generation: { increment: 1 } },
    })
    const changed = await durable(f.org)
    await sqlReject((c) => rawPage(c, f, oracle(2, 2, 2, [voucher(2)])))
    await expect(
      service().commitVoucherPage(lease, envelope(2, 2, 2, [voucher(2)])),
    ).rejects.toBeInstanceOf(ConflictException)
    const stopped = await durable(f.org)
    expect(stopped.runs[0]).toMatchObject({
      status: 'FAILED',
      claimToken: null,
      leaseUntil: null,
      nextManifestPage: 2,
    })
    expect(stopped.pages).toStrictEqual(changed.pages)
    expect(stopped.checkpoints).toStrictEqual(changed.checkpoints)
  })

  it('främmande organisation får inget manifest; ägd orgcascade tar barn men bevarar den andra körningen', async () => {
    const f = await fixture(),
      other = await fixture(),
      input = envelope(1, 1, 1, [voucher(1)])
    await service().commitVoucherPage(f.lease, input)
    await service().commitVoucherPage(other.lease, input)
    const foreignBefore = await durable(other.org),
      before = await durable(f.org),
      foreignLease: SourceRunLease = { ...f.lease, organizationId: other.org }
    await expect(service().getVoucherStep(foreignLease)).rejects.toBeInstanceOf(ConflictException)
    await expect(service().commitVoucherPage(foreignLease, input)).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await durable(other.org)).toStrictEqual(foreignBefore)
    expect((await db().organization.findUniqueOrThrow({ where: { id: f.org } })).name).toBe(
      `synthetic-v2-manifest-${f.org}`,
    )
    await db().fortnoxVoucherExport.delete({ where: { id: f.exportId } })
    await db().journalEntryLine.deleteMany({ where: { journalEntryId: f.journalId } })
    await db().journalEntry.delete({ where: { id: f.journalId } })
    await db().account.deleteMany({ where: { id: { in: [f.bank, f.expense] } } })
    await db().organization.delete({ where: { id: f.org } })
    orgs.delete(f.org)
    expect(await durable(f.org)).toStrictEqual({
      runs: [],
      pages: [],
      checkpoints: [],
      snapshots: [],
      properties: [],
    })
    expect(await durable(other.org)).toStrictEqual(foreignBefore)
  })

  it('verklig sid-SQL läser inte om context-, normalforms- eller råexportpayloads', async () => {
    const f = await fixture(),
      sql: string[] = []
    const client = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
      log: [{ emit: 'event', level: 'query' }],
    })
    client.$on('query', (event) => {
      sql.push(event.query)
    })
    const dependency = Object.assign(client, {
      onModuleInit: async () => {
        await client.$connect()
      },
      onModuleDestroy: async () => {
        await client.$disconnect()
      },
    })
    try {
      await client.$connect()
      const owner = new FortnoxReadSourceRunService(dependency)
      const receipt = await owner.commitVoucherPage(f.lease, envelope(1, 1, 1, [voucher(1)]))
      expect(await owner.getVoucherStep(f.lease)).toStrictEqual({ phase: 'DETAILS', key: '1|L|1' })
      expect(receipt.digest).toBe(oracle(1, 1, 1, [voucher(1)]).digest)
      const reads = sql.filter((query) => /^\s*SELECT\b/i.test(query))
      expect(reads.some((query) => query.includes('FortnoxReadManifestPage'))).toBe(true)
      expect(reads.some((query) => query.includes('FortnoxReadVoucherCheckpoint'))).toBe(true)
      for (const table of [
        'FortnoxReadContextPage',
        'FortnoxReadNormalizationPage',
        'FortnoxReadSourceExport',
        'FortnoxReadSourceMapping',
      ])
        expect(sql.some((query) => query.includes(`"${table}"`))).toBe(false)
    } finally {
      await client.$disconnect()
    }
  })
})
