/**
 * Snapshotlagring mot riktig PostgreSQL. Egna syntetiska v1-körningar skapas
 * genom befintlig start; endast deras frysta fixture-JSON fylls före kopiering.
 * Ingen ny v2-tjänst, driver, HTTP, token eller extern Fortnox används.
 * Sidfacit behåller inmatningsordning och dubletter utan efterföljande sortering.
 */
import { createHash, randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import {
  CheckpointContextSchema,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'
import { FortnoxReadCheckpointService } from './fortnox-read-checkpoint.service'
import {
  freezeCheckpointContext,
  readCheckpointContextHeader,
  readCheckpointContextPage,
  verifyCheckpointContextSnapshot,
} from './fortnox-read-context-snapshot'

type Context = ReturnType<typeof CheckpointContextSchema.parse>
type Kind = 'MAPPINGS' | 'OWN_EXPORTS'
// Oberoende testimplementation av det låsta digestformatet; importerar inte
// produktens hash-/page-/rootfunktioner och sorterar aldrig någon array.
function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, orderedJson(item)]),
    )
  }
  return value
}
function hash(value: unknown): string {
  const text = JSON.stringify(orderedJson(value))
  if (text === undefined) throw new Error('Testfacit kräver JSON')
  return createHash('sha256').update(text).digest('hex')
}
const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5160, 5170],
}

function isolatedDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Snapshotprovet kräver en uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const name = decodeURIComponent(url.pathname.slice(1))
  const synthetic = name.endsWith('_test') || (process.env.CI === 'true' && name === 'eken_dev')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !local || !synthetic) {
    throw new Error('Snapshotprovet tillåter bara lokal *_test eller CI:s lokala eken_dev')
  }
  url.searchParams.set('connection_limit', '4')
  return url.toString()
}

function contextWithCount(count: number): Context {
  return {
    version: 1,
    input: INPUT,
    mappings: Array.from({ length: count }, (_, index) => ({
      type: index % 2 === 0 ? 'PROJECT' : 'COST_CENTER',
      code: `kod-${index}`,
      propertyId: `synthetic-property-${index}`,
      propertyName: `Syntetiskt hus ${index}`,
    })),
    ownExports: Array.from({ length: count }, (_, index) => ({
      voucher: `1|L|${index + 1}`,
      journalEntryId: `synthetic-journal-${index}`,
      revision: index % 2 === 0 ? null : 7,
      perMal: [
        { account: 5171, sources: [5170, 5160] },
        { account: 1940, sources: [1930] },
      ],
    })),
  }
}

