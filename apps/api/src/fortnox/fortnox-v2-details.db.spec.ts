/** Riktig syntetisk PostgreSQL. Handfacit använder inte produktens normaliserare.
 * Enbart befintlig läskärna: ingen provider, HTTP, reducering eller ekonomisk effekt.
 * Verkliga queries/barriärer och oberoende commit-observer; inga triggerundantag.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import type { FortnoxVoucher } from './fortnox.types'
import type { ValidatedLedgerVoucher } from './fortnox-ledger-validation'
import {
  FortnoxReadSourceRunService,
  type SourceRunLease,
  type VoucherDetailReceipt,
} from './fortnox-read-source-run.service'

const INPUT = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
const DETAIL_CONFLICT = 'Verifikationsdetaljen är ogiltig eller ändrades under läsningen.'
const INVALID_CONTEXT = 'Sparat läsunderlag är ogiltigt; starta en ny läsning.'
const WRONG_POSITION = 'Verifikatet hör inte till aktuellt lässteg'
const EXPIRED = 'Läsanspråket har upphört'
const RAW_MARKER = 'SYNTHETIC_DETAIL_PRIVATE_BODY'
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
  if (!raw) throw new Error('V2-detaljer kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw),
    name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('V2-detaljer tillåter endast egen lokal testdatabas eller CI')
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
  if (text === undefined) throw new Error('Detaljfacit kräver JSON')
  return createHash('sha256').update(text).digest('hex')
}
type RawDetail = FortnoxVoucher & { UnknownVoucher?: { body: string } }
const HAND: Array<{ number: number; raw: RawDetail; expected: ValidatedLedgerVoucher }> = [
  {
    number: 1,
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 1,
      TransactionDate: '2026-09-30',
      CostCenter: { body: RAW_MARKER },
      ReferenceType: 7,
      ReferenceNumber: false,
      Description: RAW_MARKER,
      VoucherRows: [
        { Account: 2440, Credit: 10.05, Debit: null, Description: RAW_MARKER },
        { Account: 5170, Debit: 10.05, CostCenter: '', Project: 'Å A\u030A', Removed: true },
      ],
    },
    expected: {
      key: '1|L|1',
      date: '2026-09-30',
      headerDimensionPresent: true,
      reference: { type: null, number: null },
      rows: [
        {
          index1: 1,
          account: 2440,
          debitOre: 0,
          creditOre: 1005,
          costCenter: null,
          project: null,
          removed: false,
        },
        {
          index1: 2,
          account: 5170,
          debitOre: 1005,
          creditOre: 0,
          costCenter: null,
          project: 'Å A\u030A',
          removed: true,
        },
      ],
    },
  },
  {
    number: 10,
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 10,
      TransactionDate: '2026-10-01',
      ReferenceType: '',
      ReferenceNumber: '17',
      VoucherRows: [
        { Account: 5170, Debit: 0.1, Credit: 0.2, CostCenter: '0', Project: '' },
        { Account: 1930, Debit: 0.2, Credit: 0.1 },
      ],
    },
    expected: {
      key: '1|L|10',
      date: '2026-10-01',
      headerDimensionPresent: false,
      reference: { type: '', number: '17' },
      rows: [
        {
          index1: 1,
          account: 5170,
          debitOre: 10,
          creditOre: 20,
          costCenter: '0',
          project: null,
          removed: false,
        },
        {
          index1: 2,
          account: 1930,
          debitOre: 20,
          creditOre: 10,
          costCenter: null,
          project: null,
          removed: false,
        },
      ],
    },
  },
  {
    number: 2,
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 2,
      TransactionDate: '2026-12-31',
      CostCenter: '',
      Project: null,
      ReferenceType: '',
      ReferenceNumber: '',
      VoucherRows: [
        { Account: 1930, Debit: 1 },
        { Account: 2440, Credit: 0.99 },
      ],
    },
    expected: {
      key: '1|L|2',
      date: '2026-12-31',
      headerDimensionPresent: false,
      reference: null,
      rows: [
        {
          index1: 1,
          account: 1930,
          debitOre: 100,
          creditOre: 0,
          costCenter: null,
          project: null,
          removed: false,
        },
        {
          index1: 2,
          account: 2440,
          debitOre: 0,
          creditOre: 99,
          costCenter: null,
          project: null,
          removed: false,
        },
      ],
    },
  },
]
function detail(number: number): RawDetail {
  const hand = HAND.find((item) => item.number === number)
  return hand
    ? { ...hand.raw }
    : {
        Year: 1,
        VoucherSeries: 'L',
        VoucherNumber: number,
        TransactionDate: '2026-10-01',
        VoucherRows: [
          { Account: 1930, Debit: 1 },
          { Account: 2440, Credit: 1 },
        ],
      }
}
function expectedDetail(number: number): ValidatedLedgerVoucher {
  const hand = HAND.find((item) => item.number === number)
  return hand
    ? hand.expected
    : {
        key: `1|L|${number}`,
        date: '2026-10-01',
        headerDimensionPresent: false,
        reference: null,
        rows: [
          {
            index1: 1,
            account: 1930,
            debitOre: 100,
            creditOre: 0,
            costCenter: null,
            project: null,
            removed: false,
          },
          {
            index1: 2,
            account: 2440,
            debitOre: 0,
            creditOre: 100,
            costCenter: null,
            project: null,
            removed: false,
          },
        ],
      }
}
function manifest(keys: readonly number[], page: number, pages: number, total: number) {
  return {
    MetaInformation: { '@CurrentPage': page, '@TotalPages': pages, '@TotalResources': total },
    Vouchers: keys.map((number) => ({ Year: 1, VoucherSeries: 'L', VoucherNumber: number })),
  }
}
function detailWrite(params: Prisma.MiddlewareParams) {
  return params.model === 'FortnoxReadVoucherCheckpoint' && params.action === 'update'
}
function detailRead(params: Prisma.MiddlewareParams) {
  return (
    params.action === 'queryRaw' &&
    rawContains(params, 'FortnoxReadVoucherCheckpoint') &&
    rawContains(params, 'validated')
  )
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

describe('Fortnox v2-detaljer: frysta normalformer och återupptagbar läsning', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>(),
    accounts = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Detaljfixturen har inte startats')
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
        name: `synthetic-v2-details-${org}`,
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
        fortnoxOrgNumber: 'SYNTHETIC_V2_DETAILS',
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
          description: 'SYNTHETIC_V2_DETAILS',
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
  async function startFixture(
    base: Awaited<ReturnType<typeof baseFixture>>,
    keys: readonly number[],
    phase?: 'SOURCE_CAPTURED' | 'MANIFEST',
  ) {
    const owner = service(),
      run = await owner.start(base.org, null, INPUT),
      lease = await mustClaim(base.org, run.id, owner)
    let progress = await owner.prepareNormalization(lease)
    while (progress.next) {
      await owner.normalizePage(lease, progress.next)
      progress = await owner.prepareNormalization(lease)
    }
    if (phase !== 'SOURCE_CAPTURED') {
      await owner.commitCatalog(lease, catalog())
      if (phase !== 'MANIFEST') {
        const pages = Math.max(1, Math.ceil(keys.length / 100))
        for (let page = 1; page <= pages; page++)
          await owner.commitVoucherPage(
            lease,
            manifest(
              keys.slice((page - 1) * 100, page * 100),
              page,
              keys.length ? pages : 0,
              keys.length,
            ),
          )
      }
    }
    return { ...base, run, lease }
  }
  async function fixture(
    keys: readonly number[] = [2, 1, 10],
    phase?: 'SOURCE_CAPTURED' | 'MANIFEST',
  ) {
    return startFixture(await baseFixture(), keys, phase)
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function v1Fixture(keys: readonly number[] = [2, 1, 10]) {
    const base = await baseFixture(),
      owner = new FortnoxReadCheckpointService(db()),
      run = await owner.start(base.org, null, INPUT),
      lease = await owner.claim(base.org, run.id)
    if (!lease) throw new Error('V1-anspråk saknas')
    await owner.commitCatalog(lease, catalog())
    await owner.commitVoucherPage(lease, manifest(keys, 1, keys.length ? 1 : 0, keys.length))
    return { ...base, run, lease, owner }
  }
  async function complete(f: Fixture, keys: readonly number[] = [1, 10, 2]) {
    const receipts: VoucherDetailReceipt[] = []
    for (const number of keys)
      receipts.push(await service().commitVoucherDetail(f.lease, `1|L|${number}`, detail(number)))
    return receipts
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
  async function lock(c: Prisma.TransactionClient, f: Fixture) {
    await c.$queryRaw`SELECT id FROM "FortnoxConnection" WHERE id=${f.connection.id} AND "organizationId"=${f.org} FOR UPDATE`
    await c.$queryRaw`SELECT id FROM "FortnoxReadRun" WHERE id=${f.run.id} AND "organizationId"=${f.org} FOR UPDATE`
  }
  async function rawFull(
    c: Prisma.TransactionClient,
    f: Fixture,
    number: number,
    value: unknown = expectedDetail(number),
  ) {
    return c.$executeRaw`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=${JSON.stringify(value)}::jsonb,"detailDigest"=${hash(value)},"observedAt"=timezone('UTC',clock_timestamp()) WHERE "organizationId"=${f.org} AND "runId"=${f.run.id} AND key=${`1|L|${number}`}`
  }
  async function rawFinish(
    c: Prisma.TransactionClient,
    f: Fixture,
    phase: 'DETAILS' | 'READY_TO_REDUCE',
  ) {
    return c.$executeRaw`UPDATE "FortnoxReadRun" SET phase=${phase}::"FortnoxReadPhase","checkpointUpdatedAt"=timezone('UTC',clock_timestamp()) WHERE id=${f.run.id} AND "organizationId"=${f.org}`
  }
  async function expectStopped(
    f: Fixture,
    before: Awaited<ReturnType<typeof state>>,
    reason = DETAIL_CONFLICT,
  ) {
    const after = await durable(f.org)
    expect(after.pages).toStrictEqual(before.pages)
    expect(after.checkpoints).toStrictEqual(before.checkpoints)
    expect(after.snapshots).toStrictEqual(before.snapshots)
    expect(after.runs[0]).toMatchObject({
      status: 'FAILED',
      reason,
      phase: before.runs[0]!.phase,
      nextManifestPage: before.runs[0]!.nextManifestPage,
      claimVersion: before.runs[0]!.claimVersion,
      claimToken: null,
      leaseUntil: null,
      completedAt: expect.any(Date),
      summary: null,
      rows: null,
      frozenContext: null,
      coverage: {},
      uncertainties: [],
    })
    expect(after.runs[0]?.reason).not.toContain(RAW_MARKER)
    return after
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
          `synthetic-v2-details-${org}`,
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

  it('sparar hela handfacit i C-ordning genom omstart, med exakt v1-paritet och oförändrad råfältsreplay', async () => {
    const f = await fixture(),
      old = await v1Fixture(),
      receipts: VoucherDetailReceipt[] = []
    let owner = service(),
      lease = f.lease
    await expect(owner.readValidatedPage(lease)).rejects.toBeInstanceOf(ConflictException)
    for (const item of HAND) {
      expect(await owner.getVoucherStep(lease)).toStrictEqual({
        phase: 'DETAILS',
        key: item.expected.key,
      })
      const receipt = await owner.commitVoucherDetail(lease, item.expected.key, item.raw)
      receipts.push(receipt)
      expect(receipt).toStrictEqual({
        runId: f.run.id,
        checkpointId: expect.any(String),
        key: item.expected.key,
        detailDigest: hash(item.expected),
      })
      const saved = await db().fortnoxReadVoucherCheckpoint.findUniqueOrThrow({
        where: { id: receipt.checkpointId },
      })
      expect(saved).toMatchObject({
        key: item.expected.key,
        validated: item.expected,
        detailDigest: hash(item.expected),
        observedAt: expect.any(Date),
      })
      expect(saved.manifestDigest).not.toBe(receipt.detailDigest)
      await old.owner.commitVoucherDetail(old.lease, item.expected.key, item.raw)
      if (item.number === 1) {
        await owner.release(lease)
        owner = service()
        expect(await owner.start(f.org, null, INPUT)).toMatchObject({
          id: f.run.id,
          phase: 'DETAILS',
        })
        lease = await mustClaim(f.org, f.run.id, owner)
        expect(await owner.getVoucherStep(lease)).toStrictEqual({ phase: 'DETAILS', key: '1|L|10' })
      }
    }
    expect(await owner.getVoucherStep(lease)).toStrictEqual({ phase: 'READY_TO_REDUCE' })
    expect(await owner.readValidatedPage(lease)).toStrictEqual(HAND.map((item) => item.expected))
    expect(await old.owner.readValidatedPage(old.lease)).toStrictEqual(
      HAND.map((item) => item.expected),
    )
    const before = await durable(f.org)
    expect(before.runs[0]).toMatchObject({
      phase: 'READY_TO_REDUCE',
      status: 'RUNNING',
      frozenContext: null,
      summary: null,
      rows: null,
      completedAt: null,
      coverage: {},
      uncertainties: [],
    })
    expect(JSON.stringify(before.checkpoints)).not.toContain(RAW_MARKER)
    for (const [index, item] of HAND.entries()) {
      const replay: RawDetail = {
        ...item.raw,
        Description: 'ANNAN BESKRIVNING',
        UnknownVoucher: { body: RAW_MARKER },
      }
      expect(await owner.commitVoucherDetail(lease, item.expected.key, replay)).toStrictEqual(
        receipts[index],
      )
    }
    expect(await durable(f.org)).toStrictEqual(before)
    await owner.release(lease)
    owner = service()
    expect(await owner.start(f.org, null, INPUT)).toMatchObject({
      id: f.run.id,
      phase: 'READY_TO_REDUCE',
    })
    lease = await mustClaim(f.org, f.run.id, owner)
    expect(await owner.readValidatedPage(lease)).toStrictEqual(HAND.map((item) => item.expected))
    expect(await owner.commitVoucherDetail(lease, '1|L|1', detail(1))).toStrictEqual(receipts[0])
  })

  it('ändrad normalform vid äldre replay stoppar beständigt utan att ersätta första detaljen', async () => {
    const f = await fixture(),
      old = await v1Fixture()
    await complete(f)
    for (const item of HAND)
      await old.owner.commitVoucherDetail(old.lease, item.expected.key, item.raw)
    const changed = { ...detail(1), ReferenceNumber: 'ANNAN' },
      before = await durable(f.org)
    await expect(service().commitVoucherDetail(f.lease, '1|L|1', changed)).rejects.toThrow(
      DETAIL_CONFLICT,
    )
    await expectStopped(f, before)
    expect(await old.owner.commitVoucherDetail(old.lease, '1|L|1', changed)).toMatchObject({
      status: 'PARTIAL',
      reason: DETAIL_CONFLICT,
    })
  })

  it.each([
    {
      name: 'ogiltig sista rad på ej valt konto utanför oktober',
      bad: {
        ...detail(2),
        TransactionDate: '2026-09-30',
        VoucherRows: [
          { Account: 1930, Debit: 1 },
          { Account: 2440, Credit: 1 },
          { Account: 10000, Debit: 1 },
        ],
      },
    },
    {
      name: 'belopp med tre decimaler',
      bad: {
        ...detail(2),
        VoucherRows: [
          { Account: 1930, Debit: 0.001 },
          { Account: 2440, Credit: 1 },
        ],
      },
    },
    { name: 'fel identitet', bad: { ...detail(2), VoucherNumber: 99 } },
    { name: 'omöjligt kalenderdatum', bad: { ...detail(2), TransactionDate: '2026-02-30' } },
  ])(
    '$name avvisar hela sista detaljen och bevarar det giltiga prefixet utan publicering',
    async ({ bad }) => {
      const f = await fixture()
      await complete(f, [1, 10])
      const before = await durable(f.org)
      await expect(service().commitVoucherDetail(f.lease, '1|L|2', bad)).rejects.toThrow(
        DETAIL_CONFLICT,
      )
      await expectStopped(f, before)
      expect(
        (await durable(f.org)).checkpoints.find((row) => row.key === '1|L|2')?.validated,
      ).toBeNull()
    },
  )

  it('fel position, saknad manifestnyckel och fel fas nekas utan skrivning; v1:s parse-före-key bevaras', async () => {
    const f = await fixture(),
      before = await durable(f.org)
    await expect(service().commitVoucherDetail(f.lease, '1|L|2', detail(2))).rejects.toThrow(
      WRONG_POSITION,
    )
    await expect(service().commitVoucherDetail(f.lease, '1|L|99', detail(99))).rejects.toThrow(
      'Verifikatet saknas i det sparade manifestet',
    )
    expect(await durable(f.org)).toStrictEqual(before)
    for (const phase of ['SOURCE_CAPTURED', 'MANIFEST'] as const) {
      const early = await fixture([1], phase),
        untouched = await durable(early.org)
      await expect(
        service().commitVoucherDetail(early.lease, '1|L|1', undefined),
      ).rejects.toBeInstanceOf(ConflictException)
      await expect(service().readValidatedPage(early.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(await durable(early.org)).toStrictEqual(untouched)
    }
    // Giltig fence + DETAILS: invalid body valideras före saknad/fel nyckel som i v1.
    await expect(service().commitVoucherDetail(f.lease, '1|L|99', undefined)).rejects.toThrow(
      DETAIL_CONFLICT,
    )
    await expectStopped(f, before)
  })

  it.each(['same', 'conflicting', 'next'] as const)(
    'samtidig %s-detalj väntar på verkligt lås och avgör läget efter föregående commit',
    async (mode) => {
      const f = await fixture(),
        a = await controlled(),
        b = await controlled(),
        reached = deferred(),
        release = deferred()
      let firstWrite = false,
        secondWrites = 0
      a.hooks.after = async (params) => {
        if (detailWrite(params)) {
          firstWrite = true
          reached.resolve()
          await release.promise
        }
      }
      b.hooks.after = async (params) => {
        if (detailWrite(params)) secondWrites++
      }
      const first = service(a.client).commitVoucherDetail(f.lease, '1|L|1', detail(1)),
        firstDone = Promise.allSettled([first])
      let secondDone: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        await barrier(reached.promise, firstDone)
        const second = service(b.client).commitVoucherDetail(
          f.lease,
          mode === 'next' ? '1|L|10' : '1|L|1',
          mode === 'next'
            ? detail(10)
            : mode === 'conflicting'
              ? { ...detail(1), ReferenceNumber: 'ANNAN' }
              : detail(1),
        )
        secondDone = Promise.allSettled([second])
        await barrier(waitBlocked(b.pid, a.pid), secondDone)
        release.resolve()
        if (mode === 'conflicting') {
          await expect(second).rejects.toThrow(DETAIL_CONFLICT)
          // Första W är committad; dess E kan hinna före eller efter andra anropets terminal.
          const settled = (await firstDone)[0]!
          if (settled.status === 'rejected') {
            expect(settled.reason).toBeInstanceOf(ConflictException)
            expect(settled.reason).toMatchObject({ message: EXPIRED })
          }
          const saved = await durable(f.org)
          expect(saved.runs[0]).toMatchObject({ status: 'FAILED', reason: DETAIL_CONFLICT })
          expect(saved.checkpoints.filter((row) => row.detailDigest !== null)).toHaveLength(1)
          expect(saved.checkpoints.find((row) => row.key === '1|L|1')?.validated).toStrictEqual(
            expectedDetail(1),
          )
          expect(secondWrites).toBe(0)
        } else {
          const initial = await first,
            following = await second
          if (mode === 'same') {
            expect(following).toStrictEqual(initial)
            expect(secondWrites).toBe(0)
          } else {
            expect(following.key).toBe('1|L|10')
            expect(secondWrites).toBe(1)
          }
          expect(await service().getVoucherStep(f.lease)).toStrictEqual({
            phase: 'DETAILS',
            key: mode === 'same' ? '1|L|10' : '1|L|2',
          })
        }
        expect(firstWrite).toBe(true)
      } finally {
        release.resolve()
        await firstDone
        await secondDone
        await a.client.$disconnect()
        await b.client.$disconnect()
      }
    },
  )

  it('gammal fence nekas före replay/felbody och anslutningsbyte stoppar endast aktuell ägare', async () => {
    const f = await fixture(),
      receipt = await service().commitVoucherDetail(f.lease, '1|L|1', detail(1))
    await service().release(f.lease)
    const lease = await mustClaim(f.org, f.run.id),
      before = await durable(f.org)
    await expect(service().commitVoucherDetail(f.lease, '1|L|1', detail(1))).rejects.toThrow(
      EXPIRED,
    )
    await expect(service().commitVoucherDetail(f.lease, '1|L|10', undefined)).rejects.toThrow(
      EXPIRED,
    )
    await expect(service().readValidatedPage(f.lease)).rejects.toThrow(EXPIRED)
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await service().commitVoucherDetail(lease, '1|L|1', detail(1))).toStrictEqual(receipt)
    await db().fortnoxConnection.update({
      where: { id: f.connection.id },
      data: { generation: { increment: 1 } },
    })
    await expect(service().commitVoucherDetail(lease, '1|L|10', detail(10))).rejects.toBeInstanceOf(
      ConflictException,
    )
    const stopped = await durable(f.org)
    expect(stopped.runs[0]).toMatchObject({ status: 'FAILED', claimToken: null, leaseUntil: null })
    expect(stopped.checkpoints).toStrictEqual(before.checkpoints)
  })

  it.each(['child', 'immediate'] as const)(
    'verklig expiry efter %s rullar tillbaka detalj och eventuell fasändring',
    async (seam) => {
      const f = await fixture(seam === 'child' ? [1, 10] : [1]),
        hooked = await controlled(),
        { lease } = await shortLease(f),
        before = await durable(f.org)
      let childWritten = false,
        runWritten = false,
        reached = false
      hooked.hooks.after = async (params) => {
        if (detailWrite(params)) childWritten = true
        if (runWrite(params, 'phase', seam === 'child' ? 'DETAILS' : 'READY_TO_REDUCE'))
          runWritten = true
        if (
          (seam === 'child' && detailWrite(params)) ||
          (seam === 'immediate' &&
            rawContains(params, 'fortnox_v2_detail_must_advance') &&
            rawContains(params, 'IMMEDIATE'))
        ) {
          reached = true
          const saved = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
          if (!saved.leaseUntil) throw new Error('Faktisk deadline saknas')
          await databaseAfter(saved.leaseUntil)
        }
      }
      try {
        await expect(
          service(hooked.client).commitVoucherDetail(lease, '1|L|1', detail(1)),
        ).rejects.toThrow(EXPIRED)
        expect(reached).toBe(true)
        expect(childWritten).toBe(true)
        expect(runWritten).toBe(seam === 'immediate')
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it.each(['incoming', 'stored-read'] as const)(
    'expiry före terminal UPDATE för %s får inte lämna FAILED',
    async (mode) => {
      const f = await fixture([1])
      if (mode === 'stored-read') await complete(f, [1])
      const hooked = await controlled(),
        { lease } = await shortLease(f),
        before = await durable(f.org)
      let beforeWrite = false,
        actualWrite = false,
        corrupted = false
      hooked.hooks.transform = (params, result) => {
        if (mode === 'stored-read' && detailRead(params) && Array.isArray(result)) {
          corrupted = true
          return result.map((row) => (record(row) ? { ...row, detailDigest: '0'.repeat(64) } : row))
        }
        return result
      }
      hooked.hooks.before = async (params) => {
        if (runWrite(params, 'status', 'FAILED')) {
          beforeWrite = true
          const saved = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
          if (!saved.leaseUntil) throw new Error('Faktisk deadline saknas')
          await databaseAfter(saved.leaseUntil)
        }
      }
      hooked.hooks.after = async (params) => {
        if (runWrite(params, 'status', 'FAILED')) actualWrite = true
      }
      try {
        const pending =
          mode === 'incoming'
            ? service(hooked.client).commitVoucherDetail(lease, '1|L|1', undefined)
            : service(hooked.client).readValidatedPage(lease)
        await expect(pending).rejects.toThrow(EXPIRED)
        expect(beforeWrite).toBe(true)
        expect(actualWrite).toBe(true)
        expect(corrupted).toBe(mode === 'stored-read')
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it.each(['child', 'run', 'sql'] as const)(
    'propagerat %s-fel efter riktig skrivning rullar tillbaka utan detaljterminal',
    async (seam) => {
      const f = await fixture([1]),
        hooked = await controlled(),
        before = await durable(f.org),
        injected = new Error(`SYNTHETIC_DETAIL_${seam}`)
      let wrote = false
      hooked.hooks.after = async (params) => {
        if (
          ((seam === 'child' || seam === 'sql') && detailWrite(params)) ||
          (seam === 'run' && runWrite(params, 'phase', 'READY_TO_REDUCE'))
        ) {
          wrote = true
          if (seam === 'sql')
            await db().$queryRaw`SELECT 1 / 0 AS synthetic_detail_division_by_zero`
          else throw injected
        }
      }
      try {
        const pending = service(hooked.client).commitVoucherDetail(f.lease, '1|L|1', detail(1))
        if (seam === 'sql')
          await expect(pending).rejects.toMatchObject({ code: 'P2010', meta: { code: '22012' } })
        else await expect(pending).rejects.toBe(injected)
        expect(wrote).toBe(true)
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it.each(['lost-response', 'expiry', 'corrupt-receipt'] as const)(
    '%s efter faktisk commit bevarar detaljen för ny ägares replay',
    async (mode) => {
      const f = await fixture([1]),
        hooked = await controlled(),
        lease = mode === 'expiry' ? (await shortLease(f)).lease : f.lease
      const injected = new Error('SYNTHETIC_DETAIL_LOST_RECEIPT')
      let wrote = false,
        observed = false
      hooked.hooks.after = async (params, result) => {
        if (detailWrite(params)) wrote = true
        if (
          wrote &&
          params.model === 'FortnoxReadVoucherCheckpoint' &&
          params.action === 'findUnique' &&
          record(result) &&
          result.detailDigest !== null
        ) {
          observed = true
          const saved = await durable(f.org)
          expect(saved.checkpoints[0]?.validated).toStrictEqual(expectedDetail(1))
          expect(saved.runs[0]).toMatchObject({ phase: 'READY_TO_REDUCE', status: 'RUNNING' })
          if (mode === 'lost-response') throw injected
          if (mode === 'expiry') {
            const deadline = saved.runs[0]?.leaseUntil
            if (!deadline) throw new Error('Commitsidans deadline saknas')
            await databaseAfter(deadline)
          }
        }
      }
      hooked.hooks.transform = (params, result) =>
        mode === 'corrupt-receipt' &&
        wrote &&
        params.model === 'FortnoxReadVoucherCheckpoint' &&
        params.action === 'findUnique' &&
        record(result)
          ? { ...result, detailDigest: '0'.repeat(64) }
          : result
      try {
        const pending = service(hooked.client).commitVoucherDetail(lease, '1|L|1', detail(1))
        if (mode === 'lost-response') await expect(pending).rejects.toBe(injected)
        else if (mode === 'expiry') await expect(pending).rejects.toThrow(EXPIRED)
        else await expect(pending).rejects.toBeInstanceOf(ConflictException)
        expect(observed).toBe(true)
        const saved = await durable(f.org)
        if (mode !== 'expiry') await service().release(lease)
        const next = await mustClaim(f.org, f.run.id)
        expect(await service().commitVoucherDetail(next, '1|L|1', detail(1))).toStrictEqual({
          runId: f.run.id,
          checkpointId: saved.checkpoints[0]!.id,
          key: '1|L|1',
          detailDigest: hash(expectedDetail(1)),
        })
        expect((await durable(f.org)).checkpoints).toStrictEqual(saved.checkpoints)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it.each(['hash', 'coherent-wrong-date', 'coherent-key-mismatch', 'coherent-wrong-year'] as const)(
    'sen sparad %s-korruption i verklig SELECT nekas utan partiellt lässvar',
    async (mode) => {
      const f = await fixture()
      await complete(f)
      const before = await durable(f.org),
        hooked = await controlled()
      let touched = false
      hooked.hooks.transform = (params, result) => {
        if (!detailRead(params) || !Array.isArray(result)) return result
        expect(result).toHaveLength(3)
        return result.map((row, index) => {
          if (index !== 2 || !record(row)) return row
          touched = true
          if (mode === 'hash') return { ...row, detailDigest: '0'.repeat(64) }
          // Giltigt schema och koherent hash: datum, radnyckel och fryst år prövas var för sig.
          const invalid =
            mode === 'coherent-wrong-date'
              ? { ...expectedDetail(2), date: '2027-01-01' }
              : { ...expectedDetail(2), key: mode === 'coherent-key-mismatch' ? '1|L|99' : '2|L|2' }
          return {
            ...row,
            ...(mode === 'coherent-wrong-year' ? { key: '2|L|2' } : {}),
            validated: invalid,
            detailDigest: hash(invalid),
          }
        })
      }
      try {
        await expect(service(hooked.client).readValidatedPage(f.lease)).rejects.toThrow(
          INVALID_CONTEXT,
        )
        expect(touched).toBe(true)
        await expectStopped(f, before, INVALID_CONTEXT)
      } finally {
        await hooked.client.$disconnect()
      }
    },
  )

  it('C-keyset läser101 fulla detaljer utan luckor, även med godtycklig cursor, annan run/org och tom READY', async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1),
      orderedNumbers = [...numbers].sort((a, b) => (`1|L|${a}` < `1|L|${b}` ? -1 : 1))
    const other = await fixture([1])
    await complete(other, [1])
    // Äldre run i samma org: avsluta en fullt giltig annan run och starta ny.
    const old = await fixture([1])
    await complete(old, [1])
    await expect(
      service().commitVoucherDetail(old.lease, '1|L|1', {
        ...detail(1),
        ReferenceNumber: 'KONFLIKT',
      }),
    ).rejects.toThrow(DETAIL_CONFLICT)
    const oldSaved = await durable(old.org),
      f = await startFixture(old, numbers)
    expect(f.run.id).not.toBe(old.run.id)
    await complete(f, orderedNumbers)
    const before = await durable(f.org),
      foreignBefore = await durable(other.org)
    const first = await service().readValidatedPage(f.lease),
      last = await service().readValidatedPage(f.lease, { afterKey: first.at(-1)!.key })
    expect(first).toHaveLength(100)
    expect(last).toHaveLength(1)
    expect([...first, ...last]).toStrictEqual(orderedNumbers.map(expectedDetail))
    expect(await service().readValidatedPage(f.lease, { afterKey: last[0]!.key })).toStrictEqual([])
    expect(before.checkpoints.some((row) => row.runId === f.run.id && row.key === '1|L|111')).toBe(
      false,
    )
    expect(
      await service().readValidatedPage(f.lease, { afterKey: '1|L|111', limit: 2 }),
    ).toStrictEqual([expectedDetail(12), expectedDetail(13)])
    const forged: SourceRunLease = { ...f.lease, organizationId: other.org }
    await expect(service().readValidatedPage(forged)).rejects.toBeInstanceOf(ConflictException)
    await expect(
      service().readValidatedPage({ ...f.lease, runId: old.run.id }),
    ).rejects.toBeInstanceOf(ConflictException)
    for (const limit of [0, 101])
      await expect(service().readValidatedPage(f.lease, { limit })).rejects.toThrow(
        'Ogiltig detaljsida',
      )
    expect(await durable(f.org)).toStrictEqual(before)
    expect(await durable(other.org)).toStrictEqual(foreignBefore)
    expect(
      (await durable(old.org)).checkpoints.filter((row) => row.runId === old.run.id),
    ).toStrictEqual(oldSaved.checkpoints)
    const empty = await fixture([])
    expect(await service().readValidatedPage(empty.lease)).toStrictEqual([])
    expect((await durable(empty.org)).runs[0]).toMatchObject({
      status: 'RUNNING',
      phase: 'READY_TO_REDUCE',
      summary: null,
      rows: null,
    })
  }, 30_000)

  it('positiv SQL-kanarie sparar varje normalform en gång och bevisar korrekt mellan- och slutfas', async () => {
    const f = await fixture(),
      before = await durable(f.org)
    await tx(async (c) => {
      await lock(c, f)
      await c.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
      for (const item of HAND) {
        await c.$executeRaw`SET CONSTRAINTS "fortnox_v2_detail_must_advance" DEFERRED`
        expect(await rawFull(c, f, item.number)).toBe(1)
        await rawFinish(c, f, item.number === 2 ? 'READY_TO_REDUCE' : 'DETAILS')
        await c.$executeRaw`SET CONSTRAINTS "fortnox_v2_detail_must_advance" IMMEDIATE`
      }
    })
    const saved = await durable(f.org)
    expect(saved.pages).toStrictEqual(before.pages)
    expect(saved.snapshots).toStrictEqual(before.snapshots)
    expect(saved.runs[0]).toMatchObject({
      nextManifestPage: before.runs[0]!.nextManifestPage,
      claimVersion: f.lease.claimVersion,
      claimToken: f.lease.claimToken,
      phase: 'READY_TO_REDUCE',
      status: 'RUNNING',
    })
    expect(await service().readValidatedPage(f.lease)).toStrictEqual(
      HAND.map((item) => item.expected),
    )
    for (const item of HAND)
      expect(
        (await service().commitVoucherDetail(f.lease, item.expected.key, item.raw)).detailDigest,
      ).toBe(hash(item.expected))
    expect(await durable(f.org)).toStrictEqual(saved)
  })

  it('SQL-minimum nekar topform, null, exakt kalenderfel, scope/ordning och tidsfel utan en ny radvalidator', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      normal = expectedDetail(1)
    const invalidForms = [
      null,
      {},
      { ...normal, extra: RAW_MARKER },
      { ...normal, key: '1|L|2' },
      { ...normal, date: '2026-02-30' },
      { ...normal, date: '2027-01-01' },
      { ...normal, headerDimensionPresent: 'true' },
      { ...normal, reference: { type: null } },
      { ...normal, rows: [normal.rows[0]!] },
    ]
    for (const value of invalidForms)
      await sqlReject(async (c) => {
        await lock(c, f)
        await rawFull(c, f, 1, value)
      })
    await sqlReject(async (c) => {
      await lock(c, f)
      await rawFull(c, f, 2)
    })
    for (const sql of [
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=${JSON.stringify(normal)}::jsonb WHERE "runId"=${f.run.id} AND key='1|L|1'`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=NULL,"detailDigest"=${hash(normal)},"observedAt"=timezone('UTC',clock_timestamp()) WHERE "runId"=${f.run.id} AND key='1|L|1'`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=${JSON.stringify(normal)}::jsonb,"detailDigest"='bad',"observedAt"=timezone('UTC',clock_timestamp()) WHERE "runId"=${f.run.id} AND key='1|L|1'`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=${JSON.stringify(normal)}::jsonb,"detailDigest"=${hash(normal)},"observedAt"=timezone('UTC',clock_timestamp())+interval '1 hour' WHERE "runId"=${f.run.id} AND key='1|L|1'`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=${JSON.stringify(normal)}::jsonb,"detailDigest"=${hash(normal)},"observedAt"=timezone('UTC',clock_timestamp())-interval '1 hour' WHERE "runId"=${f.run.id} AND key='1|L|1'`,
    ])
      await sqlReject(async (c) => {
        await lock(c, f)
        await c.$executeRaw(sql)
      })
    expect(await durable(f.org)).toStrictEqual(before)
    await service().release(f.lease)
    const unclaimed = await durable(f.org)
    await sqlReject(async (c) => {
      await lock(c, f)
      await rawFull(c, f, 1)
    })
    expect(await durable(f.org)).toStrictEqual(unclaimed)
    const lease = await mustClaim(f.org, f.run.id)
    expect((await service().commitVoucherDetail(lease, '1|L|1', detail(1))).detailDigest).toBe(
      hash(normal),
    )
  })

  it('SQL skyddar slutskrivna detaljer och runprogress, inklusive v1/null-adoption, men bevarar v1/null-skrivningar', async () => {
    const f = await fixture([1]),
      other = await fixture([1]),
      old = await v1Fixture([1])
    await complete(f, [1])
    const saved = await durable(f.org),
      foreignBefore = await durable(other.org),
      row = saved.checkpoints[0]!
    const legacy = await db().fortnoxReadRun.create({
      data: {
        organizationId: old.org,
        connectionId: old.connection.id,
        fortnoxDatabaseNumber: 900001,
        financialYearId: 1,
        periodFrom: new Date('2026-10-01'),
        periodTo: new Date('2026-10-31'),
        costAccounts: [5170],
        status: 'COMPLETE',
      },
    })
    const legacyRow = await db().fortnoxReadVoucherCheckpoint.create({
      data: {
        organizationId: old.org,
        runId: legacy.id,
        key: '1|L|1',
        manifestDigest: hash({ legacy: true }),
      },
    })
    const oldRow = (await durable(old.org)).checkpoints.find((v) => v.runId === old.run.id)!
    for (const sql of [
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "detailDigest"="detailDigest" WHERE id=${row.id}`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "detailDigest"=NULL,validated=NULL,"observedAt"=NULL WHERE id=${row.id}`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "runId"=${other.run.id},"organizationId"=${other.org} WHERE id=${row.id}`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "runId"=${f.run.id},"organizationId"=${f.org} WHERE id=${oldRow.id}`,
      Prisma.sql`UPDATE "FortnoxReadVoucherCheckpoint" SET "runId"=${f.run.id},"organizationId"=${f.org} WHERE id=${legacyRow.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadVoucherCheckpoint" WHERE id=${row.id}`,
      Prisma.sql`TRUNCATE "FortnoxReadVoucherCheckpoint"`,
    ])
      await sqlReject((c) => c.$executeRaw(sql))
    await sqlReject(async (c) => {
      await lock(c, other)
      await rawFinish(c, other, 'READY_TO_REDUCE')
    })
    expect(await durable(f.org)).toStrictEqual(saved)
    expect(await durable(other.org)).toStrictEqual(foreignBefore)
    // Äldre versioners radskrivning och direkt deletion är kvar enligt det gamla SQL-kontraktet.
    for (const id of [oldRow.id, legacyRow.id])
      await tx(async (c) => {
        expect(
          await c.$executeRaw`UPDATE "FortnoxReadVoucherCheckpoint" SET validated=${JSON.stringify(expectedDetail(1))}::jsonb,"detailDigest"=${hash(expectedDetail(1))},"observedAt"=timezone('UTC',clock_timestamp()) WHERE id=${id}`,
        ).toBe(1)
        expect(await c.$executeRaw`DELETE FROM "FortnoxReadVoucherCheckpoint" WHERE id=${id}`).toBe(
          1,
        )
      })
    expect((await durable(old.org)).checkpoints).toStrictEqual([])
  })

  it('deferred stateproof stoppar sista detalj utan READY även efter fångat fel+FAILED, men tillåter komplett prefix', async () => {
    for (const immediate of [false, true]) {
      const f = await fixture([1]),
        before = await durable(f.org),
        injected = new Error('SYNTHETIC_CAUGHT_DETAIL')
      let wrote = false,
        callbackEnd = false
      const work = async (c: Prisma.TransactionClient) => {
        await lock(c, f)
        await c.property.update({
          where: { id: f.propertyId },
          data: { name: 'SYNTHETIC_BEFORE_DETAIL' },
        })
        try {
          expect(await rawFull(c, f, 1)).toBe(1)
          expect(
            (await c.fortnoxReadVoucherCheckpoint.findFirstOrThrow({ where: { runId: f.run.id } }))
              .validated,
          ).toStrictEqual(expectedDetail(1))
          wrote = true
          throw injected
        } catch (error) {
          expect(error).toBe(injected)
        }
        await c.property.update({
          where: { id: f.propertyId },
          data: { name: 'SYNTHETIC_AFTER_DETAIL' },
        })
        await c.$executeRaw`UPDATE "FortnoxReadRun" SET status='FAILED',reason='SYNTHETIC_CAUGHT_DETAIL_STOP',"completedAt"=timezone('UTC',clock_timestamp()),"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()),"claimToken"=NULL,"leaseUntil"=NULL WHERE id=${f.run.id}`
        expect((await c.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
          'FAILED',
        )
        callbackEnd = true
        if (immediate)
          await c.$executeRaw`SET CONSTRAINTS "fortnox_v2_detail_must_advance" IMMEDIATE`
      }
      if (immediate) await sqlReject(work)
      else await Promise.allSettled([tx(work)]) // Prisma 5.22 kan dölja deferred COMMIT-felet; DB är facit.
      expect(wrote).toBe(true)
      expect(callbackEnd).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    }
    const prefix = await fixture([1, 10])
    await tx(async (c) => {
      await lock(c, prefix)
      await rawFull(c, prefix, 1)
      await c.$executeRaw`UPDATE "FortnoxReadRun" SET status='FAILED',reason='SYNTHETIC_COMPLETE_PREFIX',"completedAt"=timezone('UTC',clock_timestamp()),"checkpointUpdatedAt"=timezone('UTC',clock_timestamp()),"claimToken"=NULL,"leaseUntil"=NULL WHERE id=${prefix.run.id}`
      await c.$executeRaw`SET CONSTRAINTS "fortnox_v2_detail_must_advance" IMMEDIATE`
    })
    const saved = await durable(prefix.org)
    expect(saved.runs[0]).toMatchObject({ phase: 'DETAILS', status: 'FAILED' })
    expect(saved.checkpoints.find((row) => row.key === '1|L|1')?.validated).toStrictEqual(
      expectedDetail(1),
    )
    expect(saved.checkpoints.find((row) => row.key === '1|L|10')?.validated).toBeNull()
  })

  it('orgcascade raderar egna färdiga detaljer och bevarar främmande sentinel', async () => {
    const f = await fixture([1]),
      other = await fixture([1])
    await complete(f, [1])
    await complete(other, [1])
    const foreignBefore = await durable(other.org)
    expect((await db().organization.findUniqueOrThrow({ where: { id: f.org } })).name).toBe(
      `synthetic-v2-details-${f.org}`,
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

  it('faktiska hotqueries läser inga contextpayloads och giltig sida får inget kvitto efter verklig expiry', async () => {
    const f = await fixture([1]),
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
      await owner.commitVoucherDetail(f.lease, '1|L|1', detail(1))
      expect(await owner.readValidatedPage(f.lease, { limit: 1 })).toStrictEqual([
        expectedDetail(1),
      ])
      expect(sql.some((query) => query.includes('FortnoxReadVoucherCheckpoint'))).toBe(true)
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
    const hooked = await controlled(),
      { lease } = await shortLease(f),
      before = await durable(f.org)
    let actualRead = false
    hooked.hooks.after = async (params, result) => {
      if (detailRead(params)) {
        expect(Array.isArray(result) && result.length === 1).toBe(true)
        actualRead = true
        const saved = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
        if (!saved.leaseUntil) throw new Error('Faktisk deadline saknas')
        await databaseAfter(saved.leaseUntil)
      }
    }
    try {
      await expect(service(hooked.client).readValidatedPage(lease)).rejects.toThrow(EXPIRED)
      expect(actualRead).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await hooked.client.$disconnect()
    }
  })
})
