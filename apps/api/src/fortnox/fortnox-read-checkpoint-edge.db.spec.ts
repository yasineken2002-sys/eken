/**
 * Oberoende regressionsprov för checkpointgranskningens lagringsgränser.
 * Riktig lokal PostgreSQL, syntetiska organisationer och ingen nät-/providerport.
 * Kompletterar huvudsviten utan att återprova dess claims och normalflöden.
 */
import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
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

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Checkpointgränsprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error('Checkpointgränsprovet tillåter bara lokal *_test eller CI:s lokala eken_dev')
  }
  url.searchParams.set('connection_limit', '4')
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
    dimensions: [{ type: 'COST_CENTER', code: 'A' }],
    coverage: {
      costCenters: { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 },
    },
  }
}

function page(number: number) {
  return {
    MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 1 },
    Vouchers: [{ Year: 1, VoucherSeries: 'L', VoucherNumber: number }],
  }
}

function detail(number: number): FortnoxVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: number,
    TransactionDate: '2026-10-01',
    VoucherRows: [
      { Account: 2440, Credit: 10.05 },
      { Account: 5170, Debit: 10.05 },
    ],
  }
}

describe('Fortnox-checkpointens gränsfall mot riktig PostgreSQL', () => {
  let prisma: PrismaClient | undefined
  const organizations: string[] = []

  function db(): PrismaClient {
    if (!prisma) throw new Error('PostgreSQL-fixturen har inte startats')
    return prisma
  }

  async function started(projectMapping = false) {
    const organizationId = randomUUID()
    await db().organization.create({
      data: {
        id: organizationId,
        name: `synthetic-checkpoint-edge-${organizationId}`,
        email: `${organizationId}@example.invalid`,
        street: 'Syntetisk testgata 1',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    organizations.push(organizationId)
    await db().fortnoxConnection.create({
      data: { organizationId, status: 'ACTIVE', fortnoxDatabaseNumber: 900001 },
    })
    if (projectMapping) {
      const property = await db().property.create({
        data: {
          organizationId,
          name: 'Syntetisk projektfastighet',
          propertyDesignation: `TEST ${organizationId}`,
          type: 'RESIDENTIAL',
          street: 'Syntetisk testgata 1',
          postalCode: '11111',
          city: 'Teststad',
          totalArea: '100.00',
        },
      })
      await db().fortnoxDimensionMapping.create({
        data: { organizationId, propertyId: property.id, dimensionType: 'PROJECT', code: 'P1' },
      })
    }
    const checkpoints = new FortnoxReadCheckpointService(db() as unknown as PrismaService)
    const run = await checkpoints.start(organizationId, null, INPUT)
    const lease = await checkpoints.claim(organizationId, run.id)
    if (!lease) throw new Error('Fixturens första claim saknas')
    return { organizationId, checkpoints, run, lease }
  }

  async function savedState(runId: string) {
    const [run, pages, vouchers] = await Promise.all([
      db().fortnoxReadRun.findUniqueOrThrow({ where: { id: runId } }),
      db().fortnoxReadManifestPage.findMany({ where: { runId }, orderBy: { page: 'asc' } }),
      db().fortnoxReadVoucherCheckpoint.findMany({ where: { runId }, orderBy: { key: 'asc' } }),
    ])
    return { run, pages, vouchers }
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
      throw new AggregateError(failures, 'Kunde inte städa checkpointgränsprovets egna fixturer')
  })

  it('KANARIEFÅGEL: använder den uttryckliga isolerade PostgreSQL-databasen utan skip', async () => {
    const expected = decodeURIComponent(new URL(isolatedDatabaseUrl()).pathname.slice(1))
    const rows = await db().$queryRaw<Array<{ database: string }>>(
      Prisma.sql`SELECT current_database() AS database`,
    )
    expect(rows).toStrictEqual([{ database: expected }])
  })

  it('1e21 får inte skapa manifest eller checkpoint som egen återläsning sedan skulle neka', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    // Det gamla voucherKey-villkoret godtar heltalet men String ger exponentform.
    expect(Number.isInteger(1e21)).toBe(true)
    expect(String(1e21)).toBe('1e+21')
    await expect(f.checkpoints.commitVoucherPage(f.lease, page(1e21))).resolves.toMatchObject({
      status: 'PARTIAL',
      phase: 'MANIFEST',
      nextManifestPage: 1,
    })
    const saved = await savedState(f.run.id)
    expect(saved.pages).toStrictEqual([])
    expect(saved.vouchers).toStrictEqual([])
    expect(saved.run).toMatchObject({ summary: null, rows: null, claimToken: null })
    expect(saved.run.completedAt).toBeInstanceOf(Date)
    await expect(f.checkpoints.claim(f.organizationId, f.run.id)).resolves.toBeNull()
  })

  it('detaljproducenten nekar exponentnyckeln även om ett äldre manifest redan är korrupt', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.commitVoucherPage(f.lease, page(1))
    // Avsiktlig DB-felinjektion: prövar detaljgrinden oberoende av sidgrinden.
    await db().fortnoxReadVoucherCheckpoint.update({
      where: { runId_key: { runId: f.run.id, key: '1|L|1' } },
      data: { key: '1|L|1e+21' },
    })
    const before = await savedState(f.run.id)
    await expect(
      f.checkpoints.commitVoucherDetail(f.lease, '1|L|1e+21', detail(1e21)),
    ).resolves.toMatchObject({ status: 'PARTIAL', phase: 'DETAILS' })
    const after = await savedState(f.run.id)
    expect(after.pages).toStrictEqual(before.pages)
    expect(after.vouchers).toStrictEqual(before.vouchers)
    expect(after.vouchers[0]).toMatchObject({
      detailDigest: null,
      validated: null,
      observedAt: null,
    })
    expect(after.run).toMatchObject({ summary: null, rows: null, claimToken: null })
    await expect(f.checkpoints.readValidatedPage(f.lease)).rejects.toBeInstanceOf(ConflictException)
  })

  it.each([
    {
      name: 'icke-tom dimension trots totalPages noll',
      input: () => ({
        ...catalog(),
        coverage: { costCenters: { pages: 1, totalPages: 0, totalResources: 1, itemsSeen: 1 } },
      }),
    },
    {
      name: 'tom dimensionskod trots i övrigt konsekventa antal',
      input: () => ({ ...catalog(), dimensions: [{ type: 'COST_CENTER', code: '' }] }),
    },
  ])('nekar katalog med $name före kataloglagring', async ({ input }) => {
    const f = await started()
    await expect(f.checkpoints.commitCatalog(f.lease, input())).resolves.toMatchObject({
      status: 'PARTIAL',
      phase: 'CATALOG',
      catalog: null,
    })
    const saved = await savedState(f.run.id)
    expect(saved.pages).toStrictEqual([])
    expect(saved.vouchers).toStrictEqual([])
    expect(saved.run).toMatchObject({
      financialYearStart: null,
      financialYearEnd: null,
      summary: null,
      rows: null,
      claimToken: null,
    })
    await expect(f.checkpoints.claim(f.organizationId, f.run.id)).resolves.toBeNull()
  })

  it('fryst projektkoppling kräver projektläsning men en verifierad tom projektlista är giltig', async () => {
    const missing = await started(true)
    expect(missing.run.frozenContext).toMatchObject({
      mappings: [{ type: 'PROJECT', code: 'P1' }],
    })
    await expect(
      missing.checkpoints.commitCatalog(missing.lease, catalog()),
    ).resolves.toMatchObject({
      status: 'PARTIAL',
      catalog: null,
      phase: 'CATALOG',
    })
    expect((await savedState(missing.run.id)).run.catalog).toBeNull()

    const observedEmpty = await started(true)
    const verified = catalog()
    await expect(
      observedEmpty.checkpoints.commitCatalog(observedEmpty.lease, {
        ...verified,
        coverage: {
          ...verified.coverage,
          projects: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 },
        },
      }),
    ).resolves.toMatchObject({ status: 'RUNNING', phase: 'MANIFEST' })
    await expect(observedEmpty.checkpoints.nextStep(observedEmpty.lease)).resolves.toStrictEqual({
      phase: 'MANIFEST',
      page: 1,
    })
    expect((await savedState(observedEmpty.run.id)).run).toMatchObject({
      summary: null,
      rows: null,
      completedAt: null,
    })
  })

  it('replay räknar om lagrad sidhash även när den ändrade JSON-kroppen har giltig form', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    const original = page(1)
    await f.checkpoints.commitVoucherPage(f.lease, original)
    const before = await savedState(f.run.id)
    const savedPage = before.pages[0]
    if (!savedPage) throw new Error('Fixturens sparade manifestsida saknas')
    // Alla fält följer det giltiga entries-schemat. Endast dess innehåll ändras,
    // medan den tidigare sparade sidhashen (som matchar inkommande replay) kvarstår.
    const corrupted = [{ key: '1|L|999', digest: 'a'.repeat(64) }]
    await db().fortnoxReadManifestPage.update({
      where: { id: savedPage.id },
      data: { entries: corrupted },
    })
    await expect(f.checkpoints.commitVoucherPage(f.lease, original)).resolves.toMatchObject({
      status: 'PARTIAL',
      phase: 'DETAILS',
      summary: null,
      rows: null,
    })
    const after = await savedState(f.run.id)
    expect(after.pages[0]).toStrictEqual({ ...savedPage, entries: corrupted })
    expect(after.vouchers).toStrictEqual(before.vouchers)
    expect(after.run.nextManifestPage).toBe(before.run.nextManifestPage)
    expect(after.run.completedAt).toBeInstanceOf(Date)
    await expect(f.checkpoints.claim(f.organizationId, f.run.id)).resolves.toBeNull()
  })
})
