/**
 * Beteendebaslinje för optimering av checkpointtransporten. Riktig PostgreSQL,
 * egna syntetiska organisationer och inga provideranrop. Sparade JSON-fält
 * felinjiceras först efter giltig claim och ett lyckat, uppvärmande nextStep.
 * Proven kräver aktuella DB-värden; de låser inte antal frågor eller ORM-form.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient, type FortnoxReadRun } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import {
  FortnoxReadCheckpointService,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint.service'
import type { FortnoxVoucher } from './fortnox.types'

const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const INVALID_CONTEXT = 'Sparat läsunderlag är ogiltigt; starta en ny läsning.'

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Checkpointfärskhetsprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error(
      'Checkpointfärskhetsprovet tillåter bara lokal *_test eller CI:s lokala eken_dev',
    )
  }
  url.searchParams.set('connection_limit', '2')
  return url.toString()
}

function catalog() {
  return {
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
    coverage: {
      costCenters: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 },
    },
  }
}

function page() {
  return {
    MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 1 },
    Vouchers: [{ Year: 1, VoucherSeries: 'L', VoucherNumber: 1 }],
  }
}

function detail(amount = 10.05): FortnoxVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: 1,
    TransactionDate: '2026-10-01',
    VoucherRows: [
      { Account: 5170, Debit: amount },
      { Account: 2440, Credit: amount },
    ],
  }
}

describe('Fortnox-checkpointens färskhet och publika returvärden mot riktig PostgreSQL', () => {
  let prisma: PrismaClient | undefined
  const organizations: string[] = []

  function db(): PrismaClient {
    if (!prisma) throw new Error('PostgreSQL-fixturen har inte startats')
    return prisma
  }

  function service(): FortnoxReadCheckpointService {
    return new FortnoxReadCheckpointService(db() as unknown as PrismaService)
  }

  async function fixture() {
    const organizationId = randomUUID()
    await db().organization.create({
      data: {
        id: organizationId,
        name: `synthetic-checkpoint-freshness-${organizationId}`,
        email: `${organizationId}@example.invalid`,
        street: 'Syntetisk testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    organizations.push(organizationId)
    await db().fortnoxConnection.create({
      data: { organizationId, status: 'ACTIVE', fortnoxDatabaseNumber: 900001 },
    })
    return organizationId
  }

  async function savedState(runId: string) {
    const [run, pages, vouchers] = await Promise.all([
      db().fortnoxReadRun.findUniqueOrThrow({ where: { id: runId } }),
      db().fortnoxReadManifestPage.findMany({ where: { runId }, orderBy: { page: 'asc' } }),
      db().fortnoxReadVoucherCheckpoint.findMany({ where: { runId }, orderBy: { key: 'asc' } }),
    ])
    return { run, pages, vouchers }
  }

  async function expectExactSavedReturn(returned: FortnoxReadRun) {
    const persisted = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: returned.id } })
    expect(returned).toStrictEqual(persisted)
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })
    await prisma.$connect()
  })

  afterAll(async () => {
    if (!prisma) return
    const failures: unknown[] = []
    for (const id of organizations) {
      try {
        await prisma.organization.delete({ where: { id } })
      } catch (error) {
        failures.push(error)
      }
    }
    await prisma.$disconnect()
    if (failures.length)
      throw new AggregateError(
        failures,
        'Kunde inte städa checkpointfärskhetsprovets egna fixturer',
      )
  })

  it('KANARIEFÅGEL: använder den uttryckliga isolerade PostgreSQL-databasen utan skip', async () => {
    const expected = decodeURIComponent(new URL(isolatedDatabaseUrl()).pathname.slice(1))
    const rows = await db().$queryRaw<Array<{ database: string }>>(
      Prisma.sql`SELECT current_database() AS database`,
    )
    expect(rows).toStrictEqual([{ database: expected }])
  })

  it.each([
    { field: 'context', instance: 'samma' },
    { field: 'context', instance: 'ny' },
    { field: 'catalog', instance: 'samma' },
    { field: 'catalog', instance: 'ny' },
  ] as const)(
    '$field ändrad efter varm claim stoppas i $instance tjänsteinstans',
    async ({ field, instance }) => {
      // Egen run per kombination: ett föregående terminalstopp får inte hjälpa nästa fall.
      const organizationId = await fixture()
      const checkpoints = service()
      const run = await checkpoints.start(organizationId, null, INPUT)
      const lease = await checkpoints.claim(organizationId, run.id)
      if (!lease) throw new Error('Fixturens första claim saknas')
      await checkpoints.commitCatalog(lease, catalog())
      await expect(checkpoints.nextStep(lease)).resolves.toStrictEqual({
        phase: 'MANIFEST',
        page: 1,
      })
      const before = await savedState(run.id)

      if (field === 'context') {
        await db().$executeRaw(Prisma.sql`
        UPDATE "FortnoxReadRun"
        SET "frozenContext" = jsonb_set("frozenContext", '{input,periodTo}', '"2026-10-30"'::jsonb, false)
        WHERE "id" = ${run.id}
      `)
      } else {
        await db().$executeRaw(Prisma.sql`
        UPDATE "FortnoxReadRun"
        SET "catalog" = jsonb_set("catalog", '{accounts,0,active}', 'false'::jsonb, false)
        WHERE "id" = ${run.id}
      `)
      }
      const injected = await savedState(run.id)
      expect(injected.run).toMatchObject({
        requestHash: before.run.requestHash,
        claimVersion: before.run.claimVersion,
        claimToken: before.run.claimToken,
        leaseUntil: before.run.leaseUntil,
        checkpointUpdatedAt: before.run.checkpointUpdatedAt,
        status: 'RUNNING',
      })
      if (field === 'context') {
        expect(injected.run.frozenContext).toMatchObject({ input: { periodTo: '2026-10-30' } })
        expect(injected.run.catalog).toStrictEqual(before.run.catalog)
      } else {
        expect(injected.run.catalog).toMatchObject({ accounts: [{ number: 5170, active: false }] })
        expect(injected.run.frozenContext).toStrictEqual(before.run.frozenContext)
      }

      const current = instance === 'samma' ? checkpoints : service()
      const attempt = current.commitVoucherPage(lease, page())
      await expect(attempt).rejects.toBeInstanceOf(ConflictException)
      await expect(attempt).rejects.toThrow(INVALID_CONTEXT)
      const after = await savedState(run.id)
      expect(after.run).toMatchObject({
        status: 'FAILED',
        reason: INVALID_CONTEXT,
        phase: 'MANIFEST',
        nextManifestPage: 1,
        summary: null,
        rows: null,
        claimToken: null,
        leaseUntil: null,
      })
      expect(after.run.completedAt).toBeInstanceOf(Date)
      expect(after.run.frozenContext).toStrictEqual(injected.run.frozenContext)
      expect(after.run.catalog).toStrictEqual(injected.run.catalog)
      expect(after.pages).toStrictEqual(before.pages)
      expect(after.vouchers).toStrictEqual(before.vouchers)
      expect(after.pages).toStrictEqual([])
      expect(after.vouchers).toStrictEqual([])
    },
  )

  it('start och varje commit återlämnar exakt lagrad run, även vid terminal konflikt', async () => {
    const organizationId = await fixture()
    const checkpoints = service()
    const run = await checkpoints.start(organizationId, null, INPUT)
    await expectExactSavedReturn(run)
    expect(run).toMatchObject({ status: 'RUNNING', phase: 'CATALOG', catalog: null })
    const lease = await checkpoints.claim(organizationId, run.id)
    if (!lease) throw new Error('Fixturens första claim saknas')

    const withCatalog = await checkpoints.commitCatalog(lease, catalog())
    await expectExactSavedReturn(withCatalog)
    expect(withCatalog).toMatchObject({ status: 'RUNNING', phase: 'MANIFEST', nextManifestPage: 1 })
    expect(withCatalog.catalog).toStrictEqual(catalog())
    expect(withCatalog.frozenContext).toStrictEqual(run.frozenContext)

    const withPage = await checkpoints.commitVoucherPage(lease, page())
    await expectExactSavedReturn(withPage)
    expect(withPage).toMatchObject({ status: 'RUNNING', phase: 'DETAILS', nextManifestPage: 2 })
    const ready = await checkpoints.commitVoucherDetail(lease, '1|L|1', detail())
    await expectExactSavedReturn(ready)
    expect(ready).toMatchObject({
      status: 'RUNNING',
      phase: 'READY_TO_REDUCE',
      completedAt: null,
      reason: null,
      summary: null,
      rows: null,
    })
    const savedReady = await savedState(run.id)

    const failed = await checkpoints.commitVoucherDetail(lease, '1|L|1', detail(20.05))
    await expectExactSavedReturn(failed)
    expect(failed).toMatchObject({
      status: 'PARTIAL',
      reason: 'Verifikationsdetaljen är ogiltig eller ändrades under läsningen.',
      phase: 'READY_TO_REDUCE',
      nextManifestPage: 2,
      claimToken: null,
      leaseUntil: null,
      summary: null,
      rows: null,
    })
    expect(failed.completedAt).toBeInstanceOf(Date)
    const savedFailed = await savedState(run.id)
    expect(savedFailed.pages).toStrictEqual(savedReady.pages)
    expect(savedFailed.vouchers).toStrictEqual(savedReady.vouchers)
  })
})