describe('Fryst Fortnox-kontext som separata snapshots mot riktig PostgreSQL', () => {
  let prisma: PrismaClient | undefined
  let capturedSql: string[] | null = null
  const organizations = new Set<string>()

  function db(): PrismaClient {
    if (!prisma) throw new Error('Snapshotprovets PostgreSQL-fixture har inte startats')
    return prisma
  }

  function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return db().$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  }

  async function fixture(context = contextWithCount(0)) {
    const organizationId = randomUUID()
    await db().organization.create({
      data: {
        id: organizationId,
        name: `synthetic-context-snapshot-${organizationId}`,
        email: `${organizationId}@example.invalid`,
        street: 'Syntetisk testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    organizations.add(organizationId)
    const connection = await db().fortnoxConnection.create({
      data: {
        organizationId,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 900001,
        fortnoxOrgNumber: 'SYNTHETIC_ORG_NUMBER',
      },
    })
    const service = new FortnoxReadCheckpointService(db() as unknown as PrismaService)
    const run = await service.start(organizationId, null, INPUT)
    // Primitive-underlaget är redan fryst v1-data, inte live-mappningar/exporter.
    // Parsern fastställer att vår syntetiska källform är tillåten före DB-skrivning.
    const validated = CheckpointContextSchema.parse(context)
    await db().fortnoxReadRun.update({
      where: { id: run.id, organizationId },
      data: { frozenContext: validated },
    })
    const before = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } })
    return { organizationId, runId: run.id, connection, context: validated, before }
  }

  async function stored(organizationId: string, runId: string) {
    const header = await db().fortnoxReadContextSnapshot.findUniqueOrThrow({
      where: { runId },
    })
    expect(header.organizationId).toBe(organizationId)
    const pages = await db().fortnoxReadContextPage.findMany({
      where: { organizationId, snapshotId: header.id },
      orderBy: [{ kind: 'asc' }, { page: 'asc' }],
    })
    return { header, pages }
  }

  function snapshotOracle(f: Awaited<ReturnType<typeof fixture>>, snapshotId: string) {
    const connection = {
      id: f.connection.id,
      generation: 0,
      databaseNumber: 900001,
      orgNumber: 'SYNTHETIC_ORG_NUMBER',
    }
    const sourceDigest = hash(f.context)
    const binding = hash({
      snapshotId,
      organizationId: f.organizationId,
      runId: f.runId,
      version: 1,
      input: INPUT,
      sourceDigest,
      connection,
    })
    const collections: Record<Kind, { itemCount: number; pageCount: number; root: string }> = {
      MAPPINGS: {
        itemCount: f.context.mappings.length,
        pageCount: 0,
        root: hash({ version: 1, binding, kind: 'MAPPINGS' }),
      },
      OWN_EXPORTS: {
        itemCount: f.context.ownExports.length,
        pageCount: 0,
        root: hash({ version: 1, binding, kind: 'OWN_EXPORTS' }),
      },
    }
    const pages: Prisma.FortnoxReadContextPageCreateManyInput[] = []
    for (const kind of ['MAPPINGS', 'OWN_EXPORTS'] as const) {
      const values = kind === 'MAPPINGS' ? f.context.mappings : f.context.ownExports
      for (let page = 1; (page - 1) * 100 < values.length; page++) {
        const items = values.slice((page - 1) * 100, page * 100)
        const digest = hash({ version: 1, binding, kind, page, itemCount: items.length, items })
        pages.push({
          organizationId: f.organizationId,
          snapshotId,
          kind,
          page,
          itemCount: items.length,
          digest,
          items,
        })
        collections[kind].root = hash({
          previousRoot: collections[kind].root,
          page,
          itemCount: items.length,
          digest,
        })
        collections[kind].pageCount++
      }
    }
    const manifest = { version: 1, input: INPUT, sourceDigest, connection, collections }
    const header = { id: snapshotId, organizationId: f.organizationId, runId: f.runId, manifest }
    return { ...header, digest: hash(header), binding, pages }
  }

  beforeAll(async () => {
    const client = new PrismaClient({
      datasources: { db: { url: isolatedDatabaseUrl() } },
      log: [{ emit: 'event', level: 'query' }],
    })
    client.$on('query', (event) => {
      capturedSql?.push(event.query)
    })
    prisma = client
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
      throw new AggregateError(failures, 'Kunde inte städa snapshotprovets egna fixturer')
  })

  it('KANARIEFÅGEL: använder uttrycklig isolerad PostgreSQL utan skip', async () => {
    const name = decodeURIComponent(new URL(isolatedDatabaseUrl()).pathname.slice(1))
    const rows = await db().$queryRaw<Array<{ database: string }>>(
      Prisma.sql`SELECT current_database() AS database`,
    )
    expect(rows).toStrictEqual([{ database: name }])
  })

  it.each([
    { count: 0, pageCounts: [] },
    { count: 1, pageCounts: [1] },
    { count: 100, pageCounts: [100] },
    { count: 101, pageCounts: [100, 1] },
    { count: 201, pageCounts: [100, 100, 1] },
  ])(
    '$count poster behåller exakt sidgräns/ordning och lämnar hela v1-körningen orörd',
    async ({ count, pageCounts }) => {
      const f = await fixture(contextWithCount(count))
      const header = await transaction((tx) =>
        freezeCheckpointContext(tx, f.organizationId, f.runId),
      )
      expect(header).toMatchObject({ organizationId: f.organizationId, runId: f.runId })
      expect(header.sealedAt).toBeInstanceOf(Date)
      const persisted = await stored(f.organizationId, f.runId)
      expect(header).toStrictEqual(persisted.header)
      const oracle = snapshotOracle(f, header.id)
      expect(header.manifest).toStrictEqual(oracle.manifest)
      expect(header.digest).toBe(oracle.digest)
      for (const expected of oracle.pages) {
        expect(
          persisted.pages.find(
            (page) => page.kind === expected.kind && page.page === expected.page,
          ),
        ).toMatchObject(expected)
      }
      expect(header.manifest).toMatchObject({
        version: 1,
        input: INPUT,
        connection: {
          id: f.connection.id,
          generation: 0,
          databaseNumber: 900001,
          orgNumber: 'SYNTHETIC_ORG_NUMBER',
        },
        collections: {
          MAPPINGS: { itemCount: count, pageCount: pageCounts.length },
          OWN_EXPORTS: { itemCount: count, pageCount: pageCounts.length },
        },
      })

      for (const kind of ['MAPPINGS', 'OWN_EXPORTS'] as const) {
        const expected = kind === 'MAPPINGS' ? f.context.mappings : f.context.ownExports
        expect(
          persisted.pages.filter((page) => page.kind === kind).map((page) => page.itemCount),
        ).toStrictEqual(pageCounts)
        const actual: unknown[] = []
        for (let index = 0; index < pageCounts.length; index++) {
          const page = await transaction((tx) =>
            readCheckpointContextPage(tx, f.organizationId, f.runId, kind, index + 1),
          )
          expect(page).toStrictEqual({
            items: expected.slice(index * 100, index * 100 + pageCounts[index]!),
            nextPage: index + 1 < pageCounts.length ? index + 2 : null,
          })
          actual.push(...page.items)
        }
        expect(actual).toStrictEqual(expected)
        await expect(
          transaction((tx) =>
            readCheckpointContextPage(tx, f.organizationId, f.runId, kind, pageCounts.length + 1),
          ),
        ).resolves.toStrictEqual({ items: [], nextPage: null })
      }
      await expect(
        transaction((tx) => readCheckpointContextHeader(tx, f.organizationId, f.runId)),
      ).resolves.toStrictEqual(header)
      await expect(
        transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId)),
      ).resolves.toStrictEqual(header)
      expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).toStrictEqual(
        f.before,
      )
    },
  )

  it('bevarar blandade typer, samma voucher, nullrevision och dubbletter över sidgränsen utan ny normalisering', async () => {
    const source = contextWithCount(101)
    const mapping: Context['mappings'][number] = {
      type: 'PROJECT',
      code: '2',
      propertyId: 'synthetic-shared-property',
      propertyName: 'Ågården',
    }
    const exported: Context['ownExports'][number] = {
      voucher: '1|L|10',
      journalEntryId: 'synthetic-shared-journal',
      revision: null,
      perMal: [
        { account: 5171, sources: [5170, 5160, 5170] },
        { account: 1940, sources: [1930] },
        { account: 5171, sources: [5160] },
      ],
    }
    source.mappings[0] = mapping
    source.mappings[1] = { ...mapping, type: 'COST_CENTER', code: '10' }
    source.mappings[2] = { ...mapping, type: 'COST_CENTER' }
    source.mappings[99] = mapping
    source.mappings[100] = mapping
    source.ownExports[0] = exported
    source.ownExports[1] = { ...exported, journalEntryId: 'synthetic-second-journal', revision: 7 }
    source.ownExports[99] = exported
    source.ownExports[100] = exported
    const f = await fixture(source)
    await transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId))
    const mappingOne = await transaction((tx) =>
      readCheckpointContextPage(tx, f.organizationId, f.runId, 'MAPPINGS', 1),
    )
    const mappingTwo = await transaction((tx) =>
      readCheckpointContextPage(tx, f.organizationId, f.runId, 'MAPPINGS', 2),
    )
    const exportsOne = await transaction((tx) =>
      readCheckpointContextPage(tx, f.organizationId, f.runId, 'OWN_EXPORTS', 1),
    )
    const exportsTwo = await transaction((tx) =>
      readCheckpointContextPage(tx, f.organizationId, f.runId, 'OWN_EXPORTS', 2),
    )
    expect([...mappingOne.items, ...mappingTwo.items]).toStrictEqual(source.mappings)
    expect([...exportsOne.items, ...exportsTwo.items]).toStrictEqual(source.ownExports)
    expect(mappingOne.items.slice(0, 3)).toStrictEqual([
      mapping,
      { ...mapping, type: 'COST_CENTER', code: '10' },
      { ...mapping, type: 'COST_CENTER' },
    ])
    expect(mappingOne.items[99]).toStrictEqual(mapping)
    expect(mappingTwo).toStrictEqual({ items: [mapping], nextPage: null })
    expect(exportsOne.items[99]).toStrictEqual(exported)
    expect(exportsTwo).toStrictEqual({ items: [exported], nextPage: null })
    await transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId))
  })

  it('samtidig freeze och senare replay ger samma beständiga header; ändrad källa får inte ersätta den', async () => {
    const f = await fixture(contextWithCount(101))
    const [first, concurrent] = await Promise.all([
      transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId)),
      transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId)),
    ])
    expect(concurrent).toStrictEqual(first)
    expect(await db().fortnoxReadContextSnapshot.count({ where: { runId: f.runId } })).toBe(1)
    const before = await stored(f.organizationId, f.runId)
    expect(before.pages).toHaveLength(4)
    await expect(
      transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId)),
    ).resolves.toStrictEqual(first)
    expect(await stored(f.organizationId, f.runId)).toStrictEqual(before)

    const changed = { ...f.context, mappings: [...f.context.mappings].reverse() }
    await db().fortnoxReadRun.update({ where: { id: f.runId }, data: { frozenContext: changed } })
    await expect(
      transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId)),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await stored(f.organizationId, f.runId)).toStrictEqual(before)
    // Läsaren är bunden till det förseglade underlaget, inte till en ny hel-JSON-läsning.
    await expect(
      transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId)),
    ).resolves.toStrictEqual(first)
  })

  it('caller-transaktionen rullar tillbaka även en helt skriven och förseglad snapshot', async () => {
    const f = await fixture(contextWithCount(101))
    let wroteAndSealed = false
    const injected = new Error('SYNTHETIC_SNAPSHOT_CALLER_ROLLBACK')
    await expect(
      transaction(async (tx) => {
        const header = await freezeCheckpointContext(tx, f.organizationId, f.runId)
        expect(header.sealedAt).toBeInstanceOf(Date)
        expect(await tx.fortnoxReadContextPage.count({ where: { snapshotId: header.id } })).toBe(4)
        wroteAndSealed = true
        throw injected
      }),
    ).rejects.toBe(injected)
    expect(wroteAndSealed).toBe(true)
    expect(await db().fortnoxReadContextSnapshot.count({ where: { runId: f.runId } })).toBe(0)
    expect(
      await db().fortnoxReadContextPage.count({ where: { organizationId: f.organizationId } }),
    ).toBe(0)
    expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).toStrictEqual(
      f.before,
    )
    await transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId))
    await transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId))
  })

  it.each([false, true])(
    'fel före försegling efter verkliga sidinsertar lämnar ingen snapshot (fångat i caller: %s)',
    async (catchInside) => {
      const f = await fixture(contextWithCount(101))
      let injectedAfterWrite = false
      let sealAttempted = false
      const injected = new Error('SYNTHETIC_SNAPSHOT_BEFORE_SEAL_AFTER_PAGE_WRITE')
      let callerCaught = false
      let sameTransactionObserved = false
      let afterCatchMarkerWritten = false
      const write = db().$transaction(async (tx) => {
        await tx.fortnoxReadRun.update({
          where: { id: f.runId },
          data: { reason: 'SYNTHETIC_BEFORE_FREEZE' },
        })
        expect((await tx.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).reason).toBe(
          'SYNTHETIC_BEFORE_FREEZE',
        )
        const seal = jest
          .spyOn(tx.fortnoxReadContextSnapshot, 'update')
          .mockImplementationOnce(() => {
            sealAttempted = true
            throw injected
          })
        try {
          await freezeCheckpointContext(tx, f.organizationId, f.runId)
        } catch (error) {
          expect(error).toBe(injected)
          expect(seal).toHaveBeenCalledTimes(1)
          expect(
            (await tx.fortnoxReadContextSnapshot.findUniqueOrThrow({ where: { runId: f.runId } }))
              .sealedAt,
          ).toBeNull()
          const rows = await tx.$queryRaw<
            Array<{ kind: string; xid: string; current: string }>
          >(Prisma.sql`
            SELECT 'run' AS kind, xmin::text AS xid, (txid_current() % 4294967296)::text AS "current"
              FROM "FortnoxReadRun" WHERE "id" = ${f.runId}
            UNION ALL
            SELECT 'snapshot', xmin::text, (txid_current() % 4294967296)::text
              FROM "FortnoxReadContextSnapshot" WHERE "runId" = ${f.runId}
            UNION ALL
            SELECT 'page', xmin::text, (txid_current() % 4294967296)::text
              FROM "FortnoxReadContextPage" WHERE "organizationId" = ${f.organizationId}
          `)
          expect(rows.filter((row) => row.kind === 'run')).toHaveLength(1)
          expect(rows.filter((row) => row.kind === 'snapshot')).toHaveLength(1)
          expect(rows.filter((row) => row.kind === 'page')).toHaveLength(4)
          expect(rows.every((row) => row.xid === row.current)).toBe(true)
          injectedAfterWrite = true
          sameTransactionObserved = true
          if (!catchInside) throw error
          callerCaught = true
          await tx.fortnoxReadRun.update({
            where: { id: f.runId },
            data: { reason: 'SYNTHETIC_AFTER_CATCH' },
          })
          expect(
            (await tx.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).reason,
          ).toBe('SYNTHETIC_AFTER_CATCH')
          afterCatchMarkerWritten = true
        } finally {
          seal.mockRestore()
        }
      }, PRISMA_DEFAULT_TX_LIMITS)
      // Första mätningen gav23/24: Prisma5.22 rapporterade fulfilled trots
      // PostgreSQL COMMIT23514→ROLLBACK. Separat psql/DB-observatör visade atomik.
      // Tillåt en framtida rättad enginefelsignal; kontraktet här är full rollback.
      const [outcome] = await Promise.allSettled([write])
      if (!outcome) throw new Error('Transaktionens settled-utfall saknas')
      if (!catchInside) {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') expect(outcome.reason).toBe(injected)
      }
      expect(sealAttempted).toBe(true)
      expect(injectedAfterWrite).toBe(true)
      expect(callerCaught).toBe(catchInside)
      expect(sameTransactionObserved).toBe(true)
      expect(afterCatchMarkerWritten).toBe(catchInside)
      const observer = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })
      try {
        await observer.$connect()
        expect(await observer.fortnoxReadContextSnapshot.count({ where: { runId: f.runId } })).toBe(
          0,
        )
        expect(
          await observer.fortnoxReadContextPage.count({
            where: { organizationId: f.organizationId },
          }),
        ).toBe(0)
        expect(
          await observer.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } }),
        ).toStrictEqual(f.before)
      } finally {
        await observer.$disconnect()
      }
    },
  )

  it('fångat fel före försegling efter verkliga sidinsertar ger SQL23514 vid IMMEDIATE, medan korrekt försegling passerar', async () => {
    const f = await fixture(contextWithCount(1))
    const injected = new Error('SYNTHETIC_SNAPSHOT_IMMEDIATE_BEFORE_SEAL_AFTER_WRITE')
    let injectedAfterWrite = false
    let reachedConstraint = false
    await expect(
      db().$transaction(async (tx) => {
        await tx.fortnoxReadRun.update({
          where: { id: f.runId },
          data: { reason: 'SYNTHETIC_IMMEDIATE_BEFORE' },
        })
        const seal = jest
          .spyOn(tx.fortnoxReadContextSnapshot, 'update')
          .mockImplementationOnce(() => {
            throw injected
          })
        try {
          await freezeCheckpointContext(tx, f.organizationId, f.runId)
        } catch (error) {
          expect(error).toBe(injected)
          expect(seal).toHaveBeenCalledTimes(1)
          expect(
            await tx.fortnoxReadContextPage.count({ where: { organizationId: f.organizationId } }),
          ).toBe(2)
          injectedAfterWrite = true
        } finally {
          seal.mockRestore()
        }
        expect(injectedAfterWrite).toBe(true)
        expect(
          await tx.fortnoxReadContextPage.count({ where: { organizationId: f.organizationId } }),
        ).toBe(2)
        await tx.fortnoxReadRun.update({
          where: { id: f.runId },
          data: { reason: 'SYNTHETIC_IMMEDIATE_AFTER' },
        })
        reachedConstraint = true
        await tx.$executeRaw(
          Prisma.sql`SET CONSTRAINTS fortnox_context_snapshot_must_be_sealed IMMEDIATE`,
        )
      }, PRISMA_DEFAULT_TX_LIMITS),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    expect(injectedAfterWrite).toBe(true)
    expect(reachedConstraint).toBe(true)
    const observer = new PrismaClient({ datasources: { db: { url: isolatedDatabaseUrl() } } })
    try {
      await observer.$connect()
      expect(await observer.fortnoxReadContextSnapshot.count({ where: { runId: f.runId } })).toBe(0)
      expect(
        await observer.fortnoxReadContextPage.count({
          where: { organizationId: f.organizationId },
        }),
      ).toBe(0)
      expect(
        await observer.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } }),
      ).toStrictEqual(f.before)
    } finally {
      await observer.$disconnect()
    }
    const header = await transaction(async (tx) => {
      const sealed = await freezeCheckpointContext(tx, f.organizationId, f.runId)
      await tx.$executeRaw(
        Prisma.sql`SET CONSTRAINTS fortnox_context_snapshot_must_be_sealed IMMEDIATE`,
      )
      return sealed
    })
    await expect(
      transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId)),
    ).resolves.toStrictEqual(header)
    expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).toStrictEqual(
      f.before,
    )
  })

  it('nekar strikt ogiltig v1-källa innan något snapshot skrivs', async () => {
    const f = await fixture(contextWithCount(1))
    await db().fortnoxReadRun.update({
      where: { id: f.runId },
      data: { frozenContext: { ...f.context, rawProviderBody: 'SYNTHETIC_MUST_NOT_BE_COPIED' } },
    })
    await expect(
      transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId)),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await db().fortnoxReadContextSnapshot.count({ where: { runId: f.runId } })).toBe(0)
    expect(
      await db().fortnoxReadContextPage.count({ where: { organizationId: f.organizationId } }),
    ).toBe(0)
  })

  it.each(['input', 'connection'] as const)(
    'omläser aktuell liten runbindning och stoppar ändrat %s efter varm läsning',
    async (field) => {
      const f = await fixture(contextWithCount(1))
      const header = await transaction((tx) =>
        freezeCheckpointContext(tx, f.organizationId, f.runId),
      )
      await expect(
        transaction((tx) => readCheckpointContextHeader(tx, f.organizationId, f.runId)),
      ).resolves.toStrictEqual(header)
      const before = await stored(f.organizationId, f.runId)
      await db().fortnoxReadRun.update({
        where: { id: f.runId },
        data: field === 'input' ? { costAccounts: [5170] } : { connectionGeneration: 1 },
      })
      await expect(
        transaction((tx) => readCheckpointContextHeader(tx, f.organizationId, f.runId)),
      ).rejects.toBeInstanceOf(ConflictException)
      await expect(
        transaction((tx) =>
          readCheckpointContextPage(tx, f.organizationId, f.runId, 'MAPPINGS', 1),
        ),
      ).rejects.toBeInstanceOf(ConflictException)
      await expect(
        transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId)),
      ).rejects.toBeInstanceOf(ConflictException)
      await expect(
        transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId)),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(await stored(f.organizationId, f.runId)).toStrictEqual(before)
    },
  )

  it('databasen spärrar ändring, extrainsättning och direkt radering av förseglade sidor/header', async () => {
    const f = await fixture(contextWithCount(1))
    const header = await transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId))
    const before = await stored(f.organizationId, f.runId)
    const first = before.pages[0]!
    const attempts = [
      Prisma.sql`UPDATE "FortnoxReadContextSnapshot" SET "digest" = ${'0'.repeat(64)} WHERE "id" = ${header.id}`,
      Prisma.sql`UPDATE "FortnoxReadContextSnapshot" SET "sealedAt" = NULL WHERE "id" = ${header.id}`,
      Prisma.sql`UPDATE "FortnoxReadContextPage" SET "digest" = ${'0'.repeat(64)} WHERE "id" = ${first.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadContextPage" WHERE "id" = ${first.id}`,
      Prisma.sql`DELETE FROM "FortnoxReadContextSnapshot" WHERE "id" = ${header.id}`,
    ]
    for (const sql of attempts) {
      await expect(db().$executeRaw(sql)).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '23514' },
      })
      expect(await stored(f.organizationId, f.runId)).toStrictEqual(before)
    }
    await expect(
      db().fortnoxReadContextPage.create({
        data: {
          organizationId: f.organizationId,
          snapshotId: header.id,
          kind: 'MAPPINGS',
          page: 2,
          itemCount: 1,
          digest: '0'.repeat(64),
          items: f.context.mappings,
        },
      }),
    ).rejects.toThrow()
    expect(await stored(f.organizationId, f.runId)).toStrictEqual(before)
    await expect(
      transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId)),
    ).resolves.toStrictEqual(header)
  })

  it('annan transaktion nekas före headercommit och efter seal utan att en sida kan smita in', async () => {
    const f = await fixture(contextWithCount(1))
    const oracle = snapshotOracle(f, randomUUID())
    let prepared: () => void = () => {
      throw new Error('Barriären är inte skapad')
    }
    let allowSeal: () => void = () => {
      throw new Error('Barriären är inte skapad')
    }
    const isPrepared = new Promise<void>((resolve) => {
      prepared = resolve
    })
    const maySeal = new Promise<void>((resolve) => {
      allowSeal = resolve
    })
    const writer = transaction(async (tx) => {
      await tx.fortnoxReadContextSnapshot.create({
        data: {
          id: oracle.id,
          organizationId: f.organizationId,
          runId: f.runId,
          manifest: oracle.manifest,
          digest: oracle.digest,
        },
      })
      await tx.fortnoxReadContextPage.createMany({ data: oracle.pages })
      expect(await tx.fortnoxReadContextPage.count({ where: { snapshotId: oracle.id } })).toBe(2)
      prepared()
      await maySeal
      return tx.fortnoxReadContextSnapshot.update({
        where: { id: oracle.id },
        data: { sealedAt: new Date() },
      })
    })
    // Bevaka tidigt fel medan barriären väntar, utan sleeps eller hängande avslag.
    void writer.catch(() => undefined)
    const insertExtra = () =>
      db().$executeRaw(Prisma.sql`
      INSERT INTO "FortnoxReadContextPage"
        ("id", "organizationId", "snapshotId", "kind", "page", "itemCount", "digest", "items")
      VALUES (${randomUUID()}, ${f.organizationId}, ${oracle.id}, 'MAPPINGS', 2, 1,
        ${'0'.repeat(64)}, ${JSON.stringify(f.context.mappings)}::jsonb)
    `)
    try {
      await Promise.race([
        isPrepared,
        writer.then(() => {
          throw new Error('Writer avslutades före barriären')
        }),
      ])
      // READ COMMITTED ser inte första transaktionens ännu oförseglade INSERT.
      // Någon laglig beständig oselad parent finns inte att låsa i detta läge.
      await expect(insertExtra()).rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } })
    } finally {
      allowSeal()
      await writer
    }
    await expect(insertExtra()).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    expect(await db().fortnoxReadContextPage.count({ where: { snapshotId: oracle.id } })).toBe(2)
    await transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId))
    expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).toStrictEqual(
      f.before,
    )
  })

  it.each(['missing', 'gap'] as const)(
    'SQL-försegling nekar %s sida och rullar tillbaka hela den råa fixturen',
    async (corruption) => {
      const f = await fixture(contextWithCount(101))
      const oracle = snapshotOracle(f, randomUUID())
      const pages = oracle.pages.flatMap((page) => {
        if (page.kind !== 'MAPPINGS' || page.page !== 2) return [page]
        return corruption === 'missing' ? [] : [{ ...page, page: 3 }]
      })
      let reachedSeal = false
      await expect(
        transaction(async (tx) => {
          await tx.fortnoxReadContextSnapshot.create({
            data: {
              id: oracle.id,
              organizationId: f.organizationId,
              runId: f.runId,
              manifest: oracle.manifest,
              digest: oracle.digest,
            },
          })
          await tx.fortnoxReadContextPage.createMany({ data: pages })
          expect(await tx.fortnoxReadContextPage.count({ where: { snapshotId: oracle.id } })).toBe(
            corruption === 'missing' ? 3 : 4,
          )
          reachedSeal = true
          await tx.$executeRaw(
            Prisma.sql`UPDATE "FortnoxReadContextSnapshot" SET "sealedAt" = ${new Date()} WHERE "id" = ${oracle.id}`,
          )
        }),
      ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
      expect(reachedSeal).toBe(true)
      expect(await db().fortnoxReadContextSnapshot.count({ where: { runId: f.runId } })).toBe(0)
      expect(
        await db().fortnoxReadContextPage.count({ where: { organizationId: f.organizationId } }),
      ).toBe(0)
      expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).toStrictEqual(
        f.before,
      )
    },
  )

  it('riktiga läsfrågor hämtar header/sidor men aldrig frozenContext från v1-körningen', async () => {
    const f = await fixture(contextWithCount(101))
    const header = await transaction((tx) => freezeCheckpointContext(tx, f.organizationId, f.runId))
    const reads: Array<{ name: string; read: (tx: Prisma.TransactionClient) => Promise<unknown> }> =
      [
        {
          name: 'header',
          read: (tx) => readCheckpointContextHeader(tx, f.organizationId, f.runId),
        },
        {
          name: 'page',
          read: (tx) => readCheckpointContextPage(tx, f.organizationId, f.runId, 'OWN_EXPORTS', 2),
        },
        {
          name: 'verifyAll',
          read: (tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId),
        },
      ]
    for (const { name, read } of reads) {
      const sql: string[] = []
      capturedSql = sql
      try {
        const result = await transaction(read)
        if (name === 'page')
          expect(result).toStrictEqual({ items: f.context.ownExports.slice(100), nextPage: null })
        else expect(result).toStrictEqual(header)
      } finally {
        capturedSql = null
      }
      expect(sql.some((query) => query.includes('"FortnoxReadRun"'))).toBe(true)
      expect(sql.some((query) => query.includes('"FortnoxReadContextSnapshot"'))).toBe(true)
      if (name !== 'header')
        expect(sql.some((query) => query.includes('"FortnoxReadContextPage"'))).toBe(true)
      expect(sql.join('\n')).not.toContain('"frozenContext"')
      for (const query of sql.filter((query) => query.includes('"FortnoxReadRun"'))) {
        expect(query).not.toMatch(/\bSELECT\s+(?:[\w".]+\.)?\*/i)
      }
    }
  })

  it.each(['HEADER_DIGEST', 'LATE_PAGE_DIGEST', 'LATE_PAGE_SHAPE', 'COLLECTION_ROOT'] as const)(
    'rått konstruerad och förseglad %s-korruption avvisas utan triggerundantag',
    async (corruption) => {
      const f = await fixture(contextWithCount(101))
      const expected = snapshotOracle(f, randomUUID())
      const pages = expected.pages
      const lastMapping = pages.find((page) => page.kind === 'MAPPINGS' && page.page === 2)
      if (!lastMapping) throw new Error('Korruptionsfixturen saknar sin sena sida')
      if (corruption === 'LATE_PAGE_DIGEST') lastMapping.digest = '0'.repeat(64)
      if (corruption === 'LATE_PAGE_SHAPE') {
        lastMapping.items = [
          { type: 'PROJECT', code: 'late', propertyId: 'synthetic', propertyName: 17 },
        ]
        // Korrekt hash för FEL form: provet måste kräva schemavalidering också.
        lastMapping.digest = hash({
          version: 1,
          binding: expected.binding,
          kind: 'MAPPINGS',
          page: 2,
          itemCount: 1,
          items: lastMapping.items,
        })
        let root = hash({ version: 1, binding: expected.binding, kind: 'MAPPINGS' })
        for (const page of pages.filter((page) => page.kind === 'MAPPINGS')) {
          root = hash({
            previousRoot: root,
            page: page.page,
            itemCount: page.itemCount,
            digest: page.digest,
          })
        }
        expected.manifest.collections.MAPPINGS.root = root
      }
      if (corruption === 'COLLECTION_ROOT')
        expected.manifest.collections.MAPPINGS.root = '0'.repeat(64)
      const digest =
        corruption === 'HEADER_DIGEST'
          ? '0'.repeat(64)
          : hash({
              id: expected.id,
              organizationId: f.organizationId,
              runId: f.runId,
              manifest: expected.manifest,
            })
      await transaction(async (tx) => {
        await tx.fortnoxReadContextSnapshot.create({
          data: {
            id: expected.id,
            organizationId: f.organizationId,
            runId: f.runId,
            manifest: expected.manifest,
            digest,
          },
        })
        await tx.fortnoxReadContextPage.createMany({ data: pages })
        await tx.fortnoxReadContextSnapshot.update({
          where: { id: expected.id },
          data: { sealedAt: new Date() },
        })
      })
      const before = await stored(f.organizationId, f.runId)
      expect(before.header.sealedAt).toBeInstanceOf(Date)
      if (corruption === 'HEADER_DIGEST') {
        await expect(
          transaction((tx) => readCheckpointContextHeader(tx, f.organizationId, f.runId)),
        ).rejects.toBeInstanceOf(ConflictException)
      } else {
        await transaction((tx) => readCheckpointContextHeader(tx, f.organizationId, f.runId))
        // En frisk första sida får inte dölja felet på sida2 eller i slutroten.
        await expect(
          transaction((tx) =>
            readCheckpointContextPage(tx, f.organizationId, f.runId, 'MAPPINGS', 1),
          ),
        ).resolves.toStrictEqual({ items: f.context.mappings.slice(0, 100), nextPage: 2 })
        if (corruption === 'COLLECTION_ROOT') {
          await expect(
            transaction((tx) =>
              readCheckpointContextPage(tx, f.organizationId, f.runId, 'MAPPINGS', 2),
            ),
          ).resolves.toStrictEqual({ items: f.context.mappings.slice(100), nextPage: null })
        } else {
          await expect(
            transaction((tx) =>
              readCheckpointContextPage(tx, f.organizationId, f.runId, 'MAPPINGS', 2),
            ),
          ).rejects.toBeInstanceOf(ConflictException)
        }
      }
      await expect(
        transaction((tx) => verifyCheckpointContextSnapshot(tx, f.organizationId, f.runId)),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(await stored(f.organizationId, f.runId)).toStrictEqual(before)
      expect(await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.runId } })).toStrictEqual(
        f.before,
      )
    },
  )

  it('nekar saknad snapshot, främmande scope och fel sidnummer utan att röja den andra organisationen', async () => {
    const own = await fixture(contextWithCount(1))
    const other = await fixture(contextWithCount(1))
    await expect(
      transaction((tx) => readCheckpointContextHeader(tx, own.organizationId, own.runId)),
    ).rejects.toBeInstanceOf(ConflictException)
    const ownHeader = await transaction((tx) =>
      freezeCheckpointContext(tx, own.organizationId, own.runId),
    )
    await transaction((tx) => freezeCheckpointContext(tx, other.organizationId, other.runId))
    const otherBefore = await stored(other.organizationId, other.runId)
    const foreignReads: Array<(tx: Prisma.TransactionClient) => Promise<unknown>> = [
      (tx: Prisma.TransactionClient) =>
        freezeCheckpointContext(tx, own.organizationId, other.runId),
      (tx: Prisma.TransactionClient) =>
        readCheckpointContextHeader(tx, own.organizationId, other.runId),
      (tx: Prisma.TransactionClient) =>
        readCheckpointContextPage(tx, own.organizationId, other.runId, 'MAPPINGS', 1),
      (tx: Prisma.TransactionClient) =>
        verifyCheckpointContextSnapshot(tx, own.organizationId, other.runId),
    ]
    for (const read of foreignReads)
      await expect(transaction(read)).rejects.toBeInstanceOf(ConflictException)
    for (const page of [0, -1, 1.5, Number.POSITIVE_INFINITY, 3]) {
      await expect(
        transaction((tx) =>
          readCheckpointContextPage(tx, own.organizationId, own.runId, 'MAPPINGS', page),
        ),
      ).rejects.toBeInstanceOf(BadRequestException)
    }
    await expect(
      transaction((tx) =>
        readCheckpointContextPage(tx, own.organizationId, own.runId, 'UNKNOWN' as Kind, 1),
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    // Båda orgarna finns: ett barn kan inte bindas till den andras snapshot.
    await expect(
      db().$executeRaw(Prisma.sql`
      INSERT INTO "FortnoxReadContextPage"
        ("id", "organizationId", "snapshotId", "kind", "page", "itemCount", "digest", "items")
      VALUES (${randomUUID()}, ${other.organizationId}, ${ownHeader.id}, 'MAPPINGS', 2, 1,
        ${'0'.repeat(64)}, ${JSON.stringify(own.context.mappings)}::jsonb)
    `),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } })
    expect(await stored(other.organizationId, other.runId)).toStrictEqual(otherBefore)

    await db().organization.delete({ where: { id: own.organizationId } })
    organizations.delete(own.organizationId)
    expect(await db().fortnoxReadContextSnapshot.count({ where: { id: ownHeader.id } })).toBe(0)
    expect(await db().fortnoxReadContextPage.count({ where: { snapshotId: ownHeader.id } })).toBe(0)
    expect(await stored(other.organizationId, other.runId)).toStrictEqual(otherBefore)
  })
})
