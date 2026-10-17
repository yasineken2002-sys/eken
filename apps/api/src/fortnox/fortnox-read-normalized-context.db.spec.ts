/** Verklig syntetisk PostgreSQL: offentlig start/claim/normalisering/frysning.
 * Facit använder egen kanonisk JSON + node:crypto, inte produktens hashfunktioner.
 * Barriärer omger verkliga queries; ingen triggerbypass eller extern Fortnox.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma, PrismaClient, type FortnoxReadRun } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { type StartCheckpointInput } from './fortnox-read-checkpoint-context'
import {
  FortnoxReadSourceRunService,
  type NormalizedContextReceipt,
} from './fortnox-read-source-run.service'

const INPUT = {
  financialYearId: 1,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
} satisfies StartCheckpointInput
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
type Context = { version: 1; input: typeof INPUT; mappings: Mapping[]; ownExports: OwnExport[] }
const EXPIRED = 'Läsanspråket har upphört'

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Normaliserad kontext kräver explicit lokal testdatabas')
  const url = new URL(raw),
    name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Normaliserad kontext tillåter bara egen lokal testdatabas eller CI')
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
      throw new Error('Testoperationen avslutades innan den verkliga barriären nåddes')
    }),
  ])
}
function rawContains(params: Prisma.MiddlewareParams, text: string) {
  return (
    (params.action === 'executeRaw' || params.action === 'queryRaw') &&
    JSON.stringify(params.args, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ).includes(text)
  )
}
const isCopy = (params: Prisma.MiddlewareParams) =>
  rawContains(params, 'INSERT INTO') && rawContains(params, 'FortnoxReadContextPage')
function withoutLease(run: FortnoxReadRun) {
  return { ...run, claimVersion: 0, claimToken: null, leaseUntil: null, checkpointUpdatedAt: null }
}
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, result: unknown) => Promise<void>
  transform?: (params: Prisma.MiddlewareParams, result: unknown) => unknown
}

describe('Fortnox NORMALIZED → verifierad beständig kontext i PostgreSQL', () => {
  let prisma: TestPrisma | undefined
  const orgs = new Set<string>(),
    journals = new Set<string>(),
    exports = new Set<string>(),
    accounts = new Set<string>()
  function db() {
    if (!prisma) throw new Error('Kontextfixturen har inte startats')
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
    if (!row) throw new Error('Saknar testklientens PID')
    return { client, hooks, pid: row.pid }
  }
  async function mustClaim(org: string, runId: string, owner = service()) {
    const lease = await owner.claim(org, runId)
    if (!lease) throw new Error('Fixturen fick inget anspråk')
    return lease
  }
  async function fixture(exportCount = 1, normalize = true) {
    const org = randomUUID(),
      propertyId = randomUUID()
    await db().organization.create({
      data: {
        id: org,
        name: `synthetic-context-bridge-${org}`,
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
        fortnoxOrgNumber: 'SYNTHETIC_CONTEXT_BRIDGE',
      },
    })
    const mappings: Mapping[] = exportCount
      ? [
          { type: 'COST_CENTER', code: '10', propertyId, propertyName: 'Å A\u030A 🏡 "hus"\\\n' },
          { type: 'PROJECT', code: '2', propertyId, propertyName: 'Å A\u030A 🏡 "hus"\\\n' },
        ]
      : []
    const prefix = randomUUID().slice(0, 24)
    const rows = Array.from({ length: exportCount }, (_, i) => ({
      id: `${prefix}${String(i + 1).padStart(12, '0')}`,
      journalEntryId: randomUUID(),
      number: i + 1,
      revision: i % 3 === 0 ? 0 : i % 3 === 1 ? -7 : null,
    }))
    const ownExports: OwnExport[] = rows.map((row) => ({
      voucher: `1|L|${row.number}`,
      journalEntryId: row.journalEntryId,
      revision: row.revision,
      perMal: [
        { account: 5171, sources: [5170, 5160] },
        { account: 1940, sources: [1930] },
      ],
    }))
    for (const row of rows) {
      journals.add(row.journalEntryId)
      exports.add(row.id)
    }
    if (exportCount)
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
        const entries: Prisma.JournalEntryCreateManyInput[] = rows.map((row, i) => ({
          id: row.journalEntryId,
          organizationId: org,
          date: new Date('2026-01-01T00:00:00Z'),
          description: 'SYNTHETIC_CONTEXT_BRIDGE',
          source: 'MANUAL',
          sourceId: row.journalEntryId,
          fiscalYear: 2026,
          series: 'A',
          verNumber: i + 1,
        }))
        await c.journalEntry.createMany({ data: entries })
        await c.journalEntryLine.createMany({
          data: rows.flatMap((row) => [
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
        await c.fortnoxVoucherExport.createMany({
          data: rows.map(
            (row): Prisma.FortnoxVoucherExportCreateManyInput => ({
              id: row.id,
              organizationId: org,
              journalEntryId: row.journalEntryId,
              state: 'CONFIRMED',
              fortnoxDatabaseNumber: 900001,
              externalYear: 1,
              externalSeries: 'L',
              externalNumber: row.number,
              draft: {
                kontomappning: { revision: row.revision },
                provenance: {
                  lines: [
                    { localAccountNumber: 5170, externalAccountNumber: 5171 },
                    { localAccountNumber: 1930, externalAccountNumber: 1940 },
                    { localAccountNumber: 5160, externalAccountNumber: 5171 },
                    { localAccountNumber: 5170, externalAccountNumber: 5171 },
                  ],
                },
              },
            }),
          ),
        })
      })
    const owner = service(),
      run = await owner.start(org, null, INPUT),
      lease = await mustClaim(org, run.id, owner)
    let progress = await owner.prepareNormalization(lease)
    if (normalize)
      while (progress.next) {
        await owner.normalizePage(lease, progress.next)
        progress = await owner.prepareNormalization(lease)
      }
    const context: Context = { version: 1, input: INPUT, mappings, ownExports }
    return { org, connection, run, lease, context }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function oracle(f: Fixture, id: string = randomUUID(), sourceDigest = hash(f.context)) {
    const connection = {
      id: f.connection.id,
      generation: f.connection.generation,
      databaseNumber: 900001,
      orgNumber: 'SYNTHETIC_CONTEXT_BRIDGE',
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
      for (let offset = 0; offset < values.length; offset += 100) {
        const page = offset / 100 + 1,
          items = values.slice(offset, offset + 100)
        const digest = hash({ version: 1, binding, kind, page, itemCount: items.length, items })
        pages.push({
          organizationId: f.org,
          snapshotId: id,
          kind,
          page,
          itemCount: items.length,
          digest,
          items,
        })
        collections[kind].pageCount++
        collections[kind].root = hash({
          previousRoot: collections[kind].root,
          page,
          itemCount: items.length,
          digest,
        })
      }
    }
    const manifest = { version: 1, input: INPUT, sourceDigest, connection, collections }
    const header = { id, organizationId: f.org, runId: f.run.id, manifest }
    return { ...header, digest: hash(header), pages }
  }
  type Oracle = ReturnType<typeof oracle>
  async function readState(org: string, client = db()) {
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
    }
  }
  async function durable(org: string) {
    const client = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      await client.$connect()
      return await readState(org, client)
    } finally {
      await client.$disconnect()
    }
  }
  async function assertZero(f: Fixture, before: Awaited<ReturnType<typeof readState>>) {
    const after = await durable(f.org)
    expect(after.snapshots).toStrictEqual([])
    expect(after.pages).toStrictEqual([])
    expect(after.sources).toStrictEqual(before.sources)
    expect(after.stages).toStrictEqual(before.stages)
    expect(after.stagePages).toStrictEqual(before.stagePages)
    expect(after.runs.map(withoutLease)).toStrictEqual(before.runs.map(withoutLease))
  }
  async function verifyStored(f: Fixture, receipt: NormalizedContextReceipt) {
    const state = await durable(f.org),
      expected = oracle(f, receipt.snapshotId)
    expect(state.snapshots).toHaveLength(1)
    expect(state.snapshots[0]).toMatchObject({
      id: expected.id,
      organizationId: f.org,
      runId: f.run.id,
      manifest: expected.manifest,
      digest: expected.digest,
      sealedAt: expect.any(Date),
    })
    expect(
      state.pages.map(({ organizationId, snapshotId, kind, page, itemCount, digest, items }) => ({
        organizationId,
        snapshotId,
        kind,
        page,
        itemCount,
        digest,
        items,
      })),
    ).toStrictEqual(expected.pages)
    expect(receipt).toStrictEqual({
      snapshotId: expected.id,
      runId: f.run.id,
      sourceDigest: hash(f.context),
      headerDigest: expected.digest,
      mappingCount: f.context.mappings.length,
      exportCount: f.context.ownExports.length,
      mappingPageCount: Math.ceil(f.context.mappings.length / 100),
      exportPageCount: Math.ceil(f.context.ownExports.length / 100),
    })
    return state
  }
  async function databaseAfter(deadline: Date) {
    const until = Date.now() + 2000
    while (Date.now() < until) {
      const [row] = await db().$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (row && row.now > deadline) return row.now
    }
    throw new Error('DB-deadline passerades inte inom kort testgräns')
  }
  async function waitBlocked(pid: number, blocker: number) {
    const until = Date.now() + 1500
    while (Date.now() < until) {
      const [row] = await db().$queryRaw<
        Array<{ blockers: number[] }>
      >`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${pid}`
      if (row?.blockers.includes(blocker)) return
    }
    throw new Error('Verklig låsväntan observerades inte')
  }
  async function insertHeader(c: Prisma.TransactionClient, expected: Oracle) {
    return c.$executeRaw`INSERT INTO "FortnoxReadContextSnapshot" (id,"organizationId","runId",manifest,digest)
      VALUES (${expected.id},${expected.organizationId},${expected.runId},${JSON.stringify(expected.manifest)}::jsonb,${expected.digest})`
  }
  async function insertPages(c: Prisma.TransactionClient, expected: Oracle) {
    if (expected.pages.length) await c.fortnoxReadContextPage.createMany({ data: expected.pages })
  }
  async function seal(c: Prisma.TransactionClient, expected: Oracle) {
    await c.$executeRaw`UPDATE "FortnoxReadContextSnapshot" SET "sealedAt"=timezone('UTC',clock_timestamp()) WHERE id=${expected.id}`
    await c.$executeRaw`SET CONSTRAINTS "fortnox_context_snapshot_must_be_sealed" IMMEDIATE`
  }
  async function sqlReject(
    work: (c: Prisma.TransactionClient) => Promise<unknown>,
    code = '23514',
  ) {
    await expect(
      tx(async (c) => {
        await work(c)
        throw new Error('SYNTHETIC_SQL_UNEXPECTEDLY_ALLOWED')
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code } })
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
          `synthetic-context-bridge-${org}`,
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

  it.each([0, 101])(
    '%i exporter: riktig kedja och alla kopierade bytes/hashled mot oberoende facit',
    async (count) => {
      const f = await fixture(count),
        before = await readState(f.org)
      const receipt = await service().freezeNormalizedContext(f.lease)
      const after = await verifyStored(f, receipt)
      expect(after.sources).toStrictEqual(before.sources)
      expect(after.stages).toStrictEqual(before.stages)
      expect(after.stagePages).toStrictEqual(before.stagePages)
      expect(after.runs.map(withoutLease)).toStrictEqual(before.runs.map(withoutLease))
      expect(await service().start(f.org, null, INPUT)).toMatchObject({
        id: f.run.id,
        phase: 'SOURCE_CAPTURED',
        frozenContext: null,
        catalog: null,
        summary: null,
        rows: null,
      })
    },
  )

  it('NORMALIZING och främmande scope ger ingen snapshot', async () => {
    const f = await fixture(1, false),
      foreign = await fixture(0),
      before = await readState(f.org)
    await expect(service().freezeNormalizedContext(f.lease)).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(
      service().freezeNormalizedContext({ ...f.lease, organizationId: foreign.org }),
    ).rejects.toBeInstanceOf(ConflictException)
    await assertZero(f, before)
    expect((await durable(foreign.org)).snapshots).toStrictEqual([])
  })

  it('ny ägare replayar första beständiga kopian; gammal fence kan inte läsa kvittot', async () => {
    const f = await fixture(),
      first = await service().freezeNormalizedContext(f.lease)
    await service().release(f.lease)
    const lease = await mustClaim(f.org, f.run.id),
      before = await readState(f.org),
      other = await controlled()
    try {
      await expect(service().freezeNormalizedContext(f.lease)).rejects.toMatchObject({
        message: EXPIRED,
      })
      expect(await service(other.client).freezeNormalizedContext(lease)).toStrictEqual(first)
      const after = await verifyStored(f, first)
      expect(after.snapshots).toStrictEqual(before.snapshots)
      expect(after.pages).toStrictEqual(before.pages)
    } finally {
      await other.client.$disconnect()
    }
  })

  it('två samtidiga anrop ger en COPY och samma kvitto efter verklig låsväntan', async () => {
    const f = await fixture(),
      a = await controlled(),
      b = await controlled(),
      reached = deferred(),
      release = deferred()
    let copies = 0
    a.hooks.after = async (params, result) => {
      if (!isCopy(params)) return
      expect(result).toBe(2)
      copies++
      reached.resolve()
      await release.promise
    }
    b.hooks.after = async (params) => {
      if (isCopy(params)) copies++
    }
    const first = Promise.allSettled([service(a.client).freezeNormalizedContext(f.lease)])
    let second: typeof first | undefined
    try {
      await barrier(reached.promise, first)
      second = Promise.allSettled([service(b.client).freezeNormalizedContext(f.lease)])
      await waitBlocked(b.pid, a.pid)
      release.resolve()
      const [one] = await first,
        [two] = await second
      expect(one?.status).toBe('fulfilled')
      expect(two?.status).toBe('fulfilled')
      if (one?.status !== 'fulfilled' || two?.status !== 'fulfilled')
        throw new Error('Samtidiga frysningar misslyckades')
      expect(two.value).toStrictEqual(one.value)
      expect(copies).toBe(1)
      await verifyStored(f, one.value)
    } finally {
      release.resolve()
      await first
      if (second) await second
      await a.client.$disconnect()
      await b.client.$disconnect()
    }
  })

  it.each(['COPY', 'SEAL'] as const)(
    'vanligt fel efter verklig %s rullar tillbaka och kan försöka igen',
    async (point) => {
      const f = await fixture(),
        before = await readState(f.org),
        c = await controlled()
      const injected = new Error(`SYNTHETIC_AFTER_${point}`)
      let reached = false
      c.hooks.after = async (params, result) => {
        if (
          (point === 'COPY' && isCopy(params)) ||
          (point === 'SEAL' &&
            params.model === 'FortnoxReadContextSnapshot' &&
            params.action === 'update')
        ) {
          if (point === 'COPY') expect(result).toBe(2)
          else expect(result).toMatchObject({ sealedAt: expect.any(Date) })
          reached = true
          throw injected
        }
      }
      try {
        await expect(service(c.client).freezeNormalizedContext(f.lease)).rejects.toBe(injected)
        expect(reached).toBe(true)
        await assertZero(f, before)
        await verifyStored(f, await service().freezeNormalizedContext(f.lease))
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it('fångat JS-fel efter giltig seal får committa; ett senare produktanrop verifierar samma kopia', async () => {
    const f = await fixture(),
      expected = oracle(f),
      injected = new Error('SYNTHETIC_CAUGHT_AFTER_VALID_SEAL')
    let caught = false
    await tx(async (c) => {
      await insertHeader(c, expected)
      await insertPages(c, expected)
      await seal(c, expected)
      // IMMEDIATE har redan verifierat en fullständig kopia. Ett fångat JS-fel
      // innebär ingen databasrollback och får inte beskrivas som en sådan.
      try {
        throw injected
      } catch (error) {
        expect(error).toBe(injected)
        caught = true
      }
    })
    expect(caught).toBe(true)
    const saved = await durable(f.org)
    expect(saved.snapshots).toHaveLength(1)
    expect(saved.snapshots[0]).toMatchObject({ id: expected.id, sealedAt: expect.any(Date) })
    const receipt = await service().freezeNormalizedContext(f.lease)
    expect(receipt.snapshotId).toBe(expected.id)
    await verifyStored(f, receipt)
  })

  it('ny ägare mellan sidpassen och COPY gör den gamla planen oanvändbar', async () => {
    const f = await fixture(),
      before = await readState(f.org),
      c = await controlled(),
      reached = deferred(),
      release = deferred()
    const pagesPerPass =
      Math.ceil(f.context.mappings.length / 100) + Math.ceil(f.context.ownExports.length / 100)
    let stageReads = 0,
      paused = false,
      copies = 0
    c.hooks.after = async (params) => {
      if (params.model === 'FortnoxReadNormalizationPage' && params.action === 'findUnique')
        stageReads++
      if (isCopy(params)) copies++
    }
    c.hooks.before = async (params) => {
      // Endast en schemaläggningsbarriär: båda verkliga sidpassen är klara och
      // föregående TX har committat. Nästa parentlås har ännu inte tagits.
      if (
        paused ||
        stageReads < 2 * pagesPerPass ||
        !rawContains(params, 'FortnoxConnection') ||
        !rawContains(params, 'FOR UPDATE')
      )
        return
      paused = true
      reached.resolve()
      await release.promise
    }
    const pending = Promise.allSettled([service(c.client).freezeNormalizedContext(f.lease)])
    try {
      await barrier(reached.promise, pending)
      expect(paused).toBe(true)
      expect(stageReads).toBe(4)
      await service().release(f.lease)
      const next = await mustClaim(f.org, f.run.id)
      release.resolve()
      const [result] = await pending
      expect(result?.status).toBe('rejected')
      if (result?.status !== 'rejected') throw new Error('Gammal plan fick ett kvitto')
      expect(result.reason).toMatchObject({ message: EXPIRED })
      expect(copies).toBe(0)
      await assertZero(f, before)
      await verifyStored(f, await service().freezeNormalizedContext(next))
    } finally {
      release.resolve()
      await pending
      await c.client.$disconnect()
    }
  })

  it.each(['COPY', 'IMMEDIATE'] as const)(
    'faktisk DB-expiry efter %s ger fenceavslag och full rollback före commit',
    async (point) => {
      const f = await fixture(),
        c = await controlled(),
        short = new ShortLeaseService(c.client)
      await service().release(f.lease)
      const lease = await mustClaim(f.org, f.run.id, short),
        before = await readState(f.org)
      let reached = false
      c.hooks.after = async (params, result) => {
        const atPoint =
          point === 'COPY'
            ? isCopy(params)
            : rawContains(params, 'IMMEDIATE') &&
              rawContains(params, 'fortnox_context_snapshot_must_be_sealed')
        if (!atPoint || reached) return
        if (point === 'COPY') expect(result).toBe(2)
        reached = true
        const actual = await db().fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })
        if (!actual.leaseUntil) throw new Error('Verklig deadline saknas')
        await databaseAfter(actual.leaseUntil)
      }
      try {
        await expect(short.freezeNormalizedContext(lease)).rejects.toMatchObject({
          message: EXPIRED,
        })
        expect(reached).toBe(true)
        await assertZero(f, before)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it.each(['ERROR', 'EXPIRED'] as const)(
    'eftercommit %s bevarar snapshoten och ny claim kan verifiera samma kopia',
    async (mode) => {
      const f = await fixture(),
        c = await controlled(),
        owner = mode === 'EXPIRED' ? new ShortLeaseService(c.client) : service(c.client)
      await service().release(f.lease)
      const lease = await mustClaim(f.org, f.run.id, owner),
        injected = new Error('SYNTHETIC_LOST_AFTER_COMMIT')
      let committedId: string | undefined
      c.hooks.after = async (params, result) => {
        if (
          committedId ||
          params.model !== 'FortnoxReadContextSnapshot' ||
          params.action !== 'findUnique' ||
          !record(result) ||
          !(result.sealedAt instanceof Date)
        )
          return
        const observer = await durable(f.org)
        if (observer.snapshots.length !== 1) return
        committedId = observer.snapshots[0]!.id
        expect(observer.pages).toHaveLength(2)
        if (mode === 'ERROR') throw injected
        const deadline = observer.runs[0]?.leaseUntil
        if (!deadline) throw new Error('Verklig deadline saknas efter commit')
        await databaseAfter(deadline)
      }
      try {
        if (mode === 'ERROR')
          await expect(owner.freezeNormalizedContext(lease)).rejects.toBe(injected)
        else
          await expect(owner.freezeNormalizedContext(lease)).rejects.toMatchObject({
            message: EXPIRED,
          })
        expect(committedId).toEqual(expect.any(String))
        const before = await durable(f.org)
        if (mode === 'ERROR') await service().release(lease)
        const next = await mustClaim(f.org, f.run.id)
        const receipt = await service().freezeNormalizedContext(next)
        expect(receipt.snapshotId).toBe(committedId)
        const after = await verifyStored(f, receipt)
        expect(after.snapshots).toStrictEqual(before.snapshots)
        expect(after.pages).toStrictEqual(before.pages)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it('korrupt återläst sista sida efter commit nekas utan att den beständiga kopian raderas', async () => {
    const f = await fixture(101),
      c = await controlled()
    let corrupted = false
    c.hooks.transform = (params, result) => {
      if (
        params.model !== 'FortnoxReadContextPage' ||
        params.action !== 'findUnique' ||
        !record(result) ||
        result.kind !== 'OWN_EXPORTS' ||
        result.page !== 2 ||
        !Array.isArray(result.items)
      )
        return result
      const item = result.items[0]
      if (!record(item)) throw new Error('Riktig sista sida saknas')
      corrupted = true
      return { ...result, items: [{ ...item, revision: -99 }] }
    }
    try {
      await expect(service(c.client).freezeNormalizedContext(f.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(corrupted).toBe(true)
      const saved = await durable(f.org)
      expect(saved.snapshots).toHaveLength(1)
      const receipt = await service().freezeNormalizedContext(f.lease)
      expect(receipt.snapshotId).toBe(saved.snapshots[0]!.id)
      await verifyStored(f, receipt)
    } finally {
      await c.client.$disconnect()
    }
  })

  it.each(['SOURCE_DIGEST', 'ROOT'] as const)(
    'SQL-giltig men innehållsmässigt falsk %s får aldrig ett produktkvitto',
    async (corruption) => {
      const f = await fixture(),
        expected = oracle(
          f,
          randomUUID(),
          corruption === 'SOURCE_DIGEST' ? '0'.repeat(64) : hash(f.context),
        )
      if (corruption === 'ROOT') expected.manifest.collections.OWN_EXPORTS.root = '0'.repeat(64)
      expected.digest = hash({
        id: expected.id,
        organizationId: f.org,
        runId: f.run.id,
        manifest: expected.manifest,
      })
      await tx(async (c) => {
        await insertHeader(c, expected)
        await insertPages(c, expected)
        await seal(c, expected)
      })
      const before = await durable(f.org)
      await expect(service().freezeNormalizedContext(f.lease)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(await durable(f.org)).toStrictEqual(before)
    },
  )

  it.each(['INPUT', 'COMPANY', 'COUNT', 'CONNECTION_NULL', 'VERSION_NULL'] as const)(
    'direkt SQL nekar felaktig v2-manifestbindning %s',
    async (field) => {
      const f = await fixture(),
        expected = oracle(f),
        before = await readState(f.org)
      const manifest = {
        ...expected.manifest,
        ...(field === 'INPUT' ? { input: { ...INPUT, costAccounts: [5160] } } : {}),
        ...(field === 'COMPANY'
          ? { connection: { ...expected.manifest.connection, databaseNumber: 900002 } }
          : {}),
        ...(field === 'COUNT'
          ? {
              collections: {
                ...expected.manifest.collections,
                OWN_EXPORTS: {
                  ...expected.manifest.collections.OWN_EXPORTS,
                  itemCount: 0,
                  pageCount: 0,
                },
              },
            }
          : {}),
        ...(field === 'CONNECTION_NULL' ? { connection: null } : {}),
        ...(field === 'VERSION_NULL' ? { version: null } : {}),
      }
      await sqlReject(
        (
          c,
        ) => c.$executeRaw`INSERT INTO "FortnoxReadContextSnapshot" (id,"organizationId","runId",manifest,digest)
      VALUES (${expected.id},${f.org},${f.run.id},${JSON.stringify(manifest)}::jsonb,${hash(manifest)})`,
      )
      await assertZero(f, before)
    },
  )

  it('direkt SQL nekar främmande org, NORMALIZING samt saknad lease', async () => {
    const f = await fixture(1, false),
      foreign = await fixture(0),
      expected = oracle(f)
    await sqlReject((c) => insertHeader(c, { ...expected, organizationId: foreign.org }), '23503')
    await sqlReject((c) => insertHeader(c, expected))
    await service().release(foreign.lease)
    await sqlReject((c) => insertHeader(c, oracle(foreign)))
    expect((await durable(f.org)).snapshots).toStrictEqual([])
    expect((await durable(foreign.org)).snapshots).toStrictEqual([])
  })

  it('direkt SQL-firstseal efter faktisk expiry nekas och alla sidor rullas tillbaka', async () => {
    const f = await fixture(),
      short = new ShortLeaseService(db())
    await service().release(f.lease)
    const lease = await mustClaim(f.org, f.run.id, short),
      expected = oracle(f),
      before = await readState(f.org)
    let inserted = false
    await sqlReject(async (c) => {
      await insertHeader(c, expected)
      await insertPages(c, expected)
      expect(await c.fortnoxReadContextPage.count({ where: { snapshotId: expected.id } })).toBe(2)
      inserted = true
      await databaseAfter(lease.leaseUntil)
      await seal(c, expected)
    })
    expect(inserted).toBe(true)
    await assertZero(f, before)
  })

  it('connection→run-låsordning: generationsbyte som väntar bakom första läsningen stoppar kopiering', async () => {
    const f = await fixture(),
      blocker = await controlled(),
      a = await controlled(),
      change = await controlled(),
      locked = deferred(),
      release = deferred()
    const holding = tx(async (c) => {
      await c.$queryRaw`SELECT id FROM "FortnoxReadRun" WHERE id=${f.run.id} AND "organizationId"=${f.org} FOR UPDATE`
      locked.resolve()
      await release.promise
    }, blocker.client)
    const held = Promise.allSettled([holding])
    let freezing: Promise<PromiseSettledResult<NormalizedContextReceipt>[]> | undefined
    let changing: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      await barrier(locked.promise, held)
      freezing = Promise.allSettled([service(a.client).freezeNormalizedContext(f.lease)])
      await waitBlocked(a.pid, blocker.pid)
      changing = Promise.allSettled([
        change.client.fortnoxConnection.update({
          where: { organizationId: f.org },
          data: { generation: { increment: 1 } },
        }),
      ])
      await waitBlocked(change.pid, a.pid)
      release.resolve()
      const [holder] = await held,
        [changed] = await changing,
        [result] = await freezing
      expect(holder?.status).toBe('fulfilled')
      expect(changed?.status).toBe('fulfilled')
      expect(result?.status).toBe('rejected')
      if (result?.status !== 'rejected') throw new Error('Anslutningsbytet gav inget avslag')
      expect(result.reason).toBeInstanceOf(ConflictException)
      const after = await durable(f.org)
      expect(after.snapshots).toStrictEqual([])
      expect(after.pages).toStrictEqual([])
      expect(after.runs[0]).toMatchObject({ status: 'FAILED', claimToken: null, leaseUntil: null })
    } finally {
      release.resolve()
      await held
      if (freezing) await freezing
      if (changing) await changing
      await blocker.client.$disconnect()
      await a.client.$disconnect()
      await change.client.$disconnect()
    }
  })

  it('otillåten UPDATE av sealed header tar inget parentlås bakom en konkurrerande connection-ägare', async () => {
    const f = await fixture(),
      receipt = await service().freezeNormalizedContext(f.lease),
      c = await controlled(),
      locked = deferred(),
      release = deferred()
    let holdingFinished = false
    const holding = Promise.allSettled([
      tx(async (connection) => {
        await connection.$queryRaw`SELECT id FROM "FortnoxConnection" WHERE "organizationId"=${f.org} FOR UPDATE`
        locked.resolve()
        await release.promise
      }, c.client),
    ]).then((results) => {
      holdingFinished = true
      return results
    })
    try {
      await barrier(locked.promise, holding)
      await sqlReject(
        (connection) =>
          connection.$executeRaw`UPDATE "FortnoxReadContextSnapshot" SET "sealedAt"="sealedAt" WHERE id=${receipt.snapshotId}`,
      )
      expect(holdingFinished).toBe(false)
    } finally {
      release.resolve()
      await holding
      await c.client.$disconnect()
    }
    const [holder] = await holding
    expect(holder?.status).toBe('fulfilled')
    await verifyStored(f, receipt)
  })

  it('verklig orgcascade raderar egen v2-kopia/stage/källa men bevarar främmande snapshot', async () => {
    const f = await fixture(0),
      foreign = await fixture(0)
    await service().freezeNormalizedContext(f.lease)
    const receipt = await service().freezeNormalizedContext(foreign.lease),
      before = await durable(foreign.org)
    await db().organization.delete({ where: { id: f.org } })
    orgs.delete(f.org)
    expect(await durable(f.org)).toStrictEqual({
      runs: [],
      sources: [],
      stages: [],
      stagePages: [],
      snapshots: [],
      pages: [],
    })
    expect(await durable(foreign.org)).toStrictEqual(before)
    await verifyStored(foreign, receipt)
  })
})
