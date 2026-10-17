/** Verklig syntetisk PostgreSQL-kedja: start → claim → fryst källa → stage.
 * Normalformsfacit är handskrivet; varken kallkonton eller produktmappern
 * används för förväntade items. Inga provideranrop eller triggerbypasser.
 * Det uttryckligt märkta voucherduplettfallet börjar i rålagringen, inte i start.
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { checkpointDigest, type StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { FortnoxReadSourceRunService, type SourceRunLease } from './fortnox-read-source-run.service'

const INPUT = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
const INVALID_SOURCE = 'Det frysta källunderlaget kan inte normaliseras; starta en ny läsning.'
type Kind = 'MAPPINGS' | 'OWN_EXPORTS'
type Mapping = {
  type: 'COST_CENTER' | 'PROJECT'
  code: string
  propertyId: string
  propertyName: string
}
type OwnExport = {
  voucher: string
  journalEntryId: string
  revision: number | null
  perMal: Array<{ account: number; sources: number[] }>
}
type ExportSeed = {
  draft: Prisma.InputJsonValue
  number?: number
  series?: string
  source?: Pick<OwnExport, 'revision' | 'perMal'>
}
const emptyExports = (count: number): ExportSeed[] =>
  Array.from({ length: count }, () => ({ draft: {} }))
const line = { localAccountNumber: 5170, externalAccountNumber: 5171 }

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Normaliseringsstage kräver uttrycklig lokal testdatabas')
  const url = new URL(raw),
    name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Normaliseringsstage tillåter bara egen lokal testdatabas eller CI:s eken_dev')
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
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
  transform?: (params: Prisma.MiddlewareParams, result: unknown) => unknown
}

describe('Fortnox: sidvis normaliseringsstage i verklig PostgreSQL', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>(),
    accounts = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Normaliseringsfixture har inte startat')
    return prisma
  }
  const service = (client = db()) => new FortnoxReadSourceRunService(client)
  const tx = <T>(work: (c: Prisma.TransactionClient) => Promise<T>, client = db()) =>
    client.$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  const page = (
    owner: FortnoxReadSourceRunService,
    lease: SourceRunLease,
    kind: Kind,
    afterOrdinal = 0n,
  ) => owner.normalizePage(lease, { expectedKind: kind, expectedAfterOrdinal: afterOrdinal })
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
    if (!row) throw new Error('Kontrollerad anslutning saknar PID')
    return { client, hooks, pid: row.pid }
  }
  async function fixture(mappingCount = 0, seeds: ExportSeed[] = []) {
    const org = randomUUID(),
      propertyId = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-normalization-${org}`,
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
        fortnoxDatabaseNumber: 900001,
        fortnoxOrgNumber: 'SYNTHETIC_STAGE_COMPANY',
      },
    })
    const mappingItems: Mapping[] = Array.from({ length: mappingCount }, (_, i) => ({
      type: 'COST_CENTER',
      code: String(i + 1).padStart(3, '0'),
      propertyId,
      propertyName: 'Syntetisk fastighet',
    }))
    const prefix = randomUUID().slice(0, 24)
    const rows = seeds.map(
      (
        seed,
        i,
      ): Prisma.FortnoxVoucherExportCreateManyInput & {
        journalEntryId: string
        externalSeries: string
        externalNumber: number
      } => ({
        id: `${prefix}${String(i + 1).padStart(12, '0')}`,
        organizationId: org,
        journalEntryId: randomUUID(),
        state: 'CONFIRMED',
        fortnoxDatabaseNumber: 900001,
        externalYear: 1,
        externalSeries: seed.series ?? 'L',
        externalNumber: seed.number ?? i + 1,
        draft: seed.draft,
      }),
    )
    for (const row of rows) {
      journals.add(row.journalEntryId)
      if (row.id) exports.add(row.id)
    }
    await tx(async (c) => {
      await c.property.create({
        data: {
          id: propertyId,
          organizationId: org,
          name: 'Syntetisk fastighet',
          propertyDesignation: `TEST ${propertyId}`,
          type: 'RESIDENTIAL',
          street: 'Testgata 2',
          city: 'Teststad',
          postalCode: '11111',
          totalArea: '100.00',
        },
      })
      if (mappingItems.length)
        await c.fortnoxDimensionMapping.createMany({
          data: mappingItems.map((item) => ({
            organizationId: org,
            propertyId,
            dimensionType: item.type,
            code: item.code,
          })),
        })
      if (rows.length) {
        const bank = randomUUID(),
          expense = randomUUID()
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
        await c.journalEntry.createMany({
          data: rows.map(
            (row, i): Prisma.JournalEntryCreateManyInput => ({
              id: row.journalEntryId,
              organizationId: org,
              date: new Date('2026-01-01T00:00:00Z'),
              description: 'SYNTHETIC_STAGE_ONLY',
              source: 'MANUAL',
              sourceId: `synthetic:${row.journalEntryId}`,
              fiscalYear: 2026,
              series: 'A',
              verNumber: i + 1,
            }),
          ),
        })
        await c.journalEntryLine.createMany({
          data: rows.flatMap((row): Prisma.JournalEntryLineCreateManyInput[] => [
            {
              journalEntryId: row.journalEntryId,
              accountId: bank,
              debit: '0.00',
              credit: '100.00',
            },
            {
              journalEntryId: row.journalEntryId,
              accountId: expense,
              debit: '100.00',
              credit: '0.00',
            },
          ]),
        })
        await c.fortnoxVoucherExport.createMany({ data: rows })
      }
    })
    // Endast givna identiteter/voucherfält och handskrivna förväntningar.
    // Inga förväntade konton härleds ur draft eller ur produktens normalform.
    const exportItems: OwnExport[] = rows.map((row, i) => ({
      voucher: `1|${row.externalSeries}|${row.externalNumber}`,
      journalEntryId: row.journalEntryId,
      revision: seeds[i]!.source?.revision ?? null,
      perMal: seeds[i]!.source?.perMal ?? [],
    }))
    return { org, propertyId, connection, mappingItems, exportItems, rows }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function historicalDuplicateStorage(f: Fixture) {
    // Live-exportens externa identitet är unik. Detta är en separat, syntetisk
    // historisk råkälla enligt lagringskontraktet, inte ett bevis för live-start.
    const captureId = randomUUID()
    const rows: Prisma.FortnoxReadSourceExportCreateManyInput[] = Array.from(
      { length: 101 },
      (_, i) => ({
        organizationId: f.org,
        captureId,
        ordinal: BigInt(i + 1),
        sourceId: randomUUID(),
        journalEntryId: randomUUID(),
        externalYear: 1,
        externalSeries: i < 99 ? 'A' : 'L',
        externalNumber: i < 99 ? i + 1 : 42,
        accountSource:
          i < 99 ? {} : { kontomappning: { revision: 0 }, provenance: { lines: [line] } },
      }),
    )
    const exportItems: OwnExport[] = rows.map((row, i) => ({
      voucher: i < 99 ? `1|A|${i + 1}` : '1|L|42',
      journalEntryId: row.journalEntryId,
      revision: i < 99 ? null : 0,
      perMal: i < 99 ? [] : [{ account: 5171, sources: [5170] }],
    }))
    const run = await db().$transaction(
      async (c) => {
        const capture = await c.fortnoxReadSourceCapture.create({
          data: {
            id: captureId,
            organizationId: f.org,
            connectionId: f.connection.id,
            connectionGeneration: f.connection.generation,
            fortnoxDatabaseNumber: f.connection.fortnoxDatabaseNumber,
            fortnoxOrgNumber: f.connection.fortnoxOrgNumber,
            input: INPUT,
            requestHash: checkpointDigest(INPUT),
          },
        })
        await c.fortnoxReadSourceExport.createMany({ data: rows })
        await c.$executeRaw`
          UPDATE "FortnoxReadSourceCapture"
          SET "exportCount" = ${rows.length}, "sealedAt" = clock_timestamp()
          WHERE id = ${capture.id} AND "organizationId" = ${f.org}`
        await c.$executeRaw`SET CONSTRAINTS "fortnox_source_commit_seal" IMMEDIATE`
        return c.fortnoxReadRun.create({
          data: {
            id: capture.id,
            organizationId: f.org,
            sourceCaptureId: capture.id,
            workVersion: 2,
            phase: 'SOURCE_CAPTURED',
            connectionId: capture.connectionId,
            connectionGeneration: capture.connectionGeneration,
            fortnoxDatabaseNumber: capture.fortnoxDatabaseNumber,
            fortnoxOrgNumber: capture.fortnoxOrgNumber,
            requestHash: capture.requestHash,
            financialYearId: INPUT.financialYearId,
            periodFrom: new Date(`${INPUT.periodFrom}T00:00:00Z`),
            periodTo: new Date(`${INPUT.periodTo}T00:00:00Z`),
            costAccounts: INPUT.costAccounts,
            checkpointUpdatedAt: capture.createdAt,
          },
        })
      },
      {
        ...PRISMA_DEFAULT_TX_LIMITS,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    )
    return { run, rows, exportItems }
  }
  async function start(f: Fixture, owner = service()) {
    const run = await owner.start(f.org, null, INPUT),
      lease = await owner.claim(f.org, run.id)
    if (!lease) throw new Error('Fixture fick inget riktigt anspråk')
    return { run, lease }
  }
  async function state(org: string, client = db()) {
    return {
      runs: await client.fortnoxReadRun.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      stages: await client.fortnoxReadNormalizationStage.findMany({
        where: { organizationId: org },
        orderBy: { id: 'asc' },
      }),
      pages: await client.fortnoxReadNormalizationPage.findMany({
        where: { organizationId: org },
        orderBy: [{ stageId: 'asc' }, { kind: 'asc' }, { afterOrdinal: 'asc' }],
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
  async function waitBlocked(pid: number, blocker: number) {
    const end = Date.now() + 1500
    while (Date.now() < end) {
      const [row] = await db().$queryRaw<Array<{ blockers: number[] }>>`
        SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${pid}`
      if (row?.blockers.includes(blocker)) return
    }
    throw new Error('Verklig låsväntan observerades inte')
  }
  async function expired(lease: SourceRunLease) {
    const end = Date.now() + 2000
    while (Date.now() < end) {
      const [row] = await db().$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (row && row.now > lease.leaseUntil) return
    }
    throw new Error('Kort lease löpte inte ut enligt DB-klockan')
  }
  function expectedDigest(
    f: Fixture,
    run: { id: string; requestHash: string | null },
    kind: Kind,
    afterOrdinal: bigint,
    items: Mapping[] | OwnExport[],
  ) {
    return checkpointDigest({
      version: 1,
      organizationId: f.org,
      runId: run.id,
      sourceCaptureId: run.id,
      stageId: run.id,
      requestHash: run.requestHash,
      kind,
      afterOrdinal: afterOrdinal.toString(),
      itemCount: items.length,
      items,
    })
  }
  async function insertRawPage(
    c: Prisma.TransactionClient,
    f: Fixture,
    runId: string,
    kind: Kind,
    after: bigint,
    items: Mapping[] | OwnExport[],
    patch: { organizationId?: string; stageId?: string; itemCount?: number; digest?: string } = {},
  ) {
    const stage = await c.fortnoxReadNormalizationStage.findUniqueOrThrow({ where: { id: runId } })
    const digest =
      patch.digest ??
      expectedDigest(f, { id: runId, requestHash: stage.requestHash }, kind, after, items)
    return c.$executeRaw`
      INSERT INTO "FortnoxReadNormalizationPage" (id,"organizationId","stageId",kind,"afterOrdinal","itemCount",digest,items)
      VALUES (${randomUUID()},${patch.organizationId ?? f.org},${patch.stageId ?? runId},${kind}::"FortnoxReadContextKind",
        ${after},${patch.itemCount ?? items.length},${digest},${JSON.stringify(items)}::jsonb)`
  }
  async function sqlReject(
    org: string,
    work: (c: Prisma.TransactionClient) => Promise<unknown>,
    code = '23514',
  ) {
    const before = await state(org)
    await expect(
      tx(async (c) => {
        await work(c)
        // En trasig spärr ska göra provet rött och rulla tillbaka även TRUNCATE,
        // aldrig hinna committa destruktiv SQL före den yttre assertionen.
        throw new Error('SYNTHETIC_SQL_UNEXPECTEDLY_ALLOWED')
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code } })
    expect(await durable(org)).toStrictEqual(before)
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
          `synthetic-normalization-${org}`,
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

  it.each([
    { mappings: 0, exports: 0 },
    { mappings: 1, exports: 1 },
    { mappings: 99, exports: 99 },
    { mappings: 100, exports: 100 },
    { mappings: 101, exports: 101 },
    { mappings: 201, exports: 201 },
    { mappings: 0, exports: 101 },
    { mappings: 101, exports: 0 },
  ])(
    '$mappings mappings/$exports exporter: exakt handfacit, sidgränser och nästa steg',
    async (counts) => {
      expect(await db().$queryRaw`SELECT current_database() AS name`).toStrictEqual([
        { name: decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1)) },
      ])
      const f = await fixture(counts.mappings, emptyExports(counts.exports)),
        { run, lease } = await start(f)
      const leasedRun = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } })
      const owner = service(),
        initial = await owner.prepareNormalization(lease)
      expect(initial).toStrictEqual({
        stageId: run.id,
        status: counts.mappings + counts.exports ? 'NORMALIZING' : 'NORMALIZED',
        mappingCount: counts.mappings,
        exportCount: counts.exports,
        mappingsDone: 0,
        exportsDone: 0,
        next: counts.mappings
          ? { expectedKind: 'MAPPINGS', expectedAfterOrdinal: 0n }
          : counts.exports
            ? { expectedKind: 'OWN_EXPORTS', expectedAfterOrdinal: 0n }
            : null,
      })
      let doneMappings = 0,
        doneExports = 0
      for (const kind of ['MAPPINGS', 'OWN_EXPORTS'] as const) {
        const expected = kind === 'MAPPINGS' ? f.mappingItems : f.exportItems
        for (let offset = 0; offset < expected.length; offset += 100) {
          const items = expected.slice(offset, offset + 100)
          const receipt = await page(owner, lease, kind, BigInt(offset))
          expect(receipt).toStrictEqual({
            stageId: run.id,
            pageId: expect.any(String),
            kind,
            afterOrdinal: BigInt(offset),
            itemCount: items.length,
            digest: expectedDigest(f, run, kind, BigInt(offset), items),
          })
          expect(
            await owner.readNormalizedPage(lease, { kind, afterOrdinal: BigInt(offset) }),
          ).toStrictEqual({ ...receipt, items })
          if (kind === 'MAPPINGS') doneMappings += items.length
          else doneExports += items.length
          expect(await owner.prepareNormalization(lease)).toStrictEqual({
            stageId: run.id,
            status:
              doneMappings === counts.mappings && doneExports === counts.exports
                ? 'NORMALIZED'
                : 'NORMALIZING',
            mappingCount: counts.mappings,
            exportCount: counts.exports,
            mappingsDone: doneMappings,
            exportsDone: doneExports,
            next:
              doneMappings < counts.mappings
                ? { expectedKind: 'MAPPINGS', expectedAfterOrdinal: BigInt(doneMappings) }
                : doneExports < counts.exports
                  ? { expectedKind: 'OWN_EXPORTS', expectedAfterOrdinal: BigInt(doneExports) }
                  : null,
          })
        }
      }
      const result = await durable(f.org)
      expect(result.runs).toStrictEqual([leasedRun])
      expect(result.runs[0]).toMatchObject({
        status: 'RUNNING',
        phase: 'SOURCE_CAPTURED',
        frozenContext: null,
        catalog: null,
        rows: null,
        summary: null,
      })
      expect(result.stages[0]).toMatchObject({
        status: 'NORMALIZED',
        normalizedAt: expect.any(Date),
        mappingsDone: counts.mappings,
        exportsDone: counts.exports,
      })
      expect(result.pages.map((row) => row.itemCount)).toStrictEqual([
        ...Array.from({ length: Math.ceil(counts.mappings / 100) }, (_, i) =>
          Math.min(100, counts.mappings - i * 100),
        ),
        ...Array.from({ length: Math.ceil(counts.exports / 100) }, (_, i) =>
          Math.min(100, counts.exports - i * 100),
        ),
      ])
      expect(await owner.start(f.org, null, INPUT)).toStrictEqual(result.runs[0])
      expect(await owner.prepareNormalization(lease)).toMatchObject({
        status: 'NORMALIZED',
        next: null,
      })
      expect(await state(f.org)).toStrictEqual(result)
      await expect(
        owner.readNormalizedPage(lease, {
          kind: 'MAPPINGS',
          afterOrdinal: BigInt(Math.ceil(counts.mappings / 100) * 100),
        }),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(
        await db().fortnoxReadContextSnapshot.count({ where: { organizationId: f.org } }),
      ).toBe(0)
    },
  )

  it('mappingfacit bevarar tomma strängar, Unicode och flera kopplingar till samma fastighet', async () => {
    const f = await fixture(),
      secondId = randomUUID(),
      name = 'Åhus e\u0301/é "Ö"\n'
    await db().property.update({ where: { id: f.propertyId }, data: { name: '' } })
    await db().property.create({
      data: {
        id: secondId,
        organizationId: f.org,
        name,
        propertyDesignation: `SYNTHETIC ${secondId}`,
        type: 'RESIDENTIAL',
        street: 'Testgata',
        city: 'Teststad',
        postalCode: '11111',
        totalArea: '100.00',
      },
    })
    await db().fortnoxDimensionMapping.createMany({
      data: [
        { organizationId: f.org, propertyId: f.propertyId, dimensionType: 'COST_CENTER', code: '' },
        { organizationId: f.org, propertyId: secondId, dimensionType: 'COST_CENTER', code: 'A' },
        { organizationId: f.org, propertyId: secondId, dimensionType: 'PROJECT', code: " Å' " },
      ],
    })
    const { lease } = await start(f),
      owner = service()
    await owner.prepareNormalization(lease)
    const receipt = await page(owner, lease, 'MAPPINGS')
    expect(
      await owner.readNormalizedPage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n }),
    ).toStrictEqual({
      ...receipt,
      items: [
        { type: 'COST_CENTER', code: '', propertyId: f.propertyId, propertyName: '' },
        { type: 'COST_CENTER', code: 'A', propertyId: secondId, propertyName: name },
        { type: 'PROJECT', code: " Å' ", propertyId: secondId, propertyName: name },
      ],
    })
  })

  it('handfacit: första kontoordning, dedup, revision0/-7/sträng och säkra tal utan koercion', async () => {
    const f = await fixture(0, [
      {
        number: 42,
        draft: {
          kontomappning: { revision: 7 },
          provenance: {
            lines: [
              line,
              { localAccountNumber: 1930, externalAccountNumber: 1940 },
              { localAccountNumber: 5160, externalAccountNumber: 5171 },
              line,
            ],
          },
        },
        source: {
          revision: 7,
          perMal: [
            { account: 5171, sources: [5170, 5160] },
            { account: 1940, sources: [1930] },
          ],
        },
      },
      ...[0, -7, '7'].map(
        (revision, i): ExportSeed => ({
          number: 43 + i,
          draft: { kontomappning: { revision }, provenance: { lines: [line] } },
          source: {
            revision: i === 0 ? 0 : i === 1 ? -7 : null,
            perMal: [{ account: 5171, sources: [5170] }],
          },
        }),
      ),
      {
        number: 46,
        draft: {
          provenance: {
            lines: [
              { localAccountNumber: '5170', externalAccountNumber: 5171 },
              { localAccountNumber: 5170, externalAccountNumber: '5171' },
              { localAccountNumber: 5170.5, externalAccountNumber: 5171 },
              { localAccountNumber: 9007199254740992, externalAccountNumber: 5171 },
              { localAccountNumber: 5170, externalAccountNumber: 9007199254740992 },
              line,
            ],
          },
        },
        source: { revision: null, perMal: [{ account: 5171, sources: [5170] }] },
      },
    ])
    const { lease } = await start(f),
      owner = service()
    await owner.prepareNormalization(lease)
    const receipt = await page(owner, lease, 'OWN_EXPORTS')
    expect(
      await owner.readNormalizedPage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 0n }),
    ).toStrictEqual({ ...receipt, items: f.exportItems })
  })

  it('saknad/null/tom/text/nested lines ger tom proveniens; [[null]] plattas aldrig till en null-row', async () => {
    const drafts: Prisma.InputJsonValue[] = [
      {},
      { provenance: { lines: null } },
      { provenance: { lines: [] } },
      { provenance: { lines: 'abc' } },
      { provenance: { lines: [[null]] } },
      { provenance: { lines: ['text', 17, false, [], {}] } },
    ]
    const f = await fixture(
        0,
        drafts.map((draft) => ({ draft })),
      ),
      { lease } = await start(f),
      owner = service()
    await owner.prepareNormalization(lease)
    const receipt = await page(owner, lease, 'OWN_EXPORTS')
    expect(
      await owner.readNormalizedPage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 0n }),
    ).toStrictEqual({ ...receipt, items: f.exportItems })
    expect(f.exportItems.every((item) => item.revision === null && item.perMal.length === 0)).toBe(
      true,
    )
  })

  it('syntetisk förseglad lagringskälla, inte vanlig start: samma voucher100/101 bevarar båda journalerna', async () => {
    const source = { revision: 0, perMal: [{ account: 5171, sources: [5170] }] }
    const f = await fixture(),
      { run, rows, exportItems } = await historicalDuplicateStorage(f),
      owner = service(),
      lease = await owner.claim(f.org, run.id)
    if (!lease) throw new Error('Lagringsfixturen fick inget riktigt anspråk')
    expect(await db().fortnoxVoucherExport.count({ where: { organizationId: f.org } })).toBe(0)
    const raw = await db().fortnoxReadSourceExport.findMany({
      where: { captureId: run.id, organizationId: f.org },
      orderBy: { ordinal: 'asc' },
    })
    expect(raw.map((row) => row.journalEntryId)).toStrictEqual(
      rows.map((row) => row.journalEntryId),
    )
    expect(raw.map((row) => row.ordinal)).toStrictEqual(
      Array.from({ length: 101 }, (_, i) => BigInt(i + 1)),
    )
    expect(new Set(raw.map((row) => row.sourceId)).size).toBe(101)
    await owner.prepareNormalization(lease)
    await page(owner, lease, 'OWN_EXPORTS')
    await page(owner, lease, 'OWN_EXPORTS', 100n)
    const first = await owner.readNormalizedPage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 0n })
    const last = await owner.readNormalizedPage(lease, { kind: 'OWN_EXPORTS', afterOrdinal: 100n })
    expect(first.itemCount).toBe(100)
    expect(last.itemCount).toBe(1)
    expect(first.digest).toBe(expectedDigest(f, run, 'OWN_EXPORTS', 0n, exportItems.slice(0, 100)))
    expect(last.digest).toBe(expectedDigest(f, run, 'OWN_EXPORTS', 100n, exportItems.slice(100)))
    expect([...first.items, ...last.items]).toStrictEqual(exportItems)
    expect(first.items[99]).toStrictEqual({
      voucher: '1|L|42',
      journalEntryId: rows[99]!.journalEntryId,
      ...source,
    })
    expect(last.items).toStrictEqual([
      { voucher: '1|L|42', journalEntryId: rows[100]!.journalEntryId, ...source },
    ])
    expect(rows[99]!.journalEntryId).not.toBe(rows[100]!.journalEntryId)
  })

  it.each([
    { name: 'icke-itererbara lines', seed: { draft: { provenance: { lines: {} } } } },
    { name: 'giltig rad sedan null-row', seed: { draft: { provenance: { lines: [line, null] } } } },
    {
      name: 'mål999',
      seed: {
        draft: {
          provenance: { lines: [{ localAccountNumber: 5170, externalAccountNumber: 999 }] },
        },
      },
    },
    { name: 'ogiltig voucher', seed: { series: 'SECRET_BAD-SERIES', draft: {} } },
  ] satisfies Array<{ name: string; seed: ExportSeed }>)(
    '$name på andra sidan: ingen halvskriven sida, beständig FAILED och fast maskerat fel',
    async ({ seed }) => {
      const f = await fixture(0, [...emptyExports(101), seed]),
        { run, lease } = await start(f),
        owner = service()
      await owner.prepareNormalization(lease)
      await page(owner, lease, 'OWN_EXPORTS')
      const before = await state(f.org)
      const failure: unknown = await page(owner, lease, 'OWN_EXPORTS', 100n).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(ConflictException)
      if (!(failure instanceof ConflictException))
        throw new Error('Avsett INVALID_SOURCE-fel saknas')
      expect(failure.message).toBe(INVALID_SOURCE)
      expect(JSON.stringify(failure.getResponse())).not.toContain('SECRET_BAD')
      const after = await durable(f.org)
      expect(after.stages).toStrictEqual(before.stages)
      expect(after.pages).toStrictEqual(before.pages)
      expect(after.stages[0]).toMatchObject({
        status: 'NORMALIZING',
        exportsDone: 100,
        exportCount: 102,
      })
      expect(after.runs[0]).toMatchObject({
        id: run.id,
        status: 'FAILED',
        reason: INVALID_SOURCE,
        completedAt: expect.any(Date),
        claimVersion: lease.claimVersion,
        claimToken: null,
        leaseUntil: null,
        frozenContext: null,
        catalog: null,
        summary: null,
        rows: null,
      })
      await expect(page(owner, lease, 'OWN_EXPORTS', 100n)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(await state(f.org)).toStrictEqual(after)
    },
  )

  it('förlorat sidsvar och ny process/lease replayar samma kvitto och fortsätter den frysta källan', async () => {
    const f = await fixture(101, emptyExports(1)),
      { run, lease } = await start(f),
      owner = service()
    await owner.prepareNormalization(lease)
    const lost = new Error('SYNTHETIC_LOST_PAGE_RECEIPT')
    let issued: Awaited<ReturnType<typeof page>> | undefined
    await expect(
      (async () => {
        issued = await page(owner, lease, 'MAPPINGS')
        throw lost // Faktisk sidcommit har lyckats innan kvittot tappas hos callern.
      })(),
    ).rejects.toBe(lost)
    if (!issued) throw new Error('Den beständiga sidans tappade kvitto saknas')
    const first = issued,
      before = await state(f.org)
    await db().property.update({ where: { id: f.propertyId }, data: { name: 'LATER_LIVE_NAME' } })
    await db().fortnoxVoucherExport.update({
      where: { journalEntryId: f.rows[0]!.journalEntryId },
      data: { draft: { provenance: { lines: [null] } } },
    })
    await owner.release(lease)
    const c = await controlled()
    try {
      const restarted = service(c.client),
        nextLease = await restarted.claim(f.org, run.id)
      if (!nextLease) throw new Error('Ny legitim lease saknas')
      const claimedState = await state(f.org)
      expect(await page(restarted, nextLease, 'MAPPINGS')).toStrictEqual(first)
      expect(
        await restarted.readNormalizedPage(nextLease, { kind: 'MAPPINGS', afterOrdinal: 0n }),
      ).toStrictEqual({ ...first, items: f.mappingItems.slice(0, 100) })
      await expect(page(restarted, lease, 'MAPPINGS')).rejects.toBeInstanceOf(ConflictException)
      expect(await state(f.org)).toStrictEqual(claimedState)
      expect(await restarted.start(f.org, null, INPUT)).toStrictEqual(claimedState.runs[0])
      await page(restarted, nextLease, 'MAPPINGS', 100n)
      const last = await page(restarted, nextLease, 'OWN_EXPORTS')
      expect(
        await restarted.readNormalizedPage(nextLease, { kind: 'OWN_EXPORTS', afterOrdinal: 0n }),
      ).toStrictEqual({ ...last, items: f.exportItems })
      expect((await state(f.org)).pages.find((row) => row.id === first.pageId)).toStrictEqual(
        before.pages[0],
      )
      expect(await restarted.prepareNormalization(nextLease)).toMatchObject({
        status: 'NORMALIZED',
        next: null,
      })
    } finally {
      await c.client.$disconnect()
    }
  })

  it('prepare krävs; fria fält, fel kind/position och främmande org kan inte skapa eller läsa stage', async () => {
    const a = await fixture(101, emptyExports(1)),
      b = await fixture(),
      { run, lease } = await start(a)
    const other = await start(b),
      owner = service()
    await expect(page(owner, lease, 'MAPPINGS')).rejects.toBeInstanceOf(ConflictException)
    await expect(
      owner.readNormalizedPage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect((await state(a.org)).stages).toStrictEqual([])
    await owner.prepareNormalization(lease)
    const before = await state(a.org),
      foreignBefore = await state(b.org)
    await expect(page(owner, lease, 'OWN_EXPORTS')).rejects.toBeInstanceOf(ConflictException)
    await expect(page(owner, lease, 'MAPPINGS', 100n)).rejects.toBeInstanceOf(ConflictException)
    await expect(page(owner, lease, 'MAPPINGS', 1n)).rejects.toBeInstanceOf(BadRequestException)
    await expect(page(owner, lease, 'MAPPINGS', -100n)).rejects.toBeInstanceOf(BadRequestException)
    const extra = { expectedKind: 'MAPPINGS' as const, expectedAfterOrdinal: 0n, items: [] }
    await expect(owner.normalizePage(lease, extra)).rejects.toBeInstanceOf(BadRequestException)
    for (const foreign of [
      { ...lease, organizationId: b.org },
      { ...other.lease, runId: run.id },
    ]) {
      await expect(owner.prepareNormalization(foreign)).rejects.toBeInstanceOf(ConflictException)
      await expect(page(owner, foreign, 'MAPPINGS')).rejects.toBeInstanceOf(ConflictException)
      await expect(
        owner.readNormalizedPage(foreign, { kind: 'MAPPINGS', afterOrdinal: 0n }),
      ).rejects.toBeInstanceOf(ConflictException)
    }
    expect(await state(a.org)).toStrictEqual(before)
    expect(await state(b.org)).toStrictEqual(foreignBefore)
  })

  it.each([0n, 100n])(
    'två samtidiga sidorder after0/after%s får korrekt INSERT+replay eller seriella steg',
    async (secondAfter) => {
      const f = await fixture(101),
        { lease } = await start(f)
      await service().prepareNormalization(lease)
      const a = await controlled(),
        b = await controlled(),
        inserted = deferred(),
        resume = deferred()
      a.hooks.after = async (params, result) => {
        if (params.model !== 'FortnoxReadNormalizationPage' || params.action !== 'create') return
        expect(params.runInTransaction).toBe(true)
        expect(result).toMatchObject({ afterOrdinal: 0n, itemCount: 100 })
        inserted.resolve()
        await resume.promise
      }
      const first = page(service(a.client), lease, 'MAPPINGS'),
        firstDone = Promise.allSettled([first])
      let secondDone: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        await Promise.race([
          inserted.promise,
          first.then(() => {
            throw new Error('INSERT-barriären missades')
          }),
        ])
        expect((await state(f.org)).pages).toHaveLength(0)
        const second = page(service(b.client), lease, 'MAPPINGS', secondAfter)
        secondDone = Promise.allSettled([second])
        await waitBlocked(b.pid, a.pid)
        resume.resolve()
        const firstReceipt = await first,
          secondReceipt = await second
        if (secondAfter === 0n) expect(secondReceipt).toStrictEqual(firstReceipt)
        else expect(secondReceipt).toMatchObject({ afterOrdinal: 100n, itemCount: 1 })
        const after = await durable(f.org)
        expect(after.pages).toHaveLength(secondAfter === 0n ? 1 : 2)
        expect(after.stages[0]).toMatchObject({
          mappingsDone: secondAfter === 0n ? 100 : 101,
          status: secondAfter === 0n ? 'NORMALIZING' : 'NORMALIZED',
        })
      } finally {
        resume.resolve()
        await firstDone
        if (secondDone) await secondDone
        await a.client.$disconnect()
        await b.client.$disconnect()
      }
    },
  )

  it('framtida after100 som får låset först nekas; efterföljande after0 fungerar', async () => {
    const f = await fixture(101),
      { lease } = await start(f)
    await service().prepareNormalization(lease)
    const a = await controlled(),
      b = await controlled(),
      held = deferred(),
      resume = deferred()
    let reached = false
    a.hooks.after = async (params) => {
      if (
        reached ||
        params.model !== 'FortnoxReadNormalizationStage' ||
        params.action !== 'findUnique'
      )
        return
      reached = true
      held.resolve()
      await resume.promise
    }
    const first = page(service(a.client), lease, 'MAPPINGS', 100n),
      firstDone = Promise.allSettled([first])
    let secondDone: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error('Stagebarriären missades')
        }),
      ])
      const second = page(service(b.client), lease, 'MAPPINGS')
      secondDone = Promise.allSettled([second])
      await waitBlocked(b.pid, a.pid)
      resume.resolve()
      await expect(first).rejects.toBeInstanceOf(ConflictException)
      expect(await second).toMatchObject({ afterOrdinal: 0n, itemCount: 100 })
      expect((await durable(f.org)).stages[0]).toMatchObject({
        mappingsDone: 100,
        status: 'NORMALIZING',
      })
    } finally {
      resume.resolve()
      await firstDone
      if (secondDone) await secondDone
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it('fel efter verklig pageINSERT rullar tillbaka både sida och SQL-avancerad header', async () => {
    const f = await fixture(1),
      { lease } = await start(f)
    await service().prepareNormalization(lease)
    const before = await state(f.org),
      c = await controlled(),
      failure = new Error('SYNTHETIC_AFTER_REAL_PAGE_INSERT')
    let inserted = false
    c.hooks.after = async (params, result) => {
      if (params.model !== 'FortnoxReadNormalizationPage' || params.action !== 'create') return
      expect(params.runInTransaction).toBe(true)
      expect(result).toMatchObject({ itemCount: 1, afterOrdinal: 0n })
      inserted = true
      throw failure
    }
    try {
      await expect(page(service(c.client), lease, 'MAPPINGS')).rejects.toBe(failure)
      expect(inserted).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
      expect((await state(f.org)).runs[0]!.status).toBe('RUNNING')
      await page(service(), lease, 'MAPPINGS')
      expect((await durable(f.org)).stages[0]).toMatchObject({
        mappingsDone: 1,
        status: 'NORMALIZED',
      })
    } finally {
      await c.client.$disconnect()
    }
  })

  it('SQL sidINSERT gör räknare och slutflagga i samma statement; fångat JS-fel kan inte lämna halvprogress', async () => {
    const f = await fixture(1),
      { run, lease } = await start(f)
    await service().prepareNormalization(lease)
    await tx(async (c) => {
      expect(await insertRawPage(c, f, run.id, 'MAPPINGS', 0n, f.mappingItems)).toBe(1)
      // Läs inom exakt samma caller-Tx, före COMMIT och utan separat headerUPDATE.
      expect(
        await c.fortnoxReadNormalizationStage.findUniqueOrThrow({ where: { id: run.id } }),
      ).toMatchObject({ mappingsDone: 1, status: 'NORMALIZED', normalizedAt: expect.any(Date) })
      expect(await c.fortnoxReadNormalizationPage.count({ where: { stageId: run.id } })).toBe(1)
      try {
        throw new Error('SYNTHETIC_CAUGHT_AFTER_INSERT')
      } catch {
        /* Caller väljer att committa. */
      }
    })
    const after = await durable(f.org)
    expect(after.pages).toHaveLength(1)
    expect(after.stages[0]).toMatchObject({ mappingsDone: 1, status: 'NORMALIZED' })
    expect(
      (await service().readNormalizedPage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n })).items,
    ).toStrictEqual(f.mappingItems)
  })

  it('leaseutgång under arbetet stoppas av verklig SQL-grind före pageINSERT, utan INVALID_SOURCE', async () => {
    const f = await fixture(1),
      run = await service().start(f.org, null, INPUT),
      c = await controlled()
    try {
      const owner = new ShortLeaseService(db()),
        lease = await owner.claim(f.org, run.id)
      if (!lease) throw new Error('Kort lease saknas')
      await owner.prepareNormalization(lease)
      const before = await state(f.org)
      let reached = false
      c.hooks.before = async (params) => {
        if (params.model !== 'FortnoxReadNormalizationPage' || params.action !== 'create') return
        reached = true
        await expired(lease)
      }
      await expect(page(service(c.client), lease, 'MAPPINGS')).rejects.toThrow(
        'Normalization requires the current source run lease',
      )
      expect(reached).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('verkligt PostgreSQL-fel efter faktisk råkällsläsning propagerar utan INVALID_SOURCE', async () => {
    const f = await fixture(0, emptyExports(1)),
      { lease } = await start(f),
      owner = service()
    await owner.prepareNormalization(lease)
    const before = await state(f.org),
      c = await controlled()
    let reached = false
    c.hooks.after = async (params, result) => {
      if (
        params.action !== 'queryRaw' ||
        !Array.isArray(result) ||
        !record(result[0]) ||
        !('accountSource' in result[0])
      )
        return
      expect(result[0]).toMatchObject({ organizationId: f.org, ordinal: 1n })
      reached = true
      // Avsiktlig riktig SQL-fault från separat anslutning efter den verkliga
      // råfrågan; ingen fabricerad Prisma-error eller ändrad produkt-SQL.
      await db().$queryRaw`SELECT 1 / 0 AS synthetic_database_fault`
    }
    try {
      await expect(page(service(c.client), lease, 'OWN_EXPORTS')).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '22012' },
      })
      expect(reached).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('utgång efter ogiltig råsida men före INVALID_SOURCE-stopp får inte terminalisera runen', async () => {
    const f = await fixture(0, [{ draft: { provenance: { lines: [null] } } }])
    const run = await service().start(f.org, null, INPUT),
      c = await controlled()
    try {
      const owner = new ShortLeaseService(db()),
        lease = await owner.claim(f.org, run.id)
      if (!lease) throw new Error('Kort lease saknas')
      await owner.prepareNormalization(lease)
      const before = await state(f.org)
      let reached = false
      c.hooks.after = async (params, result) => {
        if (
          params.action !== 'queryRaw' ||
          !Array.isArray(result) ||
          !record(result[0]) ||
          !('accountSource' in result[0])
        )
          return
        expect(result[0]).toMatchObject({
          organizationId: f.org,
          ordinal: 1n,
          accountSource: { provenance: { lines: [null] } },
        })
        reached = true
        await expired(lease)
      }
      await expect(page(service(c.client), lease, 'OWN_EXPORTS')).rejects.toThrow(
        'Läsanspråket har upphört',
      )
      expect(reached).toBe(true)
      expect(await durable(f.org)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('även tom0/0 stage kräver verklig aktiv lease i tjänst och direkt SQL', async () => {
    const f = await fixture(),
      owner = service(),
      run = await owner.start(f.org, null, INPUT)
    await sqlReject(
      f.org,
      (c) => c.$executeRaw`
      INSERT INTO "FortnoxReadNormalizationStage" (id,"organizationId","runId","sourceCaptureId","requestHash","mappingCount","exportCount",status,"normalizedAt")
      VALUES (${run.id},${f.org},${run.id},${run.id},${run.requestHash},0,0,'NORMALIZED',clock_timestamp())`,
    )
    const short = new ShortLeaseService(db()),
      lease = await short.claim(f.org, run.id)
    if (!lease) throw new Error('Kort lease saknas')
    await expired(lease)
    await expect(owner.prepareNormalization(lease)).rejects.toBeInstanceOf(ConflictException)
    await sqlReject(
      f.org,
      (c) => c.$executeRaw`
      INSERT INTO "FortnoxReadNormalizationStage" (id,"organizationId","runId","sourceCaptureId","requestHash","mappingCount","exportCount",status,"normalizedAt")
      VALUES (${run.id},${f.org},${run.id},${run.id},${run.requestHash},0,0,'NORMALIZED',clock_timestamp())`,
    )
    const next = await owner.claim(f.org, run.id)
    if (!next) throw new Error('Ny giltig lease saknas')
    expect(await owner.prepareNormalization(next)).toStrictEqual({
      stageId: run.id,
      status: 'NORMALIZED',
      mappingCount: 0,
      exportCount: 0,
      mappingsDone: 0,
      exportsDone: 0,
      next: null,
    })
    expect((await durable(f.org)).pages).toHaveLength(0)
  })

  it.each(['digest', 'schema', 'missing'] as const)(
    'korrupt faktisk sidläsretur (%s) avvisas utan terminalisering eller lagringsbypass',
    async (kind) => {
      const f = await fixture(1),
        { run, lease } = await start(f),
        owner = service()
      await owner.prepareNormalization(lease)
      await page(owner, lease, 'MAPPINGS')
      const before = await state(f.org),
        c = await controlled()
      let disturbed = false
      c.hooks.transform = (params, result) => {
        if (params.model !== 'FortnoxReadNormalizationPage' || params.action !== 'findUnique')
          return result
        if (!record(result) || !Array.isArray(result.items))
          throw new Error('Verkligt sparad sida saknas före felinjektion')
        disturbed = true
        if (kind === 'missing') return null
        if (kind === 'digest') return { ...result, digest: '0'.repeat(64) }
        const items = [{ ...f.mappingItems[0]!, unexpected: 'SYNTHETIC_RAW_FIELD' }]
        return { ...result, items, digest: expectedDigest(f, run, 'MAPPINGS', 0n, items) }
      }
      try {
        await expect(
          service(c.client).readNormalizedPage(lease, { kind: 'MAPPINGS', afterOrdinal: 0n }),
        ).rejects.toBeInstanceOf(ConflictException)
        await expect(page(service(c.client), lease, 'MAPPINGS')).rejects.toBeInstanceOf(
          ConflictException,
        )
        expect(disturbed).toBe(true)
        expect(await durable(f.org)).toStrictEqual(before)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it('stale anslutning stoppar ny sida men bevarar historisk stage vid en explicit ny start', async () => {
    const f = await fixture(101),
      { run, lease } = await start(f),
      owner = service()
    await owner.prepareNormalization(lease)
    await page(owner, lease, 'MAPPINGS')
    const before = await state(f.org)
    await db().fortnoxConnection.update({
      where: { organizationId: f.org },
      data: { generation: { increment: 1 } },
    })
    await expect(page(owner, lease, 'MAPPINGS', 100n)).rejects.toBeInstanceOf(ConflictException)
    const stopped = await durable(f.org)
    expect(stopped.stages).toStrictEqual(before.stages)
    expect(stopped.pages).toStrictEqual(before.pages)
    expect(stopped.runs[0]).toMatchObject({ status: 'FAILED', claimToken: null, leaseUntil: null })
    const next = await owner.start(f.org, null, INPUT)
    expect(next.id).not.toBe(run.id)
    expect((await state(f.org)).stages).toStrictEqual(before.stages)
    expect(
      await db().fortnoxReadNormalizationStage.findUnique({ where: { id: next.id } }),
    ).toBeNull()
  })

  it('SQL nekar hopp/fel kind/antal/FK och kan inte använda en äldre sida för falsk progress', async () => {
    const f = await fixture(201),
      other = await fixture(),
      { run, lease } = await start(f)
    await service().prepareNormalization(lease)
    await sqlReject(f.org, (c) =>
      insertRawPage(c, f, run.id, 'MAPPINGS', 100n, f.mappingItems.slice(100, 200)),
    )
    await sqlReject(f.org, (c) => insertRawPage(c, f, run.id, 'OWN_EXPORTS', 0n, []))
    await sqlReject(f.org, (c) =>
      insertRawPage(c, f, run.id, 'MAPPINGS', 0n, f.mappingItems.slice(0, 1)),
    )
    await sqlReject(f.org, (c) =>
      insertRawPage(c, f, run.id, 'MAPPINGS', 0n, f.mappingItems.slice(0, 100), { itemCount: 99 }),
    )
    await sqlReject(
      f.org,
      (c) =>
        insertRawPage(c, f, run.id, 'MAPPINGS', 0n, f.mappingItems.slice(0, 100), {
          organizationId: other.org,
        }),
      '23503',
    )
    await sqlReject(
      f.org,
      (c) => c.$executeRaw`
      INSERT INTO "FortnoxReadNormalizationPage" (id,"organizationId","stageId",kind,"afterOrdinal","itemCount",digest,items)
      VALUES (${randomUUID()},${f.org},${run.id},'MAPPINGS',0,100,${'a'.repeat(64)},NULL)`,
      '23502',
    )
    const firstItems = f.mappingItems.slice(0, 100)
    const digest = expectedDigest(f, run, 'MAPPINGS', 0n, firstItems)
    await sqlReject(
      f.org,
      (c) => c.$executeRaw`
      WITH inserted AS (
        INSERT INTO "FortnoxReadNormalizationPage" (id,"organizationId","stageId",kind,"afterOrdinal","itemCount",digest,items)
        VALUES (${randomUUID()},${f.org},${run.id},'MAPPINGS',0,100,${digest},${JSON.stringify(firstItems)}::jsonb)
        RETURNING "stageId"
      )
      UPDATE "FortnoxReadNormalizationStage" s SET "mappingsDone"=100
      FROM inserted WHERE s.id=inserted."stageId"`,
    )
    await page(service(), lease, 'MAPPINGS')
    await sqlReject(
      f.org,
      (c) => c.$executeRaw`
      WITH old_page AS (SELECT id FROM "FortnoxReadNormalizationPage" WHERE "stageId"=${run.id} AND "afterOrdinal"=0)
      UPDATE "FortnoxReadNormalizationStage" s SET "mappingsDone"=200
      FROM old_page WHERE s.id=${run.id}`,
    )
    await sqlReject(
      f.org,
      (c) =>
        c.$executeRaw`UPDATE "FortnoxReadNormalizationStage" SET "mappingsDone"=201,status='NORMALIZED',"normalizedAt"=clock_timestamp() WHERE id=${run.id}`,
    )
    await sqlReject(
      f.org,
      (c) =>
        c.$executeRaw`UPDATE "FortnoxReadNormalizationStage" SET "mappingCount"=NULL WHERE id=${run.id}`,
    )
    expect((await durable(f.org)).stages[0]).toMatchObject({
      mappingsDone: 100,
      mappingCount: 201,
      status: 'NORMALIZING',
    })
  })

  it('extra INSERT som väntar på sista sidan nekas efter NORMALIZED-commit', async () => {
    const f = await fixture(1),
      { run, lease } = await start(f)
    await service().prepareNormalization(lease)
    const a = await controlled(),
      b = await controlled(),
      inserted = deferred(),
      resume = deferred()
    a.hooks.after = async (params) => {
      if (params.model !== 'FortnoxReadNormalizationPage' || params.action !== 'create') return
      inserted.resolve()
      await resume.promise
    }
    const finish = page(service(a.client), lease, 'MAPPINGS'),
      finished = Promise.allSettled([finish])
    let extraDone: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await Promise.race([
        inserted.promise,
        finish.then(() => {
          throw new Error('Sista INSERT-barriären missades')
        }),
      ])
      const extra = tx(
        (c) => insertRawPage(c, f, run.id, 'MAPPINGS', 100n, f.mappingItems),
        b.client,
      )
      extraDone = Promise.allSettled([extra])
      await waitBlocked(b.pid, a.pid)
      resume.resolve()
      await finish
      await expect(extra).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
      expect((await durable(f.org)).pages).toHaveLength(1)
      expect((await state(f.org)).stages[0]).toMatchObject({
        status: 'NORMALIZED',
        mappingsDone: 1,
      })
    } finally {
      resume.resolve()
      await finished
      if (extraDone) await extraDone
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it('SQL skyddar sida/header efter slutet och riktig orgcascade lämnar främmande stage orörd', async () => {
    const f = await fixture(1),
      other = await fixture(),
      { run, lease } = await start(f),
      foreign = await start(other)
    await service().prepareNormalization(lease)
    await page(service(), lease, 'MAPPINGS')
    await service().prepareNormalization(foreign.lease)
    const foreignBefore = await state(other.org)
    for (const statement of [
      Prisma.sql`UPDATE "FortnoxReadNormalizationPage" SET digest=digest WHERE "stageId"=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadNormalizationPage" SET digest=digest WHERE FALSE`,
      Prisma.sql`DELETE FROM "FortnoxReadNormalizationPage" WHERE "stageId"=${run.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadNormalizationStage" WHERE id=${run.id}`,
      Prisma.sql`UPDATE "FortnoxReadNormalizationStage" SET "mappingsDone"=0,status='NORMALIZING',"normalizedAt"=NULL WHERE id=${run.id}`,
      Prisma.sql`TRUNCATE "FortnoxReadNormalizationPage"`,
      Prisma.sql`TRUNCATE "FortnoxReadNormalizationStage" CASCADE`,
    ])
      await sqlReject(f.org, (c) => c.$executeRaw(statement))
    expect(await db().fortnoxReadNormalizationPage.count({ where: { stageId: run.id } })).toBe(1)
    await db().organization.delete({ where: { id: f.org } })
    orgs.delete(f.org)
    expect(await state(f.org)).toStrictEqual({ runs: [], stages: [], pages: [] })
    expect(await state(other.org)).toStrictEqual(foreignBefore)
  })
})
