/**
 * Beständiga Fortnox-checkpoints mot riktig PostgreSQL. Alla organisationer och
 * svar är syntetiska. Ingen provider, HTTP-worker, kö eller extern token används.
 * READY_TO_REDUCE betyder bara färdigläst underlag, aldrig en färdig rapport.
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

const RAW_MARKER = 'SYNTHETIC_CHECKPOINT_RAW_DESCRIPTION'
const TOKEN_MARKER = 'SYNTHETIC_CHECKPOINT_ACCESS_TOKEN'
const YEAR = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: YEAR.fromDate,
  financialYearEnd: YEAR.toDate,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Checkpointprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error('Checkpointprovet tillåter bara lokal *_test eller CI:s lokala eken_dev')
  }
  url.searchParams.set('connection_limit', '4')
  return url.toString()
}

function catalog(databaseNumber = 900001) {
  return {
    version: 1,
    companyDatabaseNumber: databaseNumber,
    financialYear: { ...YEAR, accountingMethod: 'ACCRUAL' },
    accounts: [{ number: 5170, active: true, balanceBroughtForwardOre: 0 }],
    dimensions: [{ type: 'COST_CENTER', code: 'A' }],
    coverage: {
      costCenters: { pages: 1, totalPages: 1, totalResources: 1, itemsSeen: 1 },
    },
  }
}

function page(numbers: number[], current = 1, totalPages = 1, totalResources = numbers.length) {
  return {
    MetaInformation: {
      '@CurrentPage': current,
      '@TotalPages': totalPages,
      '@TotalResources': totalResources,
    },
    Vouchers: numbers.map((number) => ({
      Year: 1,
      VoucherSeries: 'L',
      VoucherNumber: number,
      TransactionDate: '2026-10-01',
      Description: RAW_MARKER,
      UnknownProviderField: { body: RAW_MARKER },
    })),
  }
}

type SyntheticVoucher = FortnoxVoucher & { UnknownProviderField: { body: string } }

function detail(number: number, amount = 10.05): SyntheticVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: number,
    TransactionDate: '2026-10-01',
    Description: RAW_MARKER,
    Comments: RAW_MARKER,
    UnknownProviderField: { body: RAW_MARKER },
    VoucherRows: [
      { Account: 2440, Credit: amount, Description: RAW_MARKER },
      { Account: 5170, Debit: amount, CostCenter: 'A', Description: RAW_MARKER },
    ],
  }
}

describe('Fortnox-checkpoints mot riktig PostgreSQL', () => {
  let prisma: PrismaClient | undefined
  const organizations: string[] = []

  function db(): PrismaClient {
    if (!prisma) throw new Error('PostgreSQL-fixturen har inte startats')
    return prisma
  }

  function service(client = db()): FortnoxReadCheckpointService {
    return new FortnoxReadCheckpointService(client as unknown as PrismaService)
  }

  async function fixture(databaseNumber = 900001) {
    const id = randomUUID()
    await db().organization.create({
      data: {
        id,
        name: `synthetic-read-checkpoint-${id}`,
        email: `${id}@example.invalid`,
        street: 'Syntetisk testgata 1',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    organizations.push(id)
    const connection = await db().fortnoxConnection.create({
      data: {
        organizationId: id,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: databaseNumber,
        accessTokenEnc: TOKEN_MARKER,
        refreshTokenEnc: `${TOKEN_MARKER}_REFRESH`,
        tokenVersion: 0,
        generation: 0,
      },
    })
    return { organizationId: id, connectionId: connection.id }
  }

  async function started() {
    const owner = await fixture()
    const checkpoints = service()
    const run = await checkpoints.start(owner.organizationId, null, INPUT)
    const lease = await checkpoints.claim(owner.organizationId, run.id)
    expect(lease).not.toBeNull()
    if (!lease) throw new Error('Fixturens första claim saknas')
    return { ...owner, checkpoints, run, lease }
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
      throw new AggregateError(failures, 'Kunde inte städa checkpointprovets egna fixturer')
  })

  it('KANARIEFÅGEL: kör utan skip mot den uttryckliga isolerade PostgreSQL-databasen', async () => {
    const expected = decodeURIComponent(new URL(isolatedDatabaseUrl()).pathname.slice(1))
    const rows = await db().$queryRaw<Array<{ database: string }>>(
      Prisma.sql`SELECT current_database() AS database`,
    )
    expect(rows).toStrictEqual([{ database: expected }])
  })

  it('två samtidiga lika starter får en körning; annat urval blockeras bara i samma organisation', async () => {
    const owner = await fixture()
    const other = await fixture(900002)
    const results = await Promise.all([
      service().start(owner.organizationId, null, { ...INPUT, costAccounts: [5170, 5160] }),
      service().start(owner.organizationId, null, { ...INPUT, costAccounts: [5160, 5170, 5170] }),
    ])
    expect(new Set(results.map((run) => run.id)).size).toBe(1)
    expect(results.every((run) => run.status === 'RUNNING')).toBe(true)
    expect(results[0]?.costAccounts).toStrictEqual([5160, 5170])
    await expect(
      service().start(owner.organizationId, null, { ...INPUT, periodTo: '2026-10-30' }),
    ).rejects.toBeInstanceOf(ConflictException)
    const foreign = await service().start(other.organizationId, null, INPUT)
    expect(foreign.id).not.toBe(results[0]?.id)
    expect(foreign.organizationId).toBe(other.organizationId)
    expect(foreign.fortnoxDatabaseNumber).toBe(900002)
    expect(
      await db().fortnoxReadRun.count({ where: { organizationId: owner.organizationId } }),
    ).toBe(1)
    expect(
      await db().fortnoxReadRun.count({ where: { organizationId: other.organizationId } }),
    ).toBe(1)
  })

  it('fryser minimal fastighets- och exportproveniens för rätt organisation, företag, år och status', async () => {
    const owner = await fixture()
    const other = await fixture()
    const propertyId = randomUUID()
    const replacementPropertyId = randomUUID()
    const foreignPropertyId = randomUUID()
    const mappingId = randomUUID()
    const foreignMappingId = randomUUID()
    const accounts = [owner.organizationId, other.organizationId].flatMap((organizationId) =>
      [1930, 5160, 5170].map(
        (number) =>
          ({
            id: randomUUID(),
            organizationId,
            number,
            name: `Syntetiskt konto ${number}`,
            type: number === 1930 ? 'ASSET' : 'EXPENSE',
          }) satisfies Prisma.AccountCreateManyInput,
      ),
    )
    const exportCases = (
      [
        {
          organizationId: owner.organizationId,
          journalOrg: owner.organizationId,
          year: 1,
          company: 900001,
          state: 'CONFIRMED',
          number: 101,
        },
        {
          organizationId: owner.organizationId,
          journalOrg: owner.organizationId,
          year: 2,
          company: 900001,
          state: 'CONFIRMED',
          number: 201,
        },
        {
          organizationId: owner.organizationId,
          journalOrg: owner.organizationId,
          year: 1,
          company: 900002,
          state: 'CONFIRMED',
          number: 301,
        },
        {
          organizationId: owner.organizationId,
          journalOrg: owner.organizationId,
          year: 1,
          company: 900001,
          state: 'RECEIPT_IDENTIFIED',
          number: 401,
        },
        {
          organizationId: other.organizationId,
          journalOrg: other.organizationId,
          year: 1,
          company: 900001,
          state: 'CONFIRMED',
          number: 501,
        },
        // Exportens två FK är separata: båda raderna finns, men journalen tillhör annan org.
        {
          organizationId: owner.organizationId,
          journalOrg: other.organizationId,
          year: 1,
          company: 900001,
          state: 'CONFIRMED',
          number: 601,
        },
      ] as const
    ).map((item) => ({ ...item, id: randomUUID(), journalEntryId: randomUUID() }))
    const journalIds = exportCases.map((item) => item.journalEntryId)
    const exportIds = exportCases.map((item) => item.id)
    const draft: Prisma.InputJsonObject = {
      rawDescription: RAW_MARKER,
      kontomappning: { revision: 7, raw: RAW_MARKER },
      provenance: {
        raw: RAW_MARKER,
        lines: [
          { localAccountNumber: 5170, externalAccountNumber: 5171, description: RAW_MARKER },
          { localAccountNumber: 5160, externalAccountNumber: 5171, description: RAW_MARKER },
          { localAccountNumber: 5170, externalAccountNumber: 5171, description: RAW_MARKER },
          { localAccountNumber: 1930, externalAccountNumber: 1940, description: RAW_MARKER },
        ],
      },
    }
    try {
      await db().property.createMany({
        data: [
          { id: propertyId, organizationId: owner.organizationId, name: 'Syntetiskt ursprungshus' },
          {
            id: replacementPropertyId,
            organizationId: owner.organizationId,
            name: 'Syntetiskt ersättningshus',
          },
          {
            id: foreignPropertyId,
            organizationId: other.organizationId,
            name: 'Syntetiskt främmande hus',
          },
        ].map(
          (item): Prisma.PropertyCreateManyInput => ({
            ...item,
            propertyDesignation: `Syntetisk ${item.id} 1:1`,
            type: 'RESIDENTIAL',
            street: 'Syntetisk testgata 2',
            city: 'Teststad',
            postalCode: '11111',
            totalArea: '100.00',
          }),
        ),
      })
      await db().fortnoxDimensionMapping.createMany({
        data: [
          {
            id: mappingId,
            organizationId: owner.organizationId,
            dimensionType: 'COST_CENTER',
            code: 'A',
            propertyId,
          },
          {
            id: foreignMappingId,
            organizationId: other.organizationId,
            dimensionType: 'COST_CENTER',
            code: 'FOREIGN',
            propertyId: foreignPropertyId,
          },
        ],
      })
      await db().account.createMany({ data: accounts })
      await db().journalEntry.createMany({
        data: exportCases.map(
          (item, index): Prisma.JournalEntryCreateManyInput => ({
            id: item.journalEntryId,
            organizationId: item.journalOrg,
            date: new Date('2026-10-01T00:00:00Z'),
            description: RAW_MARKER,
            source: 'MANUAL',
            sourceId: `synthetic-checkpoint:${item.journalEntryId}`,
            fiscalYear: 2026,
            series: 'A',
            verNumber: index + 1,
          }),
        ),
      })
      await db().journalEntryLine.createMany({
        data: exportCases.flatMap((item) =>
          accounts
            .filter((account) => account.organizationId === item.journalOrg)
            .map(
              (account): Prisma.JournalEntryLineCreateManyInput => ({
                journalEntryId: item.journalEntryId,
                accountId: account.id,
                debit:
                  account.number === 5170 ? '60.00' : account.number === 5160 ? '40.00' : '0.00',
                credit: account.number === 1930 ? '100.00' : '0.00',
              }),
            ),
        ),
      })
      await db().fortnoxVoucherExport.createMany({
        data: exportCases.map(
          (item): Prisma.FortnoxVoucherExportCreateManyInput => ({
            id: item.id,
            organizationId: item.organizationId,
            journalEntryId: item.journalEntryId,
            state: item.state,
            fortnoxDatabaseNumber: item.company,
            externalYear: item.year,
            externalSeries: 'L',
            externalNumber: item.number,
            draft,
            draftHash: 'a'.repeat(64),
          }),
        ),
      })
      // Kontrollens felkopplade export måste verkligen finnas, annars mäter den inget.
      const crossOrg = exportCases[5]!
      expect(
        await db().fortnoxVoucherExport.findUniqueOrThrow({
          where: { id: crossOrg.id },
          select: { organizationId: true, journalEntry: { select: { organizationId: true } } },
        }),
      ).toStrictEqual({
        organizationId: owner.organizationId,
        journalEntry: { organizationId: other.organizationId },
      })
      const valid = exportCases[0]!
      const run = await service().start(owner.organizationId, null, INPUT)
      const expectedContext = {
        version: 1,
        input: INPUT,
        mappings: [
          { type: 'COST_CENTER', code: 'A', propertyId, propertyName: 'Syntetiskt ursprungshus' },
        ],
        ownExports: [
          {
            voucher: '1|L|101',
            journalEntryId: valid.journalEntryId,
            revision: 7,
            perMal: [
              { account: 5171, sources: [5170, 5160] },
              { account: 1940, sources: [1930] },
            ],
          },
        ],
      }
      expect(run.frozenContext).toStrictEqual(expectedContext)
      expect(JSON.stringify(run)).not.toContain(RAW_MARKER)
      expect(JSON.stringify(run)).not.toContain(TOKEN_MARKER)

      await db().fortnoxDimensionMapping.update({
        where: { id: mappingId },
        data: { code: 'B', propertyId: replacementPropertyId },
      })
      await db().property.update({ where: { id: propertyId }, data: { name: 'Senare namn' } })
      await db().fortnoxVoucherExport.update({
        where: { id: valid.id },
        data: {
          externalNumber: 102,
          draft: {
            rawDescription: `${RAW_MARKER}_CHANGED`,
            kontomappning: { revision: 8 },
            provenance: { lines: [{ localAccountNumber: 5170, externalAccountNumber: 5999 }] },
          },
        },
      })
      const resumed = await service().start(owner.organizationId, null, INPUT)
      expect(resumed.id).toBe(run.id)
      expect(resumed.frozenContext).toStrictEqual(expectedContext)
      expect((await savedState(run.id)).run.frozenContext).toStrictEqual(expectedContext)
    } finally {
      // Endast egna UUID-rader, i FK-ordning; orgarnas vanliga cleanup sker efteråt.
      await db().fortnoxVoucherExport.deleteMany({ where: { id: { in: exportIds } } })
      await db().journalEntryLine.deleteMany({ where: { journalEntryId: { in: journalIds } } })
      await db().journalEntry.deleteMany({ where: { id: { in: journalIds } } })
      await db().account.deleteMany({
        where: { id: { in: accounts.map((account) => account.id) } },
      })
      await db().fortnoxDimensionMapping.deleteMany({
        where: { id: { in: [mappingId, foreignMappingId] } },
      })
      await db().property.deleteMany({
        where: { id: { in: [propertyId, replacementPropertyId, foreignPropertyId] } },
      })
    }
  })

  it('en av två samtidiga claims vinner; release och ny instans ger en ny fence', async () => {
    const owner = await fixture()
    const run = await service().start(owner.organizationId, null, INPUT)
    const attempts = await Promise.all([
      service().claim(owner.organizationId, run.id),
      service().claim(owner.organizationId, run.id),
    ])
    expect(attempts.filter((lease) => lease !== null)).toHaveLength(1)
    const winner = attempts.find((lease) => lease !== null)
    if (!winner) throw new Error('Ingen av de två claimsen vann')
    await service().release(winner)
    const replacement = await service().claim(owner.organizationId, run.id)
    expect(replacement).not.toBeNull()
    if (!replacement) throw new Error('Frisläppt körning kunde inte tas över')
    expect(replacement.claimVersion).toBeGreaterThan(winner.claimVersion)
    expect(replacement.claimToken).not.toBe(winner.claimToken)
    await expect(service().commitCatalog(winner, catalog())).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(service().nextStep(replacement)).resolves.toStrictEqual({ phase: 'CATALOG' })
    await service().commitCatalog(replacement, catalog())
    await expect(service().nextStep(replacement)).resolves.toStrictEqual({
      phase: 'MANIFEST',
      page: 1,
    })
  })

  it('utgången lease kan tas över och den gamla ägaren nekas före även ett identiskt replay', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    const before = await savedState(f.run.id)
    await db().$executeRaw(Prisma.sql`
      UPDATE "FortnoxReadRun"
      SET "leaseUntil" = timezone('UTC', clock_timestamp()) - INTERVAL '1 second'
      WHERE "id" = ${f.run.id}
    `)
    // Även utan en ny ägare ska en utgången lease vara obrukbar.
    await expect(f.checkpoints.commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
      ConflictException,
    )
    const takeover = await service().claim(f.organizationId, f.run.id)
    expect(takeover).not.toBeNull()
    if (!takeover) throw new Error('Utgången lease kunde inte tas över')
    expect(takeover.claimVersion).toBeGreaterThan(f.lease.claimVersion)
    expect(takeover.claimToken).not.toBe(f.lease.claimToken)
    await expect(f.checkpoints.commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(f.checkpoints.nextStep(f.lease)).rejects.toBeInstanceOf(ConflictException)
    const after = await savedState(f.run.id)
    expect(after.run.catalog).toStrictEqual(before.run.catalog)
    expect(after.run.phase).toBe(before.run.phase)
    expect(after.pages).toStrictEqual(before.pages)
    expect(after.vouchers).toStrictEqual(before.vouchers)
    await expect(service().commitCatalog(takeover, catalog())).resolves.toMatchObject({
      id: f.run.id,
      status: 'RUNNING',
    })
  })

  it('en claim från annan organisation kan varken läsa steget eller skriva underlaget', async () => {
    const f = await started()
    const other = await fixture(900002)
    const forged = { ...f.lease, organizationId: other.organizationId }
    const before = await savedState(f.run.id)
    await expect(service().nextStep(forged)).rejects.toBeInstanceOf(ConflictException)
    await expect(service().commitCatalog(forged, catalog())).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(await savedState(f.run.id)).toStrictEqual(before)
    expect(
      await db().fortnoxReadRun.count({ where: { organizationId: other.organizationId } }),
    ).toBe(0)
  })

  it('återupptar samma sparade manifest efter ny instans och blir bara READY_TO_REDUCE', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.commitVoucherPage(f.lease, page([2, 1], 1, 2, 3))
    await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
      phase: 'MANIFEST',
      page: 2,
    })
    await f.checkpoints.release(f.lease)

    // Ingen återanvändning av processminne: den nya tjänsten läser DB-cursorn.
    const restarted = service()
    const lease = await restarted.claim(f.organizationId, f.run.id)
    expect(lease).not.toBeNull()
    if (!lease) throw new Error('Omstarten saknar lease')
    await expect(restarted.nextStep(lease)).resolves.toStrictEqual({ phase: 'MANIFEST', page: 2 })
    await restarted.commitVoucherPage(lease, page([10], 2, 2, 3))
    await expect(restarted.readValidatedPage(lease)).rejects.toBeInstanceOf(ConflictException)
    for (const number of [1, 10, 2]) {
      const expected = { phase: 'DETAILS', key: `1|L|${number}` }
      await expect(restarted.nextStep(lease)).resolves.toStrictEqual(expected)
      await expect(restarted.nextStep(lease)).resolves.toStrictEqual(expected)
      await restarted.commitVoucherDetail(lease, `1|L|${number}`, detail(number))
    }
    await expect(restarted.nextStep(lease)).resolves.toStrictEqual({ phase: 'READY_TO_REDUCE' })
    expect(
      (await restarted.readValidatedPage(lease, { limit: 2 })).map((item) => item.key),
    ).toStrictEqual(['1|L|1', '1|L|10'])
    expect(
      (await restarted.readValidatedPage(lease, { afterKey: '1|L|10', limit: 2 })).map(
        (item) => item.key,
      ),
    ).toStrictEqual(['1|L|2'])
    await expect(
      restarted.readValidatedPage(lease, { afterKey: '1|L|2', limit: 2 }),
    ).resolves.toStrictEqual([])
    const saved = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
    expect(saved).toMatchObject({
      status: 'RUNNING',
      summary: null,
      rows: null,
      completedAt: null,
      financialYearStart: new Date(`${YEAR.fromDate}T00:00:00Z`),
      financialYearEnd: new Date(`${YEAR.toDate}T00:00:00Z`),
    })
    const persisted = await savedState(f.run.id)
    expect(persisted.pages).toHaveLength(2)
    expect(persisted.vouchers.map((voucher) => voucher.key)).toStrictEqual([
      '1|L|1',
      '1|L|10',
      '1|L|2',
    ])
    expect(persisted.vouchers.every((voucher) => voucher.observedAt !== null)).toBe(true)
    expect(JSON.stringify(persisted)).not.toContain(RAW_MARKER)
    expect(JSON.stringify(persisted)).not.toContain(TOKEN_MARKER)
  })

  it('samma manifest-sida är replay, men ändrat okänt råfält får inte ersätta första underlaget', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    const original = page([1])
    await f.checkpoints.commitVoucherPage(f.lease, original)
    const before = await savedState(f.run.id)
    const replay = await service().commitVoucherPage(f.lease, JSON.parse(JSON.stringify(original)))
    expect(replay.status).toBe('RUNNING')
    const afterReplay = await savedState(f.run.id)
    expect(afterReplay.pages).toStrictEqual(before.pages)
    expect(afterReplay.vouchers).toStrictEqual(before.vouchers)
    expect(afterReplay.run.nextManifestPage).toBe(before.run.nextManifestPage)
    const conflicting = {
      ...original,
      Vouchers: original.Vouchers.map((item) => ({
        ...item,
        UnknownProviderField: { body: `${RAW_MARKER}_CHANGED` },
      })),
    }
    const failed = await service().commitVoucherPage(f.lease, conflicting)
    expect(failed).toMatchObject({ status: 'PARTIAL', summary: null, rows: null })
    const afterConflict = await savedState(f.run.id)
    expect(afterConflict.pages).toStrictEqual(before.pages)
    expect(afterConflict.vouchers).toStrictEqual(before.vouchers)
    expect(afterConflict.run.nextManifestPage).toBe(before.run.nextManifestPage)
    expect(JSON.stringify(afterConflict)).not.toContain(RAW_MARKER)
    await expect(service().claim(f.organizationId, f.run.id)).resolves.toBeNull()
  })

  it.each([
    { name: 'fel sidnummer', incoming: () => page([2], 3, 3, 3), terminal: false },
    { name: 'ändrat totalantal', incoming: () => page([2], 2, 3, 4), terminal: true },
  ])(
    'avvisar $name utan att flytta cursor eller spara en halv sida',
    async ({ incoming, terminal }) => {
      const f = await started()
      await f.checkpoints.commitCatalog(f.lease, catalog())
      await f.checkpoints.commitVoucherPage(f.lease, page([1], 1, 3, 3))
      const before = await savedState(f.run.id)
      const attempt = f.checkpoints.commitVoucherPage(f.lease, incoming())
      if (terminal) {
        await expect(attempt).resolves.toMatchObject({
          status: 'PARTIAL',
          summary: null,
          rows: null,
        })
      } else {
        await expect(attempt).rejects.toBeInstanceOf(ConflictException)
      }
      const after = await savedState(f.run.id)
      expect(after.pages).toStrictEqual(before.pages)
      expect(after.vouchers).toStrictEqual(before.vouchers)
      expect(after.run.nextManifestPage).toBe(2)
      if (!terminal) expect(after.run).toStrictEqual(before.run)
    },
  )

  it('samma detalj är replay; ett annat belopp får inte ersätta den observerade detaljen', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.commitVoucherPage(f.lease, page([1]))
    await f.checkpoints.commitVoucherDetail(f.lease, '1|L|1', detail(1))
    const before = await savedState(f.run.id)
    const replay = await service().commitVoucherDetail(f.lease, '1|L|1', detail(1))
    expect(replay.status).toBe('RUNNING')
    expect((await savedState(f.run.id)).vouchers).toStrictEqual(before.vouchers)
    const failed = await service().commitVoucherDetail(f.lease, '1|L|1', detail(1, 20.05))
    expect(failed).toMatchObject({ status: 'PARTIAL', summary: null, rows: null })
    expect((await savedState(f.run.id)).vouchers).toStrictEqual(before.vouchers)
    expect(before.vouchers[0]?.validated).toStrictEqual({
      key: '1|L|1',
      date: '2026-10-01',
      headerDimensionPresent: false,
      reference: null,
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
          costCenter: 'A',
          project: null,
          removed: false,
        },
      ],
    })
  })

  it('fel efter verklig sid-/detaljskrivning rullar tillbaka både underlag och cursor', async () => {
    for (const stage of ['page', 'detail'] as const) {
      const f = await started()
      await f.checkpoints.commitCatalog(f.lease, catalog())
      if (stage === 'detail') await f.checkpoints.commitVoucherPage(f.lease, page([1]))
      const before = await savedState(f.run.id)
      const fault = new Error(`SYNTHETIC_CHECKPOINT_${stage}_ROLLBACK`)
      let injectedAfterWrite = false
      const interruptedDb = db().$extends({
        query: {
          fortnoxReadManifestPage: {
            async create({ args, query }) {
              const result = await query(args)
              if (stage === 'page') {
                injectedAfterWrite = true
                throw fault
              }
              return result
            },
          },
          fortnoxReadVoucherCheckpoint: {
            async update({ args, query }) {
              const result = await query(args)
              if (stage === 'detail') {
                injectedAfterWrite = true
                throw fault
              }
              return result
            },
          },
        },
      })
      const interrupted = new FortnoxReadCheckpointService(
        interruptedDb as unknown as PrismaService,
      )
      const attempt =
        stage === 'page'
          ? interrupted.commitVoucherPage(f.lease, page([1]))
          : interrupted.commitVoucherDetail(f.lease, '1|L|1', detail(1))
      await expect(attempt).rejects.toThrow(fault.message)
      // Utan den här kontrollen kunde ett fel före första skrivningen ge falskt grönt.
      expect(injectedAfterWrite).toBe(true)
      expect(await savedState(f.run.id)).toStrictEqual(before)
      if (stage === 'page') {
        await f.checkpoints.commitVoucherPage(f.lease, page([1]))
        await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
          phase: 'DETAILS',
          key: '1|L|1',
        })
      } else {
        await f.checkpoints.commitVoucherDetail(f.lease, '1|L|1', detail(1))
        await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
          phase: 'READY_TO_REDUCE',
        })
      }
    }
  })

  it.each([
    { name: 'annan identitet', incoming: () => detail(2) },
    {
      name: 'fel på annat konto utanför perioden',
      incoming: (): FortnoxVoucher => ({
        ...detail(1),
        TransactionDate: '2026-03-01',
        VoucherRows: [
          { Account: 5170, Debit: 1 },
          { Account: 2440, Credit: '1.00' },
        ],
      }),
    },
  ])(
    'avvisar detalj med $name utan observerad detalj eller färdig rapport',
    async ({ incoming }) => {
      const f = await started()
      await f.checkpoints.commitCatalog(f.lease, catalog())
      await f.checkpoints.commitVoucherPage(f.lease, page([1]))
      const before = await savedState(f.run.id)
      const failed = await f.checkpoints.commitVoucherDetail(f.lease, '1|L|1', incoming())
      expect(failed).toMatchObject({ status: 'PARTIAL', summary: null, rows: null })
      expect((await savedState(f.run.id)).vouchers).toStrictEqual(before.vouchers)
      expect(before.vouchers[0]).toMatchObject({
        detailDigest: null,
        validated: null,
        observedAt: null,
      })
    },
  )

  it('vanlig tokenförnyelse godtas utan att token eller rå verifikattext hamnar i körningen', async () => {
    const f = await started()
    await db().fortnoxConnection.update({
      where: { id: f.connectionId },
      data: {
        tokenVersion: { increment: 1 },
        accessTokenEnc: `${TOKEN_MARKER}_ROTATED`,
        refreshTokenEnc: `${TOKEN_MARKER}_REFRESH_ROTATED`,
      },
    })
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.commitVoucherPage(f.lease, page([1]))
    await f.checkpoints.commitVoucherDetail(f.lease, '1|L|1', detail(1))
    await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
      phase: 'READY_TO_REDUCE',
    })
    const saved = await savedState(f.run.id)
    expect(saved.run.status).toBe('RUNNING')
    expect(JSON.stringify(saved)).not.toContain(TOKEN_MARKER)
    expect(JSON.stringify(saved)).not.toContain(RAW_MARKER)
  })

  it.each([
    { name: 'ny generation', data: { generation: { increment: 1 } } },
    { name: 'frånkoppling', data: { status: 'DISCONNECTED' } },
  ] satisfies Array<{ name: string; data: Prisma.FortnoxConnectionUpdateInput }>)(
    '$name stoppar även en giltig lease och sparar stoppet innan konflikten kastas',
    async ({ data }) => {
      const f = await started()
      await db().fortnoxConnection.update({ where: { id: f.connectionId }, data })
      await expect(f.checkpoints.commitCatalog(f.lease, catalog())).rejects.toBeInstanceOf(
        ConflictException,
      )
      const after = await savedState(f.run.id)
      expect(after.run).toMatchObject({
        status: 'FAILED',
        reason: 'Fortnox-anslutningen har ändrats; starta en ny läsning.',
        catalog: null,
        summary: null,
        rows: null,
      })
      expect(after.run.completedAt).toBeInstanceOf(Date)
      expect(after.pages).toHaveLength(0)
      expect(after.vouchers).toHaveLength(0)
      await expect(service().claim(f.organizationId, f.run.id)).resolves.toBeNull()
    },
  )

  it('korrupt sparad normalform blir beständigt FAILED utan ett framgångsrikt lässvar', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.commitVoucherPage(f.lease, page([1]))
    await f.checkpoints.commitVoucherDetail(f.lease, '1|L|1', detail(1))
    const before = await savedState(f.run.id)
    const observed = before.vouchers[0]
    const normalized = observed?.validated
    if (!observed || !normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new Error('Det syntetiska underlaget saknar normalform')
    }
    await db().fortnoxReadVoucherCheckpoint.update({
      where: { id: observed.id },
      data: { validated: { ...normalized, key: '1|L|999' } },
    })
    await expect(service().readValidatedPage(f.lease)).rejects.toBeInstanceOf(ConflictException)
    const after = await savedState(f.run.id)
    expect(after.run).toMatchObject({
      status: 'FAILED',
      reason: 'Sparat läsunderlag är ogiltigt; starta en ny läsning.',
      summary: null,
      rows: null,
    })
    expect(after.vouchers[0]?.detailDigest).toBe(observed.detailDigest)
    await expect(service().claim(f.organizationId, f.run.id)).resolves.toBeNull()
  })

  it('den exakta tomma första sidan går direkt till READY men skapar ingen nollrapport', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.commitVoucherPage(f.lease, page([], 1, 0, 0))
    await expect(f.checkpoints.nextStep(f.lease)).resolves.toStrictEqual({
      phase: 'READY_TO_REDUCE',
    })
    const after = await savedState(f.run.id)
    expect(after.pages).toHaveLength(1)
    expect(after.vouchers).toHaveLength(0)
    expect(after.run).toMatchObject({
      status: 'RUNNING',
      summary: null,
      rows: null,
      completedAt: null,
    })
  })

  it('suspend bevarar steget men spärrar claim till retrytid; explicit AUTH_LOST stoppar körningen', async () => {
    const f = await started()
    await f.checkpoints.commitCatalog(f.lease, catalog())
    await f.checkpoints.suspend(f.lease, 'RATE_LIMITED', new Date(Date.now() + 60_000))
    await expect(service().claim(f.organizationId, f.run.id)).resolves.toBeNull()
    await expect(service().commitVoucherPage(f.lease, page([1]))).rejects.toBeInstanceOf(
      ConflictException,
    )
    await db().$executeRaw(Prisma.sql`
      UPDATE "FortnoxReadRun"
      SET "nextAttemptAt" = timezone('UTC', clock_timestamp()) - INTERVAL '1 second'
      WHERE "id" = ${f.run.id}
    `)
    const resumed = await service().claim(f.organizationId, f.run.id)
    expect(resumed).not.toBeNull()
    if (!resumed) throw new Error('Förfallet återförsök kunde inte återupptas')
    await expect(service().nextStep(resumed)).resolves.toStrictEqual({ phase: 'MANIFEST', page: 1 })
    await service().invalidate(resumed, 'AUTH_LOST')
    const after = await savedState(f.run.id)
    expect(after.run).toMatchObject({ status: 'AUTH_LOST', summary: null, rows: null })
    expect(after.pages).toHaveLength(0)
    expect(after.vouchers).toHaveLength(0)
    await expect(service().claim(f.organizationId, f.run.id)).resolves.toBeNull()
  })

  it('SQL-spärren nekar COMPLETE och delresultat för managed körning men bevarar legacy-formatet', async () => {
    const f = await started()
    const before = await savedState(f.run.id)
    const forbidden = [
      Prisma.sql`UPDATE "FortnoxReadRun" SET "status" = 'COMPLETE' WHERE "id" = ${f.run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "summary" = '{"currency":"SEK","totalOre":0}'::jsonb WHERE "id" = ${f.run.id}`,
      Prisma.sql`UPDATE "FortnoxReadRun" SET "rows" = '[]'::jsonb WHERE "id" = ${f.run.id}`,
    ]
    for (const statement of forbidden) {
      await expect(db().$executeRaw(statement)).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({
          code: '23514',
          message: expect.stringContaining('fortnox_read_checkpoint_shape'),
        }),
      })
      expect(await savedState(f.run.id)).toStrictEqual(before)
    }
    const legacy = await db().fortnoxReadRun.create({
      data: {
        organizationId: f.organizationId,
        connectionId: f.connectionId,
        fortnoxDatabaseNumber: 900001,
        financialYearId: INPUT.financialYearId,
        periodFrom: new Date(`${INPUT.periodFrom}T00:00:00Z`),
        periodTo: new Date(`${INPUT.periodTo}T00:00:00Z`),
        costAccounts: INPUT.costAccounts,
        status: 'COMPLETE',
        completedAt: new Date(),
        summary: { currency: 'SEK', totalOre: 0 },
        rows: [],
      },
    })
    expect(legacy).toMatchObject({
      workVersion: null,
      phase: null,
      status: 'COMPLETE',
      summary: { currency: 'SEK', totalOre: 0 },
      rows: [],
    })
  })

  it('båda barnens riktiga FK nekar annan organisation även när båda organisationerna finns', async () => {
    const f = await started()
    const other = await fixture(900002)
    const before = await savedState(f.run.id)
    await expect(
      db().fortnoxReadManifestPage.create({
        data: {
          organizationId: other.organizationId,
          runId: f.run.id,
          page: 1,
          totalPages: 0,
          totalResources: 0,
          itemCount: 0,
          digest: 'a'.repeat(64),
          entries: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
    await expect(
      db().fortnoxReadVoucherCheckpoint.create({
        data: {
          organizationId: other.organizationId,
          runId: f.run.id,
          key: '1|L|1',
          manifestDigest: 'b'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
    expect(await savedState(f.run.id)).toStrictEqual(before)
  })
})
