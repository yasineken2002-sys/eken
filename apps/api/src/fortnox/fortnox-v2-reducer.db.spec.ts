/** Verklig syntetisk PostgreSQL: intern v2-reducering, ingen provider/publicering.
 * Handräknat fullfacit och oberoende hashbytes. Felen injiceras först efter riktiga
 * queries; lagrade immutabla rader/guardar ändras aldrig. Root kör seriellt.
 */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { FortnoxReadSourceRunService } from './fortnox-read-source-run.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import type { FortnoxVoucher } from './fortnox.types'
import type { ValidatedLedgerVoucher } from './fortnox-ledger-validation'
import { readLedger, type LedgerReadResult } from './fortnox-ledger'
import { MockFortnoxLedgerReader } from './fortnox-providers'
import { enrichEvenoLedgerResult } from './fortnox-read-provenance'
import * as economic from './fortnox-ledger-reducer'
import * as reduction from './fortnox-read-reduction'
import * as normalizedContext from './fortnox-read-normalized-context'
import { CheckpointContextSchema } from './fortnox-read-checkpoint-context'

const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const EXPIRED = 'Läsanspråket har upphört'
const INVALID_CONTEXT = 'Sparat läsunderlag är ogiltigt; starta en ny läsning.'
const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'
const PRIVATE = 'SYNTHETIC_REDUCTION_PRIVATE_RAW'
const EMPTY_COVERAGE = { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 }
const ONE_COVERAGE = { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 }
const YEAR = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const key = (n: number) => `1|L|${n}`

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Reducerproven kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw),
    name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Reducerproven tillåter endast egen lokal testdatabas eller CI')
  url.searchParams.set('connection_limit', '4')
  return url.toString()
}
// Ovillkorlig precondition, inte gömd i describe.skip/beforeAll.
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
        .map(([k, v]) => [k, ordered(v)]),
    )
  return value
}
const bytesHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function hash(value: unknown) {
  const text = JSON.stringify(ordered(value))
  if (text === undefined) throw new Error('Handfacit måste vara JSON')
  return bytesHash(text)
}
function rawContains(params: Prisma.MiddlewareParams, text: string) {
  return (
    (params.action === 'queryRaw' || params.action === 'executeRaw') &&
    JSON.stringify(params.args, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ).includes(text)
  )
}
function detailRead(params: Prisma.MiddlewareParams) {
  return (
    params.action === 'queryRaw' &&
    rawContains(params, 'FortnoxReadVoucherCheckpoint') &&
    rawContains(params, 'validated')
  )
}
function contextPageRead(params: Prisma.MiddlewareParams) {
  return params.model === 'FortnoxReadContextPage' && params.action === 'findUnique'
}
function connectionLock(params: Prisma.MiddlewareParams) {
  return (
    params.action === 'queryRaw' &&
    rawContains(params, 'FortnoxConnection') &&
    rawContains(params, 'FOR UPDATE')
  )
}
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
  transform?: (params: Prisma.MiddlewareParams, result: unknown) => unknown
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
      throw new Error('Arbetet avslutades före barriären')
    }),
  ])
}
function catalog(input: StartCheckpointInput = INPUT): CheckpointCatalog {
  return {
    version: 1,
    companyDatabaseNumber: 900001,
    financialYear: { ...YEAR, accountingMethod: 'ACCRUAL' },
    accounts: input.costAccounts.map((number) => ({
      number,
      active: null,
      balanceBroughtForwardOre: null,
    })),
    dimensions: [],
    coverage: { costCenters: { ...EMPTY_COVERAGE } },
  }
}
function raw(n: number, ore = 1): FortnoxVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: n,
    TransactionDate: '2026-10-01',
    ReferenceNumber: `R${n}`,
    Description: PRIVATE,
    VoucherRows: [
      { Account: 5170, Debit: ore / 100 },
      { Account: 2440, Credit: ore / 100 },
    ],
  }
}
function normalized(n: number, ore = 1): ValidatedLedgerVoucher {
  return {
    key: key(n),
    date: '2026-10-01',
    headerDimensionPresent: false,
    reference: { type: null, number: `R${n}` },
    rows: [
      {
        index1: 1,
        account: 5170,
        debitOre: ore,
        creditOre: 0,
        costCenter: null,
        project: null,
        removed: false,
      },
      {
        index1: 2,
        account: 2440,
        debitOre: 0,
        creditOre: ore,
        costCenter: null,
        project: null,
        removed: false,
      },
    ],
  }
}
function envelope(numbers: readonly number[], page: number, totalPages: number, total: number) {
  return {
    MetaInformation: { '@CurrentPage': page, '@TotalPages': totalPages, '@TotalResources': total },
    Vouchers: numbers.map((n) => ({ Year: 1, VoucherSeries: 'L', VoucherNumber: n })),
  }
}
class HandReader extends MockFortnoxLedgerReader {
  constructor(private readonly manifestPages: readonly (readonly number[])[]) {
    super()
  }
  override async get<T>(
    token: string,
    path: string,
    query?: Readonly<Record<string, string | number>>,
  ): Promise<T> {
    if (path === '/3/vouchers/sublist') {
      const page = Number(query?.page ?? 1),
        numbers = this.manifestPages[page - 1]
      if (!numbers) throw new Error('Handfixturens manifestsida saknas')
      // En enda generisk assertion vid samma syntetiska GET-port som MockReader.
      return envelope(numbers, page, this.manifestPages.length, this.vouchers.length) as T
    }
    return super.get<T>(token, path, query)
  }
}
function nr(
  index1: number,
  account: number,
  debitOre: number,
  creditOre: number,
  costCenter: string | null = null,
  project: string | null = null,
  removed = false,
) {
  return { index1, account, debitOre, creditOre, costCenter, project, removed }
}
const HAND: Array<{ raw: FortnoxVoucher; expected: ValidatedLedgerVoucher }> = [
  {
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 1,
      TransactionDate: '2026-10-01',
      ReferenceType: '',
      ReferenceNumber: '7',
      VoucherRows: [
        { Account: 5170, Debit: 10.5, Credit: 0.5, CostCenter: 'HUS', Project: 'P' },
        { Account: 2440, Credit: 10 },
      ],
    },
    expected: {
      key: key(1),
      date: '2026-10-01',
      headerDimensionPresent: false,
      reference: { type: '', number: '7' },
      rows: [nr(1, 5170, 1050, 50, 'HUS', 'P'), nr(2, 2440, 0, 1000)],
    },
  },
  {
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 10,
      TransactionDate: '2026-10-02',
      ReferenceType: 7,
      ReferenceNumber: false,
      VoucherRows: [
        { Account: 5190, Credit: 2, Project: 'P' },
        { Account: 5170, Debit: 3, Removed: true },
        { Account: 2440, Debit: 2 },
      ],
    },
    expected: {
      key: key(10),
      date: '2026-10-02',
      headerDimensionPresent: false,
      reference: { type: null, number: null },
      rows: [
        nr(1, 5190, 0, 200, null, 'P'),
        nr(2, 5170, 300, 0, null, null, true),
        nr(3, 2440, 200, 0),
      ],
    },
  },
  {
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 11,
      TransactionDate: '2026-09-30',
      ReferenceNumber: 'OFF_PERIOD',
      VoucherRows: [
        { Account: 5170, Debit: 9.99 },
        { Account: 2440, Credit: 9.99 },
      ],
    },
    expected: {
      key: key(11),
      date: '2026-09-30',
      headerDimensionPresent: false,
      reference: { type: null, number: 'OFF_PERIOD' },
      rows: [nr(1, 5170, 999, 0), nr(2, 2440, 0, 999)],
    },
  },
  {
    raw: {
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: 2,
      TransactionDate: '2026-10-03',
      CostCenter: 'HEADER_ONLY',
      VoucherRows: [
        { Account: 5170, Debit: 0.5 },
        { Account: 5190, Debit: 0.7, CostCenter: 'X' },
        { Account: 2440, Credit: 1.2 },
      ],
    },
    expected: {
      key: key(2),
      date: '2026-10-03',
      headerDimensionPresent: true,
      reference: null,
      rows: [nr(1, 5170, 50, 0), nr(2, 5190, 70, 0, 'X'), nr(3, 2440, 0, 120)],
    },
  },
]

describe('Fortnox v2: intern reducering från oförändrad READY-källa', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>(),
    accounts = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Reducerfixturen har inte startat')
    return prisma
  }
  const service = (client = db()) => new FortnoxReadSourceRunService(client)
  const tx = <T>(work: (c: Prisma.TransactionClient) => Promise<T>) =>
    db().$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
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
    return { client, hooks }
  }
  async function baseFixture(mappingCount = 0, ownExport = false) {
    const org = randomUUID(),
      as = randomUUID(),
      ang = randomUUID(),
      ost = randomUUID(),
      journalId = randomUUID(),
      exportId = randomUUID(),
      bank = randomUUID(),
      expense = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-v2-reducer-${org}`,
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
        fortnoxOrgNumber: 'SYNTHETIC_V2_REDUCER',
      },
    })
    await tx(async (c) => {
      await c.property.createMany({
        data: [
          { id: as, name: 'Ås' },
          { id: ang, name: 'Äng' },
          { id: ost, name: 'Öst' },
        ].map((p) => ({
          ...p,
          organizationId: org,
          propertyDesignation: `SYNTHETIC ${p.id}`,
          type: 'RESIDENTIAL' as const,
          street: 'Testgata 2',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: '100.00',
        })),
      })
      if (mappingCount > 0)
        await c.fortnoxDimensionMapping.createMany({
          data: Array.from({ length: mappingCount }, (_, i) => ({
            organizationId: org,
            propertyId: as,
            dimensionType: 'COST_CENTER' as const,
            code: `D${String(i).padStart(3, '0')}`,
          })),
        })
      if (ownExport) {
        journals.add(journalId)
        exports.add(exportId)
        accounts.add(bank)
        accounts.add(expense)
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
            description: PRIVATE,
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
            externalNumber: 10,
            draft: {
              kontomappning: { revision: -7 },
              provenance: {
                lines: [
                  { localAccountNumber: 4000, externalAccountNumber: 5190 },
                  { localAccountNumber: 4001, externalAccountNumber: 5190 },
                  { localAccountNumber: 4010, externalAccountNumber: 5170 },
                ],
              },
            },
          },
        })
      }
    })
    return { org, connection, as, ang, ost, journalId, exportId }
  }
  type Base = Awaited<ReturnType<typeof baseFixture>>
  async function claim(f: { org: string; run: { id: string } }, owner = service()) {
    const lease = await owner.claim(f.org, f.run.id)
    if (!lease) throw new Error('Syntetiskt läsanspråk saknas')
    return lease
  }
  async function ready(
    base: Base,
    details: readonly FortnoxVoucher[],
    options: {
      input?: StartCheckpointInput
      catalog?: CheckpointCatalog
      pages?: readonly (readonly number[])[]
      leaveDetails?: boolean
    } = {},
  ) {
    const owner = service(),
      input = options.input ?? INPUT,
      cat = options.catalog ?? catalog(input)
    const run = await owner.start(base.org, null, input),
      lease = await claim({ org: base.org, run }, owner)
    let progress = await owner.prepareNormalization(lease)
    while (progress.next) {
      await owner.normalizePage(lease, progress.next)
      progress = await owner.prepareNormalization(lease)
    }
    await owner.commitCatalog(lease, cat)
    const numbers = details.map((d) => {
      if (typeof d.VoucherNumber !== 'number') throw new Error('Ogiltig syntetisk identitet')
      return d.VoucherNumber
    })
    const pages =
      options.pages ??
      Array.from({ length: Math.max(1, Math.ceil(numbers.length / 100)) }, (_, i) =>
        numbers.slice(i * 100, (i + 1) * 100),
      )
    for (const [i, entries] of pages.entries())
      await owner.commitVoucherPage(
        lease,
        envelope(entries, i + 1, numbers.length ? pages.length : 0, numbers.length),
      )
    if (!options.leaveDetails)
      for (const detail of [...details].sort((a, b) =>
        key(Number(a.VoucherNumber)) < key(Number(b.VoucherNumber)) ? -1 : 1,
      ))
        await owner.commitVoucherDetail(lease, key(Number(detail.VoucherNumber)), detail)
    return { ...base, run, lease, input, catalog: cat, pages, details }
  }
  const fixture = async (details: readonly FortnoxVoucher[] = [raw(1)]) =>
    ready(await baseFixture(), details)
  type Fixture = Awaited<ReturnType<typeof ready>>
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
      details: await client.fortnoxReadVoucherCheckpoint.findMany({
        where: { organizationId: org },
        orderBy: [{ runId: 'asc' }, { key: 'asc' }],
      }),
      snapshots: await client.fortnoxReadContextSnapshot.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      contextPages: await client.fortnoxReadContextPage.findMany({
        where: { organizationId: org },
        orderBy: [{ snapshotId: 'asc' }, { kind: 'asc' }, { page: 'asc' }],
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
  async function assertInert(f: Fixture) {
    const current = await durable(f.org)
    expect(current.runs.find((r) => r.id === f.run.id)).toMatchObject({
      status: 'RUNNING',
      phase: 'READY_TO_REDUCE',
      summary: null,
      rows: null,
      frozenContext: null,
      completedAt: null,
      coverage: {},
      uncertainties: [],
    })
    return current
  }
  async function databaseAfter(deadline: Date) {
    const end = Date.now() + 2500
    while (Date.now() < end) {
      const [row] = await db().$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (row && row.now > deadline) return
      await pause(10)
    }
    throw new Error('Den verkliga DB-deadlinen passerades inte')
  }
  async function deadline(f: Fixture) {
    const current = await db().fortnoxReadRun.findUniqueOrThrow({
      where: { id: f.run.id },
      select: { leaseUntil: true },
    })
    if (!current.leaseUntil) throw new Error('Aktuell DB-lease saknas')
    return current.leaseUntil
  }
  function observeAccumulator() {
    const original = economic.createLedgerAccumulator
    const seen = {
      adds: 0,
      finishes: 0,
      afterOverflowAdds: 0,
      overflow: false,
      firstError: undefined as unknown,
    }
    const spy = jest.spyOn(economic, 'createLedgerAccumulator').mockImplementation((cfg, base) => {
      const actual = original(cfg, base)
      return {
        add(item) {
          seen.adds++
          if (seen.overflow) seen.afterOverflowAdds++
          try {
            actual.add(item)
          } catch (error) {
            if (error instanceof economic.LedgerAmountOverflow) {
              seen.overflow = true
              seen.firstError = error
            }
            throw error
          }
        },
        finish() {
          seen.finishes++
          return actual.finish()
        },
      }
    })
    return { seen, spy }
  }
  async function proof(f: Fixture, expected: readonly ValidatedLedgerVoucher[]) {
    const saved = await durable(f.org),
      snapshot = saved.snapshots[0]
    if (
      !snapshot ||
      !record(snapshot.manifest) ||
      typeof snapshot.manifest.sourceDigest !== 'string'
    )
      throw new Error('Fryst källbevis saknas')
    const pages = f.pages.map((numbers, i) => {
      const entries = numbers.map((n) => ({
        key: key(n),
        digest: hash({ Year: 1, VoucherSeries: 'L', VoucherNumber: n }),
      }))
      const value = {
        page: i + 1,
        totalPages: expected.length ? f.pages.length : 0,
        totalResources: expected.length,
        itemCount: numbers.length,
        entries,
      }
      return { ...value, digest: hash(value) }
    })
    return {
      version: 1,
      organizationId: f.org,
      runId: f.run.id,
      sourceCaptureId: f.run.id,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.digest,
      sourceDigest: snapshot.manifest.sourceDigest,
      catalogDigest: hash(f.catalog),
      manifestDigest: hash({ version: 1, pages }),
      detailDigest: hash({ version: 1, items: expected }),
      manifestPageCount: pages.length,
      manifestItemsSeen: f.pages.reduce((n, p) => n + p.length, 0),
      voucherCount: expected.length,
      claimVersion: f.lease.claimVersion,
    }
  }
  it('handkedjan ger exakt920öre, fem proveniensrader och rätt varningsordning; fryst källa gäller efter liveändring och omstart', async () => {
    const base = await baseFixture(0, true),
      input = { ...INPUT, costAccounts: [5170, 5190] },
      cat = catalog(input)
    cat.accounts = [
      { number: 5190, active: null, balanceBroughtForwardOre: null },
      { number: 5170, active: true, balanceBroughtForwardOre: -125 },
    ]
    cat.dimensions = [
      { type: 'COST_CENTER', code: 'HUS' },
      { type: 'PROJECT', code: 'P' },
    ]
    cat.coverage = { costCenters: { ...ONE_COVERAGE }, projects: { ...ONE_COVERAGE } }
    await db().fortnoxDimensionMapping.createMany({
      data: [
        {
          organizationId: base.org,
          propertyId: base.as,
          dimensionType: 'COST_CENTER',
          code: 'HUS',
        },
        { organizationId: base.org, propertyId: base.ang, dimensionType: 'PROJECT', code: 'P' },
        {
          organizationId: base.org,
          propertyId: base.ost,
          dimensionType: 'COST_CENTER',
          code: 'MISSING',
        },
      ],
    })
    const f = await ready(
        base,
        HAND.map((h) => h.raw),
        { input, catalog: cat, pages: [[2, 1, 10], [], [10, 11]] },
      ),
      before = await durable(f.org)
    const expected: LedgerReadResult = {
      status: 'COMPLETE_WITH_UNCERTAINTY',
      reason: null,
      financialYear: YEAR,
      summary: {
        currency: 'SEK',
        totalOre: 920,
        byProperty: [
          { propertyId: f.as, propertyName: 'Ås', amountOre: 1000 },
          { propertyId: f.ang, propertyName: 'Äng', amountOre: -200 },
        ],
        unmappedDimensions: [{ dimensionType: 'COST_CENTER', code: 'X', amountOre: 70 }],
        unallocatedOre: 50,
        uncertainRemovedOre: 300,
        evenoExportOre: -200,
        balanceBroughtForwardOre: { '5170': -125, '5190': null },
        financialYearAccountingMethod: 'ACCRUAL',
      },
      coverage: {
        '/3/costcenters': ONE_COVERAGE,
        '/3/projects': ONE_COVERAGE,
        '/3/vouchers/sublist': { pages: 3, totalPages: 3, totalResources: 4, itemsSeen: 5 },
      },
      rows: [
        {
          voucher: key(1),
          row: 1,
          transactionDate: '2026-10-01',
          account: 5170,
          amountOre: 1000,
          bucket: 'PROPERTY',
          dimensionType: 'COST_CENTER',
          code: 'HUS',
          propertyId: f.as,
          evenoExport: false,
        },
        {
          voucher: key(10),
          row: 1,
          transactionDate: '2026-10-02',
          account: 5190,
          amountOre: -200,
          bucket: 'PROPERTY',
          dimensionType: 'PROJECT',
          code: 'P',
          propertyId: f.ang,
          evenoExport: true,
          evenoSource: { journalEntryId: f.journalId, sourceAccount: null, mappingRevision: -7 },
        },
        {
          voucher: key(10),
          row: 2,
          transactionDate: '2026-10-02',
          account: 5170,
          amountOre: 300,
          bucket: 'UNCERTAIN_REMOVED',
          dimensionType: null,
          code: null,
          propertyId: null,
          evenoExport: true,
          evenoSource: { journalEntryId: f.journalId, sourceAccount: 4010, mappingRevision: -7 },
        },
        {
          voucher: key(2),
          row: 1,
          transactionDate: '2026-10-03',
          account: 5170,
          amountOre: 50,
          bucket: 'UNALLOCATED',
          dimensionType: null,
          code: null,
          propertyId: null,
          evenoExport: false,
        },
        {
          voucher: key(2),
          row: 2,
          transactionDate: '2026-10-03',
          account: 5190,
          amountOre: 70,
          bucket: 'UNMAPPED',
          dimensionType: 'COST_CENTER',
          code: 'X',
          propertyId: null,
          evenoExport: false,
        },
      ],
      references: [
        { voucher: key(1), referenceType: '', referenceNumber: '7' },
        { voucher: key(10), referenceType: null, referenceNumber: null },
      ],
      uncertainties: [
        'Kostnadsstället MISSING är kopplat i Eveno men finns inte i Fortnox; kopplingen används inte.',
        'Verifikat 1|L|10 förekom flera gånger i listan och räknades en gång.',
        'Verifikat 1|L|10 rad 2 är markerad som borttagen i Fortnox; innebörden är inte belagd och raden ingår inte i summan.',
        'Verifikat 1|L|2: dimension finns bara på verifikatets huvud och har inte förts över till raden.',
        '1 Fortnox-dimension(er) saknar koppling till fastighet och redovisas som okopplade.',
        'En del av beloppet kommer från verifikat som Eveno själv har exporterat; lägg inte ihop det med Evenos egna siffror.',
        LIMITATION,
      ],
    }
    const first = await service().reduceReadyLedger(f.lease)
    expect(first).toStrictEqual({
      kind: 'REDUCED',
      result: expected,
      proof: await proof(
        f,
        HAND.map((h) => h.expected),
      ),
    })
    const legacy = new HandReader(f.pages)
    legacy.vouchers = HAND.map((h) => structuredClone(h.raw))
    legacy.costCenters = ['HUS']
    legacy.projects = [{ ProjectNumber: 'P', Description: 'Syntetiskt projekt' }]
    legacy.accounts = [
      { Number: 5170, Active: true, BalanceBroughtForward: -1.25 },
      { Number: 5190, Active: true },
    ]
    const legacyResult = await readLedger(legacy, 'synthetic-no-network', {
      expectedDatabaseNumber: 900001,
      financialYearId: 1,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      costAccounts: input.costAccounts,
      mappings: new Map([
        ['COST_CENTER:HUS', { propertyId: f.as, propertyName: 'Ås' }],
        ['COST_CENTER:MISSING', { propertyId: f.ost, propertyName: 'Öst' }],
        ['PROJECT:P', { propertyId: f.ang, propertyName: 'Äng' }],
      ]),
      evenoExported: new Set([key(10)]),
    })
    expect(
      enrichEvenoLedgerResult(
        legacyResult,
        new Map([
          [
            key(10),
            {
              journalEntryId: f.journalId,
              revision: -7,
              perMal: new Map([
                [5190, [4000, 4001]],
                [5170, [4010]],
              ]),
            },
          ],
        ]),
      ),
    ).toStrictEqual(expected)
    expect(await assertInert(f)).toStrictEqual(before)
    await db().property.update({ where: { id: f.as }, data: { name: 'ÄNDRAT LIVE' } })
    await db().fortnoxDimensionMapping.updateMany({
      where: { organizationId: f.org, code: 'HUS' },
      data: { propertyId: f.ost },
    })
    await db().fortnoxVoucherExport.update({
      where: { id: f.exportId },
      data: { draft: { kontomappning: { revision: 123 }, provenance: { lines: [] } } },
    })
    await service().release(f.lease)
    const restarted = service(),
      replay = await restarted.start(f.org, null, input),
      lease = await claim(f, restarted)
    expect(replay.id).toBe(f.run.id)
    expect(lease.claimVersion).toBe(f.lease.claimVersion + 1)
    expect(await restarted.reduceReadyLedger(lease)).toStrictEqual({
      kind: 'REDUCED',
      result: expected,
      proof: {
        ...(await proof(
          f,
          HAND.map((h) => h.expected),
        )),
        claimVersion: lease.claimVersion,
      },
    })
    await assertInert(f)
  })

  it('tomt manifest ger noll rörelse men en verklig manifestsida och exakt bokstavligt hashformat', async () => {
    const f = await fixture([]),
      result = await service().reduceReadyLedger(f.lease)
    const page = '{"entries":[],"itemCount":0,"page":1,"totalPages":0,"totalResources":0}'
    const manifestText =
      '{"pages":[{"digest":"' +
      bytesHash(page) +
      '","entries":[],"itemCount":0,"page":1,"totalPages":0,"totalResources":0}],"version":1}'
    expect(result).toStrictEqual({
      kind: 'REDUCED',
      proof: {
        ...(await proof(f, [])),
        manifestDigest: bytesHash(manifestText),
        detailDigest: bytesHash('{"items":[],"version":1}'),
      },
      result: {
        status: 'COMPLETE',
        reason: null,
        financialYear: YEAR,
        summary: {
          currency: 'SEK',
          totalOre: 0,
          byProperty: [],
          unmappedDimensions: [],
          unallocatedOre: 0,
          uncertainRemovedOre: 0,
          evenoExportOre: 0,
          balanceBroughtForwardOre: { '5170': null },
          financialYearAccountingMethod: 'ACCRUAL',
        },
        rows: [],
        references: [],
        uncertainties: [LIMITATION],
        coverage: { '/3/costcenters': EMPTY_COVERAGE, '/3/vouchers/sublist': EMPTY_COVERAGE },
      },
    })
    await assertInert(f)
  })

  it('en detaljs proof använder literalnormalformens bytes och behåller bara vald kontorad', async () => {
    const detail = { ...raw(1, 100), ReferenceNumber: null },
      f = await fixture([detail])
    const literal =
      '{"items":[{"date":"2026-10-01","headerDimensionPresent":false,"key":"1|L|1","reference":null,"rows":[{"account":5170,"costCenter":null,"creditOre":0,"debitOre":100,"index1":1,"project":null,"removed":false},{"account":2440,"costCenter":null,"creditOre":100,"debitOre":0,"index1":2,"project":null,"removed":false}]}],"version":1}'
    const result = await service().reduceReadyLedger(f.lease)
    expect(result.kind).toBe('REDUCED')
    if (result.kind !== 'REDUCED') throw new Error('Enkel handrörelse kunde inte reduceras')
    expect(result.proof).toStrictEqual({
      ...(await proof(f, [{ ...normalized(1, 100), reference: null }])),
      detailDigest: bytesHash(literal),
    })
    expect(result.result.summary.totalOre).toBe(100)
    expect(result.result.rows).toStrictEqual([
      {
        voucher: key(1),
        row: 1,
        transactionDate: '2026-10-01',
        account: 5170,
        amountOre: 100,
        bucket: 'UNALLOCATED',
        dimensionType: null,
        code: null,
        propertyId: null,
        evenoExport: false,
      },
    ])
    expect(result.result.references).toStrictEqual([])
    await assertInert(f)
  })

  it('extra projektcoverage utan projektmapping stannar i katalog/proof; fem signerade saldon summeras aldrig', async () => {
    const input = { ...INPUT, costAccounts: [5170, 5190, 5290, 5310, 5390] },
      cat = catalog(input)
    cat.accounts = [
      { number: 5390, active: null, balanceBroughtForwardOre: Number.MAX_SAFE_INTEGER },
      { number: 5310, active: true, balanceBroughtForwardOre: Number.MAX_SAFE_INTEGER },
      { number: 5290, active: null, balanceBroughtForwardOre: null },
      { number: 5190, active: true, balanceBroughtForwardOre: 0 },
      { number: 5170, active: null, balanceBroughtForwardOre: -125 },
    ]
    cat.coverage.projects = { ...ONE_COVERAGE }
    cat.dimensions = [{ type: 'PROJECT', code: 'EXTRA' }]
    cat.financialYear.accountingMethod = ''
    const f = await ready(await baseFixture(), [raw(1)], { input, catalog: cat }),
      before = await durable(f.org)
    const result = await service().reduceReadyLedger(f.lease)
    expect(result.kind).toBe('REDUCED')
    if (result.kind !== 'REDUCED') throw new Error('Individuellt giltiga saldon får inte summeras')
    expect(result.result.coverage).toStrictEqual({
      '/3/costcenters': EMPTY_COVERAGE,
      '/3/vouchers/sublist': ONE_COVERAGE,
    })
    expect(result.result.summary.balanceBroughtForwardOre).toStrictEqual({
      '5170': -125,
      '5190': 0,
      '5290': null,
      '5310': Number.MAX_SAFE_INTEGER,
      '5390': Number.MAX_SAFE_INTEGER,
    })
    expect(result.result.summary.totalOre).toBe(1)
    expect(result.result.summary.financialYearAccountingMethod).toBeNull()
    expect(result.proof.catalogDigest).toBe(hash(cat))
    expect(await durable(f.org)).toStrictEqual(before)
  })

  it('101 verkliga detaljer läses100+1+tomt i båda pass; PROJECT på configsida2 används och varje referens bevaras', async () => {
    const base = await baseFixture(100),
      cat = catalog()
    await db().fortnoxDimensionMapping.create({
      data: { organizationId: base.org, propertyId: base.ang, dimensionType: 'PROJECT', code: 'P' },
    })
    cat.dimensions = [
      ...Array.from({ length: 100 }, (_, i) => ({
        type: 'COST_CENTER' as const,
        code: `D${String(i).padStart(3, '0')}`,
      })),
      { type: 'PROJECT', code: 'P' },
    ]
    cat.coverage = {
      costCenters: { pages: 1, totalPages: 1, totalResources: 100, itemsSeen: 100 },
      projects: { ...ONE_COVERAGE },
    }
    const raws = Array.from({ length: 101 }, (_, i) => ({
      ...raw(i + 1),
      VoucherRows: [
        { Account: 5170, Debit: 0.01, Project: 'P' },
        { Account: 2440, Credit: 0.01 },
      ],
    }))
    const f = await ready(base, raws, { catalog: cat }),
      c = await controlled(),
      lengths: number[] = []
    c.hooks.after = async (params, value) => {
      if (detailRead(params) && Array.isArray(value)) lengths.push(value.length)
    }
    try {
      const result = await service(c.client).reduceReadyLedger(f.lease)
      expect(lengths).toStrictEqual([100, 1, 0, 100, 1, 0])
      expect(result.kind).toBe('REDUCED')
      if (result.kind !== 'REDUCED') throw new Error('101 giltiga detaljer gav inte resultat')
      const numbers = Array.from({ length: 101 }, (_, i) => i + 1).sort((a, b) =>
        key(a) < key(b) ? -1 : 1,
      )
      expect(result.result.summary).toStrictEqual({
        currency: 'SEK',
        totalOre: 101,
        byProperty: [{ propertyId: f.ang, propertyName: 'Äng', amountOre: 101 }],
        unmappedDimensions: [],
        unallocatedOre: 0,
        uncertainRemovedOre: 0,
        evenoExportOre: 0,
        balanceBroughtForwardOre: { '5170': null },
        financialYearAccountingMethod: 'ACCRUAL',
      })
      expect(result.result.rows).toStrictEqual(
        numbers.map((n) => ({
          voucher: key(n),
          row: 1,
          transactionDate: '2026-10-01',
          account: 5170,
          amountOre: 1,
          bucket: 'PROPERTY',
          dimensionType: 'PROJECT',
          code: 'P',
          propertyId: f.ang,
          evenoExport: false,
        })),
      )
      expect(result.result.references).toStrictEqual(
        numbers.map((n) => ({ voucher: key(n), referenceType: null, referenceNumber: `R${n}` })),
      )
      const expected = numbers.map((n) => ({
        ...normalized(n),
        rows: [nr(1, 5170, 1, 0, null, 'P'), nr(2, 2440, 0, 1)],
      }))
      expect(result.proof).toStrictEqual(await proof(f, expected))
      await assertInert(f)
    } finally {
      await c.client.$disconnect()
    }
  }, 45_000)

  it('B måste hasha just de verkligt återlästa items som bygger config, även efter ett grönt freeze-pass', async () => {
    const f = await ready(await baseFixture(1), [raw(1)]),
      before = await durable(f.org)
    const original = normalizedContext.readNormalizedContextPage
    let reads = 0,
      changed = false
    const spy = jest
      .spyOn(normalizedContext, 'readNormalizedContextPage')
      .mockImplementation(async (...args) => {
        const actual = await original(...args)
        if (args[2] === 'MAPPINGS') {
          reads++
          // E i freeze läser först; B läser samma verkliga sida igen. Injektionen
          // ligger EFTER sidvalideringen och behåller dess digest för att isolera
          // den nya konsumentens fulla sourceDigest över de faktiskt använda items.
          if (reads === 2) {
            const items = CheckpointContextSchema.shape.mappings.parse(actual.items)
            changed = true
            return {
              ...actual,
              items: items.map((item) => ({ ...item, propertyName: 'ANNAN Å A\u030A' })),
            }
          }
        }
        return actual
      })
    try {
      await expect(service().reduceReadyLedger(f.lease)).rejects.toBeInstanceOf(ConflictException)
      expect(changed).toBe(true)
      expect(reads).toBe(2)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      spy.mockRestore()
    }
  })

  it('faktiskt manifestsidantal jämförs före payloadloopen, inte först efter onödiga sidfrågor', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      c = await controlled()
    let countSeen = false,
      payloadReads = 0
    c.hooks.transform = (params, value) => {
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'count' && !countSeen) {
        expect(value).toBe(1)
        countSeen = true
        return 2 // Testets returinjektion; den riktiga databasen har fortfarande1sida.
      }
      if (params.model === 'FortnoxReadManifestPage' && params.action === 'findUnique')
        payloadReads++
      return value
    }
    try {
      await expect(service(c.client).reduceReadyLedger(f.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(countSeen).toBe(true)
      expect(payloadReads).toBe(0)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it.each(['page-digest', 'checkpoint-scope', 'checkpoint-manifest-digest'] as const)(
    'verklig manifestläsning avvisar %s före ekonomiskt add',
    async (mode) => {
      const f = await fixture(),
        before = await durable(f.org),
        c = await controlled(),
        observed = observeAccumulator()
      let injected = false
      c.hooks.transform = (params, value) => {
        if (
          mode === 'page-digest' &&
          params.model === 'FortnoxReadManifestPage' &&
          params.action === 'findUnique' &&
          record(value)
        ) {
          injected = true
          return { ...value, digest: '0'.repeat(64) }
        }
        if (
          mode !== 'page-digest' &&
          params.model === 'FortnoxReadVoucherCheckpoint' &&
          params.action === 'findMany' &&
          Array.isArray(value)
        ) {
          injected = true
          return value.map((row) =>
            record(row)
              ? {
                  ...row,
                  ...(mode === 'checkpoint-scope'
                    ? { organizationId: randomUUID() }
                    : { manifestDigest: '0'.repeat(64) }),
                }
              : row,
          )
        }
        return value
      }
      try {
        await expect(service(c.client).reduceReadyLedger(f.lease)).rejects.toBeInstanceOf(
          ConflictException,
        )
        expect(injected).toBe(true)
        expect(observed.seen.adds).toBe(0)
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        observed.spy.mockRestore()
        await c.client.$disconnect()
      }
    },
  )

  it.each(['missing', 'duplicate', 'out-of-order', 'coherent-different'] as const)(
    'pass2 %s efter riktig SELECT kan inte återanvända pass1:s gröna proof',
    async (mode) => {
      const f = await fixture([raw(1), raw(10), raw(2)]),
        before = await durable(f.org),
        c = await controlled()
      let reads = 0,
        injected = false
      c.hooks.transform = (params, value) => {
        if (!detailRead(params)) return value
        reads++
        if (reads !== 3 || !Array.isArray(value)) return value // pass1:s sida+tomsvans först.
        expect(value).toHaveLength(3)
        injected = true
        if (mode === 'missing') return [value[0], value[2]] // Mellannyckeln kan inte hämtas igen efter sista cursor.
        if (mode === 'duplicate') return [...value, value[2]]
        if (mode === 'out-of-order') return [value[1], value[0], value[2]]
        return value.map((row, i) => {
          if (i !== 0 || !record(row) || !record(row.validated)) return row
          const changed = {
            ...row.validated,
            reference: { type: '', number: 'NYTT KOHerent UNDERLAG' },
          }
          return { ...row, validated: changed, detailDigest: hash(changed) }
        })
      }
      try {
        await expect(service(c.client).reduceReadyLedger(f.lease)).rejects.toBeInstanceOf(
          ConflictException,
        )
        expect(injected).toBe(true)
        expect(reads).toBeGreaterThanOrEqual(3)
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it.each(['corrupt', 'sql', 'expired', 'only-overflow'] as const)(
    'verklig tidig pass2-overflow lämnar inte före sista101-detaljsidan: %s',
    async (mode) => {
      const amounts = (n: number) => (n === 1 ? 9007199254740990 : n === 10 ? 2 : 0)
      const f = await fixture(Array.from({ length: 101 }, (_, i) => raw(i + 1, amounts(i + 1)))),
        c = await controlled()
      const owner = mode === 'expired' ? new ShortLeaseService(c.client) : service(c.client)
      let lease = f.lease
      if (mode === 'expired') {
        await service().release(lease)
        lease = await claim(f, owner)
      }
      const before = await durable(f.org),
        observed = observeAccumulator()
      let reads = 0,
        lateRead = false,
        finalCount = false
      c.hooks.after = async (params, value) => {
        if (detailRead(params)) {
          reads++
          if (reads === 5) {
            expect(Array.isArray(value)).toBe(true)
            expect(value).toHaveLength(1)
            expect(observed.seen.overflow).toBe(true)
            expect(observed.seen.firstError).toBeInstanceOf(economic.LedgerAmountOverflow)
            lateRead = true
            if (mode === 'sql') await db().$queryRaw`SELECT 1/0`
            if (mode === 'expired') await databaseAfter(await deadline(f))
          }
        }
        if (
          reads === 6 &&
          params.model === 'FortnoxReadVoucherCheckpoint' &&
          params.action === 'count'
        )
          finalCount = true
      }
      c.hooks.transform = (params, value) => {
        if (mode === 'corrupt' && detailRead(params) && reads === 5 && Array.isArray(value))
          return value.map((row) => (record(row) ? { ...row, validated: null } : row))
        return value
      }
      try {
        const pending = owner.reduceReadyLedger(lease)
        if (mode === 'sql')
          await expect(pending).rejects.toMatchObject({ code: 'P2010', meta: { code: '22012' } })
        else if (mode === 'expired') await expect(pending).rejects.toThrow(EXPIRED)
        else if (mode === 'corrupt') await expect(pending).rejects.toThrow(INVALID_CONTEXT)
        else {
          const numbers = Array.from({ length: 101 }, (_, i) => i + 1).sort((a, b) =>
            key(a) < key(b) ? -1 : 1,
          )
          const expected = await proof(
            f,
            numbers.map((n) => normalized(n, amounts(n))),
          )
          expect(await pending).toStrictEqual({
            kind: 'FAILED',
            code: 'AMOUNT_OVERFLOW',
            proof: expected,
          })
          expect(reads).toBe(6)
          expect(finalCount).toBe(true)
        }
        expect(lateRead).toBe(true)
        expect(observed.seen.adds).toBe(2)
        expect(observed.seen.afterOverflowAdds).toBe(0)
        expect(observed.seen.finishes).toBe(0)
        const after = await durable(f.org)
        expect(after.details).toStrictEqual(before.details)
        expect(after.pages).toStrictEqual(before.pages)
        expect(after.snapshots).toStrictEqual(before.snapshots)
        expect(after.contextPages).toStrictEqual(before.contextPages)
        if (mode === 'corrupt')
          expect(after.runs[0]).toMatchObject({
            status: 'FAILED',
            reason: INVALID_CONTEXT,
            summary: null,
            rows: null,
            claimToken: null,
            leaseUntil: null,
          })
        else await assertInert(f)
      } finally {
        observed.spy.mockRestore()
        await c.client.$disconnect()
      }
    },
    45_000,
  )

  it('okänt synkront add-fel med samma feltext propageras identiskt och blir aldrig AMOUNT_OVERFLOW', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      original = economic.createLedgerAccumulator
    const failure = new Error('Beloppssumman ligger utanför säkert talområde')
    let actualAdd = false,
      finished = false
    const spy = jest.spyOn(economic, 'createLedgerAccumulator').mockImplementation((cfg, base) => {
      const actual = original(cfg, base)
      return {
        add(item) {
          actual.add(item)
          actualAdd = true
          throw failure
        },
        finish() {
          finished = true
          return actual.finish()
        },
      }
    })
    try {
      await expect(service().reduceReadyLedger(f.lease)).rejects.toBe(failure)
      expect(actualAdd).toBe(true)
      expect(finished).toBe(false)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      spy.mockRestore()
    }
  })

  it('fel fas, gammal fence och främmande org nekas före kontextsidor; den andra organisationens källa förblir orörd', async () => {
    const f = await fixture(),
      other = await fixture([raw(7)])
    const notReady = await ready(await baseFixture(), [raw(1)], { leaveDetails: true })
    const beforeOther = await durable(other.org),
      beforeNotReady = await durable(notReady.org),
      c = await controlled()
    let contextReads = 0
    c.hooks.after = async (params) => {
      if (contextPageRead(params)) contextReads++
    }
    try {
      const owner = service(c.client)
      await expect(owner.reduceReadyLedger(notReady.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      await expect(
        owner.reduceReadyLedger({ ...f.lease, organizationId: other.org }),
      ).rejects.toBeInstanceOf(ConflictException)
      await service().release(f.lease)
      const active = await claim(f)
      await expect(owner.reduceReadyLedger(f.lease)).rejects.toThrow(EXPIRED)
      expect(contextReads).toBe(0)
      expect(await durable(other.org)).toStrictEqual(beforeOther)
      expect(await durable(notReady.org)).toStrictEqual(beforeNotReady)
      expect((await owner.reduceReadyLedger(active)).kind).toBe('REDUCED')
      await assertInert(f)
    } finally {
      await c.client.$disconnect()
    }
  })

  it.each(['after-pass1', 'after-finish'] as const)(
    'faktiskt leaseövertagande %s nekar gammalt arbete och låter ny ägare räkna hela resultatet',
    async (position) => {
      const f = await fixture(),
        before = await durable(f.org),
        c = await controlled()
      const reached = deferred(),
        release = deferred(),
        actualFinish = reduction.finishReducedLedger
      let reads = 0,
        finished = false,
        paused = false
      const finishSpy = jest
        .spyOn(reduction, 'finishReducedLedger')
        .mockImplementation((...args) => {
          const result = actualFinish(...args)
          finished = true
          return result
        })
      c.hooks.after = async (params) => {
        if (detailRead(params)) reads++
      }
      c.hooks.before = async (params) => {
        const atPosition = position === 'after-pass1' ? reads === 2 : finished
        if (!paused && atPosition && connectionLock(params)) {
          paused = true
          reached.resolve()
          await release.promise
        }
      }
      const pending = service(c.client).reduceReadyLedger(f.lease)
      try {
        await barrier(reached.promise, pending)
        expect(reads).toBe(position === 'after-pass1' ? 2 : 4)
        expect(finished).toBe(position === 'after-finish')
        const nextOwner = service()
        await nextOwner.release(f.lease)
        const nextLease = await claim(f, nextOwner)
        expect(nextLease.claimVersion).toBe(f.lease.claimVersion + 1)
        release.resolve()
        await expect(pending).rejects.toThrow(EXPIRED)
        expect(paused).toBe(true)
        const after = await assertInert(f)
        expect(after.details).toStrictEqual(before.details)
        expect(after.pages).toStrictEqual(before.pages)
        expect(after.snapshots).toStrictEqual(before.snapshots)
        expect(after.contextPages).toStrictEqual(before.contextPages)
        const retried = await nextOwner.reduceReadyLedger(nextLease)
        expect(retried.kind).toBe('REDUCED')
        if (retried.kind !== 'REDUCED')
          throw new Error('Ny giltig ägare fick inget fullständigt resultat')
        expect(retried.result.summary.totalOre).toBe(1)
        expect(retried.result.rows).toHaveLength(1)
        expect(retried.proof).toStrictEqual({
          ...(await proof(f, [normalized(1)])),
          claimVersion: nextLease.claimVersion,
        })
        await assertInert(f)
      } finally {
        release.resolve()
        await Promise.allSettled([pending])
        finishSpy.mockRestore()
        await c.client.$disconnect()
      }
    },
  )

  it('verklig DB-expiry efter call-through finish och proveniens får inget lyckat slutkvitto', async () => {
    const f = await fixture(),
      c = await controlled(),
      actualFinish = reduction.finishReducedLedger
    await service().release(f.lease)
    const owner = new ShortLeaseService(c.client),
      lease = await claim(f, owner)
    let finished = false,
      afterFinishFence = false,
      expiredAt: Date | undefined
    const finishSpy = jest.spyOn(reduction, 'finishReducedLedger').mockImplementation((...args) => {
      const result = actualFinish(...args)
      finished = true
      return result
    })
    c.hooks.before = async (params) => {
      if (finished && !afterFinishFence && connectionLock(params)) {
        afterFinishFence = true
        expiredAt = await deadline(f) // Senaste verkliga renewal, aldrig callerns äldre deadline.
        await databaseAfter(expiredAt)
      }
    }
    try {
      await expect(owner.reduceReadyLedger(lease)).rejects.toThrow(EXPIRED)
      expect(finished).toBe(true)
      expect(afterFinishFence).toBe(true)
      expect(expiredAt).toBeInstanceOf(Date)
      const saved = await assertInert(f)
      expect(saved.runs[0]?.leaseUntil).toStrictEqual(expiredAt)
    } finally {
      finishSpy.mockRestore()
      await c.client.$disconnect()
    }
  })

  it('anslutningsbyte efter färdig beräkning fångas av slutets nya DB-fence utan publicerat resultat', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      c = await controlled()
    const actualFinish = reduction.finishReducedLedger
    let finished = false,
      changed = false
    const finishSpy = jest.spyOn(reduction, 'finishReducedLedger').mockImplementation((...args) => {
      const result = actualFinish(...args)
      finished = true
      return result
    })
    c.hooks.before = async (params) => {
      if (finished && !changed && connectionLock(params)) {
        // Före själva låsfrågan: separat klient kan ändra anslutningen utan
        // att testet egentligen väntar på en blockerande egen transaktion.
        await db().fortnoxConnection.update({
          where: { id: f.connection.id },
          data: { generation: { increment: 1 } },
        })
        changed = true
      }
    }
    try {
      await expect(service(c.client).reduceReadyLedger(f.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(finished).toBe(true)
      expect(changed).toBe(true)
      const saved = await durable(f.org)
      expect(saved.runs[0]).toMatchObject({
        status: 'FAILED',
        summary: null,
        rows: null,
        claimToken: null,
        leaseUntil: null,
      })
      expect(saved.details).toStrictEqual(before.details)
      expect(saved.pages).toStrictEqual(before.pages)
      expect(saved.snapshots).toStrictEqual(before.snapshots)
      expect(saved.contextPages).toStrictEqual(before.contextPages)
    } finally {
      finishSpy.mockRestore()
      await c.client.$disconnect()
    }
  })

  it('avbrott efter riktig SELECT och förlorad färdig metodretur lämnar ingen resultatskrivning; ny klient räknar om endast frysta tabeller', async () => {
    const f = await fixture(),
      before = await durable(f.org),
      c = await controlled()
    const interrupted = new Error('Syntetiskt avbrott efter verklig detaljfråga')
    let actualRead = false
    c.hooks.after = async (params, value) => {
      if (detailRead(params) && !actualRead) {
        expect(value).toHaveLength(1)
        actualRead = true
        throw interrupted
      }
    }
    try {
      await expect(service(c.client).reduceReadyLedger(f.lease)).rejects.toBe(interrupted)
      expect(actualRead).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }

    const logged = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
      log: [{ emit: 'event', level: 'query' }],
    })
    const sql: string[] = []
    logged.$on('query', (event) => {
      sql.push(event.query)
    })
    const dependency = Object.assign(logged, {
      onModuleInit: async () => {
        await logged.$connect()
      },
      onModuleDestroy: async () => {
        await logged.$disconnect()
      },
    })
    const owner = new FortnoxReadSourceRunService(dependency),
      returned: reduction.ReadyLedgerReduction[] = []
    const lost = new Error('Syntetiskt tappat färdigt metodkvitto')
    try {
      await logged.$connect()
      await expect(
        (async () => {
          returned.push(await owner.reduceReadyLedger(f.lease))
          throw lost // Metoden hann faktiskt returnera, men anroparen får inget kvitto.
        })(),
      ).rejects.toBe(lost)
      expect(returned).toHaveLength(1)
      expect(
        sql.some(
          (query) =>
            query.includes('"FortnoxReadVoucherCheckpoint"') && query.includes('"validated"'),
        ),
      ).toBe(true)
      for (const table of [
        'FortnoxDimensionMapping',
        'Property',
        'JournalEntry',
        'FortnoxVoucherExport',
      ])
        expect(sql.some((query) => query.includes(`"${table}"`))).toBe(false)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await logged.$disconnect()
    }
    const complete = returned[0]
    if (!complete || complete.kind !== 'REDUCED')
      throw new Error('Den förlorade returen var inte ett fullständigt resultat')
    const restarted = service()
    await restarted.release(f.lease)
    const nextLease = await claim(f, restarted)
    expect(await restarted.reduceReadyLedger(nextLease)).toStrictEqual({
      ...complete,
      proof: { ...complete.proof, claimVersion: nextLease.claimVersion },
    })
    await assertInert(f)
  })

  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
    expect(await prisma.$queryRaw`SELECT current_database() AS name`).toStrictEqual([
      { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
    ])
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  afterAll(async () => {
    if (!prisma) return
    try {
      for (const org of orgs)
        expect((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).name).toBe(
          `synthetic-v2-reducer-${org}`,
        )
      await prisma.fortnoxVoucherExport.deleteMany({ where: { id: { in: [...exports] } } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntryId: { in: [...journals] } } })
      await prisma.journalEntry.deleteMany({ where: { id: { in: [...journals] } } })
      await prisma.account.deleteMany({ where: { id: { in: [...accounts] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [...orgs] } } })
      expect(await prisma.organization.count({ where: { id: { in: [...orgs] } } })).toBe(0)
    } finally {
      await prisma.$disconnect()
      prisma = undefined
    }
  })
})
