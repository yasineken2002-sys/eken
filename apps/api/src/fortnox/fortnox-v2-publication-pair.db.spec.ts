/** Real PostgreSQL pair/immutability evidence, using only owned synthetic orgs.
 * Every legitimate INSERT starts with actual service reduction and encoding.
 * Raw SQL tests structural storage guarantees, not authorization or economic
 * truth. No provider calls, trigger bypasses or fabricated reducer proof.
 */
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { FortnoxReadSourceRunService } from './fortnox-read-source-run.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { readCheckpointSourceHeader } from './fortnox-read-source-capture'
import { readStoredCompletedNormalizationStage } from './fortnox-read-normalization-stage'
import { normalizedContextBinding } from './fortnox-read-normalized-context'
import {
  encodeLedgerPublication,
  PUBLICATION_OVERFLOW_REASON,
  type EncodedPublication,
} from './fortnox-read-publication-format'
import { insertLedgerPublication } from './fortnox-read-publication'
import type { FortnoxVoucher } from './fortnox.types'

const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const YEAR = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const CATALOG: CheckpointCatalog = {
  version: 1,
  companyDatabaseNumber: 900001,
  financialYear: { ...YEAR, accountingMethod: 'ACCRUAL' },
  accounts: [{ number: 5170, active: null, balanceBroughtForwardOre: null }],
  dimensions: [],
  coverage: { costCenters: { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 } },
}
const key = (n: number) => `1|L|${n}`
function raw(n: number, ore = 1): FortnoxVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: n,
    TransactionDate: '2026-10-01',
    ReferenceNumber: `SYNTHETIC_PAIR_${n}`,
    VoucherRows: [
      { Account: 5170, Debit: ore / 100 },
      { Account: 2440, Credit: ore / 100 },
    ],
  }
}
function isolatedUrl(): string {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('Parproven kräver explicit syntetisk DATABASE_URL')
  const url = new URL(rawUrl)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Parproven tillåter endast egen lokal testdatabas eller CI')
  url.searchParams.set('connection_limit', '4')
  return url.toString()
}
// Unconditional: an absent/unsafe URL is a failure, never a skipped DB suite.
const DATABASE_URL = isolatedUrl()
class TestPrisma extends PrismaClient {
  async onModuleInit() {
    await this.$connect()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}
type Tx = Prisma.TransactionClient
function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Syntetisk JSON-fixture måste vara ett objekt')
  return Object.fromEntries(Object.entries(value))
}
function changedJson(text: string, changes: Record<string, unknown>): string {
  return JSON.stringify({ ...jsonObject(text), ...changes })
}

describe('V2-publiceringens SQL-par, rollback och oföränderliga historik', () => {
  let prisma: TestPrisma
  const orgs = new Set<string>()
  const service = (client = prisma) => new FortnoxReadSourceRunService(client)
  const tx = <T>(work: (client: Tx) => Promise<T>) =>
    prisma.$transaction(work, PRISMA_DEFAULT_TX_LIMITS)
  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
  })
  afterAll(async () => {
    try {
      for (const id of orgs) await prisma.organization.delete({ where: { id } })
      await observed(async (db) => {
        const where = { organizationId: { in: [...orgs] } }
        expect(await db.fortnoxReadPublication.count({ where })).toBe(0)
        expect(await db.fortnoxReadRun.count({ where })).toBe(0)
        expect(await db.fortnoxReadSourceCapture.count({ where })).toBe(0)
        expect(await db.fortnoxReadNormalizationStage.count({ where })).toBe(0)
        expect(await db.fortnoxReadContextSnapshot.count({ where })).toBe(0)
        expect(await db.fortnoxReadManifestPage.count({ where })).toBe(0)
        expect(await db.fortnoxReadVoucherCheckpoint.count({ where })).toBe(0)
      })
    } finally {
      await prisma.$disconnect()
    }
  })
  async function observed<T>(read: (client: TestPrisma) => Promise<T>): Promise<T> {
    const db = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      return await read(db)
    } finally {
      await db.$disconnect()
    }
  }
  async function fixture(details: readonly FortnoxVoucher[] = [raw(1)], duplicateManifest = false) {
    const org = randomUUID()
    await prisma.organization.create({
      data: {
        id: org,
        name: `synthetic-publication-pair-${org}`,
        email: `${org}@example.invalid`,
        street: 'Testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    orgs.add(org)
    const connection = await prisma.fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 900001,
        fortnoxOrgNumber: 'SYNTHETIC_PUBLICATION_PAIR',
      },
    })
    const owner = service()
    const run = await owner.start(org, null, INPUT)
    const lease = await owner.claim(org, run.id)
    if (!lease) throw new Error('Syntetiskt claim saknas')
    let progress = await owner.prepareNormalization(lease)
    while (progress.next) {
      await owner.normalizePage(lease, progress.next)
      progress = await owner.prepareNormalization(lease)
    }
    await owner.commitCatalog(lease, CATALOG)
    const numbers = details.map((d) => Number(d.VoucherNumber))
    const pages = duplicateManifest
      ? [
          [1, 2],
          [2, 3],
        ]
      : [numbers]
    for (const [i, entries] of pages.entries())
      await owner.commitVoucherPage(lease, {
        MetaInformation: {
          '@CurrentPage': i + 1,
          '@TotalPages': numbers.length ? pages.length : 0,
          '@TotalResources': numbers.length,
        },
        Vouchers: entries.map((n) => ({ Year: 1, VoucherSeries: 'L', VoucherNumber: n })),
      })
    for (const detail of [...details].sort((a, b) =>
      key(Number(a.VoucherNumber)) < key(Number(b.VoucherNumber)) ? -1 : 1,
    ))
      await owner.commitVoucherDetail(lease, key(Number(detail.VoucherNumber)), detail)
    const outcome = await owner.reduceReadyLedger(lease)
    const binding = await tx(async (client) => {
      const current = await client.fortnoxReadRun.findUniqueOrThrow({
        where: { id: run.id, organizationId: org },
      })
      const source = await readCheckpointSourceHeader(client, org, run.id)
      const stage = await readStoredCompletedNormalizationStage(client, current, source)
      return normalizedContextBinding(current, source, stage)
    })
    const encoded = encodeLedgerPublication(randomUUID(), binding, outcome)
    return { org, run, lease, connection, outcome, binding, encoded }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function durable(f: Fixture) {
    return observed(async (db) => ({
      organization: await db.organization.findUnique({ where: { id: f.org } }),
      run: await db.fortnoxReadRun.findUnique({ where: { id: f.run.id, organizationId: f.org } }),
      publications: await db.fortnoxReadPublication.findMany({
        where: { organizationId: f.org, runId: f.run.id },
      }),
    }))
  }
  async function frozen(f: Fixture) {
    return observed(async (db) => {
      const where = { organizationId: f.org }
      return {
        source: await db.fortnoxReadSourceCapture.findMany({ where }),
        mappings: await db.fortnoxReadSourceMapping.findMany({
          where,
          orderBy: { ordinal: 'asc' },
        }),
        exports: await db.fortnoxReadSourceExport.findMany({ where, orderBy: { ordinal: 'asc' } }),
        stages: await db.fortnoxReadNormalizationStage.findMany({ where }),
        normalization: await db.fortnoxReadNormalizationPage.findMany({
          where,
          orderBy: { id: 'asc' },
        }),
        snapshots: await db.fortnoxReadContextSnapshot.findMany({ where }),
        contextPages: await db.fortnoxReadContextPage.findMany({ where, orderBy: { id: 'asc' } }),
        manifest: await db.fortnoxReadManifestPage.findMany({ where, orderBy: { page: 'asc' } }),
        details: await db.fortnoxReadVoucherCheckpoint.findMany({ where, orderBy: { key: 'asc' } }),
        catalog: (await db.fortnoxReadRun.findUniqueOrThrow({ where: { id: f.run.id } })).catalog,
      }
    })
  }
  async function deferPair(client: Tx) {
    await client.$executeRaw`SET CONSTRAINTS "fortnox_publication_must_finish", "fortnox_run_publication_required" DEFERRED`
  }
  async function immediatePair(client: Tx) {
    await client.$executeRaw`SET CONSTRAINTS "fortnox_publication_must_finish", "fortnox_run_publication_required" IMMEDIATE`
  }
  async function insert(client: Tx, f: Fixture, encoded = f.encoded) {
    // Real callers take this order; INSERT's SQL guard repeats the same locks.
    await client.$queryRaw`SELECT "id" FROM "FortnoxConnection" WHERE "organizationId" = ${f.org} FOR UPDATE`
    await client.$queryRaw`SELECT "id" FROM "FortnoxReadRun" WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org} FOR UPDATE`
    await client.$queryRaw`SELECT "id" FROM "FortnoxReadNormalizationStage" WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org} FOR UPDATE`
    await deferPair(client)
    const row = await insertLedgerPublication(client, encoded)
    expect(row.id).toBe(encoded.id)
    expect(row.publishedAt).toBeInstanceOf(Date)
    expect(
      await client.fortnoxReadPublication.count({
        where: { id: row.id, organizationId: encoded.organizationId },
      }),
    ).toBe(1)
    return row
  }
  type FinishOptions = {
    status?: EncodedPublication['status']
    reason?: string | null
    completedAt?: Date
    retainClaim?: boolean
  }
  async function finish(client: Tx, f: Fixture, publishedAt: Date, options: FinishOptions = {}) {
    const status = options.status ?? f.encoded.status
    const reason = Object.hasOwn(options, 'reason') ? (options.reason ?? null) : f.encoded.reason
    const completedAt = options.completedAt ?? publishedAt
    const rows = await client.$queryRaw<Array<{ id: string; status: string }>>`
      UPDATE "FortnoxReadRun" SET "status" = ${status}::"FortnoxReadStatus", "reason" = ${reason},
        "completedAt" = timezone('UTC', ${completedAt}::timestamptz),
        "checkpointUpdatedAt" = timezone('UTC', clock_timestamp()),
        "claimToken" = ${options.retainClaim ? f.lease.claimToken : null},
        "leaseUntil" = ${options.retainClaim ? f.lease.leaseUntil : null}
      WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org} RETURNING "id", "status"`
    expect(rows).toStrictEqual([{ id: f.run.id, status }])
  }
  async function publishRaw(f: Fixture, afterPair?: (client: Tx) => Promise<void>) {
    return tx(async (client) => {
      const publication = await insert(client, f)
      await finish(client, f, publication.publishedAt)
      await immediatePair(client)
      await afterPair?.(client)
      return publication
    })
  }
  async function sqlReject(
    work: (client: Tx) => Promise<unknown>,
    code = '23514',
    message?: string,
  ) {
    await expect(
      tx(async (client) => {
        await work(client)
        // In particular, a broken TRUNCATE guard may never commit another test's data loss.
        throw new Error('UNEXPECTED_SQL_SUCCESS_ROLLBACK')
      }),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: {
        code,
        ...(message ? { message: expect.stringContaining(message) } : {}),
      },
    })
  }

  it('positiv SQL-kanarie: verklig reducering, Stockholm-tid och exakt beständigt slutpar', async () => {
    const f = await fixture()
    expect(f.outcome.kind).toBe('REDUCED')
    const beforeFrozen = await frozen(f)
    const publication = await tx(async (client) => {
      await client.$executeRaw`SET LOCAL TIME ZONE 'Europe/Stockholm'`
      await client.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
      const before = await client.$queryRaw<
        Array<{ now: number }>
      >`SELECT extract(epoch FROM clock_timestamp())::double precision * 1000 AS "now"`
      const p = await insert(client, f)
      await finish(client, f, p.publishedAt)
      await immediatePair(client)
      const times = await client.$queryRaw<
        Array<{ published: number; completed: number; now: number }>
      >`
        SELECT extract(epoch FROM p."publishedAt")::double precision * 1000 AS published,
          extract(epoch FROM (r."completedAt" AT TIME ZONE 'UTC'))::double precision * 1000 AS completed,
          extract(epoch FROM clock_timestamp())::double precision * 1000 AS "now"
        FROM "FortnoxReadPublication" p JOIN "FortnoxReadRun" r ON r."id" = p."runId"
        WHERE p."id" = ${p.id} AND p."organizationId" = ${f.org}`
      expect(times).toHaveLength(1)
      expect(Math.abs(times[0]!.published - p.publishedAt.getTime())).toBeLessThan(1)
      expect(times[0]!.completed).toBe(times[0]!.published)
      expect(p.publishedAt.getTime()).toBeGreaterThanOrEqual(before[0]!.now - 1)
      expect(p.publishedAt.getTime()).toBeLessThanOrEqual(times[0]!.now + 1)
      return p
    })
    const saved = await durable(f)
    expect(saved.publications).toHaveLength(1)
    expect(saved.publications[0]).toMatchObject({
      id: f.encoded.id,
      publishedAt: publication.publishedAt,
      status: f.encoded.status,
      resultDigest: f.encoded.resultDigest,
      canonicalBytes: BigInt(f.encoded.canonicalBytes!),
      publicationDigest: f.encoded.publicationDigest,
    })
    expect(saved.run).toMatchObject({
      status: f.encoded.status,
      completedAt: publication.publishedAt,
      phase: 'READY_TO_REDUCE',
      claimToken: null,
      leaseUntil: null,
      frozenContext: null,
      summary: null,
      rows: null,
      coverage: {},
      uncertainties: [],
    })
    expect(
      await observed((db) => service(db).readPublicationReceipt(f.org, f.run.id)),
    ).toMatchObject({
      id: publication.id,
      publicationDigest: f.encoded.publicationDigest,
      proof: f.outcome.proof,
    })
    expect(await frozen(f)).toStrictEqual(beforeFrozen)
  })

  it('SQL skiljer manifestets SUM=4 från tre unika checkpoints och binder alla proofräknare', async () => {
    const f = await fixture([raw(1), raw(2), raw(3)], true)
    const before = await durable(f)
    expect(f.outcome.proof).toMatchObject({
      manifestPageCount: 2,
      manifestItemsSeen: 4,
      voucherCount: 3,
    })
    for (const change of [
      { manifestPageCount: 1 },
      { manifestItemsSeen: 3 },
      { voucherCount: 4 },
    ]) {
      await sqlReject((client) =>
        insertLedgerPublication(client, {
          ...f.encoded,
          proofJson: changedJson(f.encoded.proofJson, change),
        }),
      )
      expect(await durable(f)).toStrictEqual(before)
    }
    await publishRaw(f)
    expect((await durable(f)).publications[0]!.proof).toStrictEqual(f.outcome.proof)
  })

  it('SQL nekar felaktig fryst bindning, identitet, claim, källhash och extra proofnycklar', async () => {
    const f = await fixture()
    const before = await durable(f)
    const variants: EncodedPublication[] = [
      { ...f.encoded, bindingJson: 'null' },
      { ...f.encoded, proofJson: 'null' },
      { ...f.encoded, bindingJson: changedJson(f.encoded.bindingJson, { stageId: randomUUID() }) },
      {
        ...f.encoded,
        bindingJson: changedJson(f.encoded.bindingJson, {
          counts: { MAPPINGS: 1, OWN_EXPORTS: 0 },
        }),
      },
      {
        ...f.encoded,
        bindingJson: changedJson(f.encoded.bindingJson, {
          connection: { ...f.binding.connection, generation: f.binding.connection.generation + 1 },
        }),
      },
      {
        ...f.encoded,
        bindingJson: changedJson(f.encoded.bindingJson, {
          input: { ...f.binding.input, periodTo: '2026-10-30' },
        }),
      },
      ...[
        { runId: randomUUID() },
        { sourceCaptureId: randomUUID() },
        { snapshotId: randomUUID() },
        { sourceDigest: 'f'.repeat(64) },
        { snapshotDigest: 'e'.repeat(64) },
        { claimVersion: f.lease.claimVersion + 1 },
        { catalogDigest: 'invalid' },
        { extra: true },
      ].map((change) => ({ ...f.encoded, proofJson: changedJson(f.encoded.proofJson, change) })),
    ]
    for (const encoded of variants) {
      await sqlReject((client) => insertLedgerPublication(client, encoded))
      expect(await durable(f)).toStrictEqual(before)
    }
    // Positive control uses precisely the same valid DB parent chain and INSERT.
    await publishRaw(f)
  })

  it('direkt SQL kan inte kringgå formatversion 1 med en i övrigt verklig giltig publicering', async () => {
    const f = await fixture(),
      before = await durable(f),
      e = f.encoded
    // The typed writer only exposes version 1. This single adversarial SQL
    // statement tests the DB boundary for a version it cannot express.
    await sqlReject(
      (client) => client.$executeRaw`
      INSERT INTO "FortnoxReadPublication"
        ("id", "organizationId", "runId", "formatVersion", "status", "failureCode", "reason",
         "binding", "proof", "resultDigest", "canonicalBytes", "publicationDigest",
         "financialYear", "summary", "rows", "coverage", "uncertainties")
      VALUES (${e.id}, ${e.organizationId}, ${e.runId}, 2, ${e.status}::"FortnoxReadStatus",
        ${e.failureCode}, ${e.reason}, ${e.bindingJson}::jsonb, ${e.proofJson}::jsonb,
        ${e.resultDigest}, ${e.canonicalBytes === null ? null : BigInt(e.canonicalBytes)},
        ${e.publicationDigest}, ${e.financialYearJson}::jsonb, ${e.summaryJson}::jsonb,
        ${e.rowsJson}::jsonb, ${e.coverageJson}::jsonb, ${e.uncertaintiesJson}::jsonb)`,
    )
    expect(await durable(f)).toStrictEqual(before)
    await publishRaw(f)
  })

  it('befintlig främmande organisation och saknad run ger exakt scoped FK-avslag', async () => {
    const f = await fixture(),
      foreign = await fixture()
    const before = await durable(f),
      foreignBefore = await durable(foreign)
    for (const encoded of [
      { ...f.encoded, organizationId: foreign.org },
      { ...f.encoded, runId: randomUUID() },
    ])
      await sqlReject((client) => insertLedgerPublication(client, encoded), '23503')
    expect(await durable(f)).toStrictEqual(before)
    expect(await durable(foreign)).toStrictEqual(foreignBefore)
  })

  it('success kräver SQL-nonnull, rätt JSON-form, exakt år och rows/references-envelope', async () => {
    const f = await fixture()
    const before = await durable(f)
    const variants: EncodedPublication[] = [
      { ...f.encoded, resultDigest: null },
      { ...f.encoded, resultDigest: 'NOT_A_HASH' },
      { ...f.encoded, publicationDigest: 'NOT_A_HASH' },
      { ...f.encoded, canonicalBytes: null },
      { ...f.encoded, canonicalBytes: -1 },
      { ...f.encoded, canonicalBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...f.encoded, summaryJson: null },
      { ...f.encoded, summaryJson: 'null' },
      { ...f.encoded, summaryJson: '[]' },
      { ...f.encoded, coverageJson: 'null' },
      { ...f.encoded, uncertaintiesJson: '{}' },
      { ...f.encoded, rowsJson: '[]' },
      { ...f.encoded, rowsJson: '{"rows":[]}' },
      { ...f.encoded, rowsJson: '{"rows":[],"references":[],"extra":true}' },
      { ...f.encoded, rowsJson: '{"rows":null,"references":[]}' },
      { ...f.encoded, financialYearJson: JSON.stringify({ ...YEAR, id: 2 }) },
      { ...f.encoded, failureCode: 'AMOUNT_OVERFLOW' },
    ]
    for (const encoded of variants) {
      await sqlReject((client) => insertLedgerPublication(client, encoded))
      expect(await durable(f)).toStrictEqual(before)
    }
    await publishRaw(f)
  })

  it('verklig overflow är ett giltigt par men JSON-null eller payload får aldrig ersätta SQL NULL', async () => {
    const f = await fixture([raw(1, 9007199254740990), raw(2, 2)])
    expect(f.outcome.kind).toBe('FAILED')
    expect(f.encoded).toMatchObject({
      status: 'FAILED',
      failureCode: 'AMOUNT_OVERFLOW',
      reason: PUBLICATION_OVERFLOW_REASON,
    })
    const before = await durable(f)
    for (const encoded of [
      { ...f.encoded, summaryJson: 'null' },
      { ...f.encoded, rowsJson: '{}' },
      { ...f.encoded, financialYearJson: JSON.stringify(YEAR) },
      { ...f.encoded, resultDigest: 'a'.repeat(64) },
      { ...f.encoded, canonicalBytes: 0 },
      { ...f.encoded, failureCode: null },
      { ...f.encoded, reason: null },
    ]) {
      await sqlReject((client) => insertLedgerPublication(client, encoded))
      expect(await durable(f)).toStrictEqual(before)
    }
    await publishRaw(f)
    const saved = await durable(f)
    expect(saved.publications[0]).toMatchObject({
      status: 'FAILED',
      summary: null,
      rows: null,
      coverage: null,
      uncertainties: null,
      financialYear: null,
      resultDigest: null,
      canonicalBytes: null,
    })
    const [nulls] = await prisma.$queryRaw<Array<{ allSqlNull: boolean }>>`
      SELECT ("summary" IS NULL AND "rows" IS NULL AND "coverage" IS NULL AND "uncertainties" IS NULL
        AND "financialYear" IS NULL AND "resultDigest" IS NULL AND "canonicalBytes" IS NULL) AS "allSqlNull"
      FROM "FortnoxReadPublication" WHERE "id" = ${f.encoded.id} AND "organizationId" = ${f.org}`
    expect(nulls?.allSqlNull).toBe(true)
    expect(
      await observed((db) => service(db).readPublicationReceipt(f.org, f.run.id)),
    ).toMatchObject({
      status: 'FAILED',
      failureCode: 'AMOUNT_OVERFLOW',
      resultDigest: null,
      canonicalBytes: null,
    })
  })

  it.each(['insert', 'terminal'] as const)(
    'propagerat JS-fel efter verklig %s rullar tillbaka hela caller-TX',
    async (point) => {
      const f = await fixture(),
        before = await durable(f)
      const injected = new Error(`SYNTHETIC_AFTER_${point}`)
      let actualWrite = false
      await expect(
        tx(async (client) => {
          const p = await insert(client, f)
          if (point === 'terminal') await finish(client, f, p.publishedAt)
          actualWrite = true
          await client.organization.update({
            where: { id: f.org },
            data: { name: `synthetic-marker-${point}` },
          })
          throw injected
        }),
      ).rejects.toBe(injected)
      expect(actualWrite).toBe(true)
      expect(await durable(f)).toStrictEqual(before)
    },
  )

  it('fångat JS-fel efter INSERT får inte committa orphan eller callers marköruppdateringar', async () => {
    const f = await fixture(),
      before = await durable(f)
    const injected = new Error('SYNTHETIC_CAUGHT_AFTER_INSERT')
    let inserted = false,
      caught = false,
      reachedReturn = false
    // Prisma 5.22 has been observed resolving a callback despite a deferred
    // COMMIT rejection. Do not require that engine bug: observe DB atomically
    // through a NEW client, whether this engine resolves or rejects the promise.
    const settled = await Promise.allSettled([
      tx(async (client) => {
        await client.organization.update({
          where: { id: f.org },
          data: { name: 'synthetic-before-catch' },
        })
        try {
          await insert(client, f)
          inserted = true
          throw injected
        } catch (error) {
          if (error !== injected) throw error
          caught = true
        }
        await client.organization.update({
          where: { id: f.org },
          data: { name: 'synthetic-after-catch' },
        })
        reachedReturn = true
      }),
    ])
    expect(settled).toHaveLength(1)
    expect({ inserted, caught, reachedReturn }).toStrictEqual({
      inserted: true,
      caught: true,
      reachedReturn: true,
    })
    expect(await durable(f)).toStrictEqual(before)
  })

  it('namngiven IMMEDIATE avvisar samma verkliga orphan med SQLSTATE 23514 före COMMIT', async () => {
    const f = await fixture(),
      before = await durable(f)
    let inserted = false
    await sqlReject(async (client) => {
      await insert(client, f)
      inserted = true
      await immediatePair(client)
    })
    expect(inserted).toBe(true)
    expect(await durable(f)).toStrictEqual(before)
  })

  it.each(['COMPLETE', 'COMPLETE_WITH_UNCERTAINTY', 'FAILED'] as const)(
    'terminal %s utan publicering nekas; ingen falsk slutsignal',
    async (status) => {
      const f = await fixture(),
        before = await durable(f)
      await sqlReject(async (client) => {
        await deferPair(client)
        await finish(client, f, new Date(), {
          status,
          reason: status === 'FAILED' ? PUBLICATION_OVERFLOW_REASON : null,
        })
        await immediatePair(client)
      })
      expect(await durable(f)).toStrictEqual(before)
    },
  )

  it('annan FAILED är fortsatt tillåten utan publikation, men får inte avsluta en redan insatt publikation', async () => {
    const f = await fixture(),
      before = await durable(f)
    let inserted = false,
      stopped = false
    await sqlReject(async (client) => {
      const p = await insert(client, f)
      inserted = true
      await finish(client, f, p.publishedAt, {
        status: 'FAILED',
        reason: 'SYNTHETIC_OTHER_FAILURE',
      })
      stopped = true
      await immediatePair(client)
    })
    expect({ inserted, stopped }).toStrictEqual({ inserted: true, stopped: true })
    expect(await durable(f)).toStrictEqual(before)
    await tx(async (client) => {
      await finish(client, f, new Date(), { status: 'FAILED', reason: 'SYNTHETIC_OTHER_FAILURE' })
      await immediatePair(client)
    })
    const saved = await durable(f)
    expect(saved.publications).toHaveLength(0)
    expect(saved.run).toMatchObject({
      status: 'FAILED',
      reason: 'SYNTHETIC_OTHER_FAILURE',
      claimToken: null,
      leaseUntil: null,
    })
  })

  it.each(['status', 'time', 'claim'] as const)(
    'ett insatt resultat tillåter inte fel terminal-%s',
    async (field) => {
      const f = await fixture(),
        before = await durable(f)
      let inserted = false
      await sqlReject(async (client) => {
        const p = await insert(client, f)
        inserted = true
        const options: FinishOptions =
          field === 'status'
            ? { status: f.encoded.status === 'COMPLETE' ? 'COMPLETE_WITH_UNCERTAINTY' : 'COMPLETE' }
            : field === 'time'
              ? { completedAt: new Date(p.publishedAt.getTime() - 1000) }
              : { retainClaim: true }
        await finish(client, f, p.publishedAt, options)
        await immediatePair(client)
      })
      expect(inserted).toBe(true)
      expect(await durable(f)).toStrictEqual(before)
    },
  )

  it('giltigt helt par och IMMEDIATE får committa även när ett senare JS-fel fångas', async () => {
    const f = await fixture()
    const injected = new Error('SYNTHETIC_CAUGHT_AFTER_VALID_PAIR')
    let caught = false
    const p = await publishRaw(f, async (client) => {
      try {
        throw injected
      } catch (error) {
        if (error !== injected) throw error
        caught = true
      }
      await client.organization.update({
        where: { id: f.org },
        data: { name: 'synthetic-valid-pair-marker' },
      })
    })
    expect(caught).toBe(true)
    const saved = await durable(f)
    expect(saved.organization?.name).toBe('synthetic-valid-pair-marker')
    expect(saved.publications).toHaveLength(1)
    expect(saved.run).toMatchObject({ status: f.encoded.status, completedAt: p.publishedAt })
    expect(
      await observed((db) => service(db).readPublicationReceipt(f.org, f.run.id)),
    ).toMatchObject({
      id: p.id,
      proof: f.outcome.proof,
      publicationDigest: f.encoded.publicationDigest,
    })
  })

  it.each([
    'update',
    'update-zero',
    'delete',
    'truncate',
    'run-delete',
    'run-reopen',
    'run-rebind',
  ] as const)(
    'beständigt par avvisar %s och lämnar främmande sentinel oförändrad',
    async (operation) => {
      const f = await fixture(),
        foreign = await fixture()
      await publishRaw(f)
      await publishRaw(foreign)
      const before = await durable(f),
        foreignBefore = await durable(foreign)
      await sqlReject(async (client) => {
        if (operation === 'update')
          await client.$executeRaw`UPDATE "FortnoxReadPublication" SET "reason" = "reason" WHERE "id" = ${f.encoded.id}`
        if (operation === 'update-zero')
          await client.$executeRaw`UPDATE "FortnoxReadPublication" SET "reason" = "reason" WHERE "id" = ${randomUUID()}`
        if (operation === 'delete')
          await client.$executeRaw`DELETE FROM "FortnoxReadPublication" WHERE "id" = ${f.encoded.id} AND "organizationId" = ${f.org}`
        if (operation === 'truncate')
          await client.$executeRaw`TRUNCATE TABLE "FortnoxReadPublication"`
        if (operation === 'run-delete')
          await client.$executeRaw`DELETE FROM "FortnoxReadRun" WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org}`
        if (operation === 'run-reopen')
          await client.$executeRaw`UPDATE "FortnoxReadRun" SET "status" = 'RUNNING', "completedAt" = NULL WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org}`
        if (operation === 'run-rebind')
          await client.$executeRaw`UPDATE "FortnoxReadRun" SET "sourceCaptureId" = ${foreign.run.id} WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org}`
      })
      expect(await durable(f)).toStrictEqual(before)
      expect(await durable(foreign)).toStrictEqual(foreignBefore)
    },
  )

  it('terminal publicering öppnar inte manifest eller detaljer för nya barnrader', async () => {
    const f = await fixture()
    await publishRaw(f)
    const before = await durable(f),
      beforeFrozen = await frozen(f)
    await sqlReject(
      (client) => client.$executeRaw`
      INSERT INTO "FortnoxReadManifestPage"
        ("id", "organizationId", "runId", "page", "totalPages", "totalResources", "itemCount", "digest", "entries", "createdAt")
      SELECT ${randomUUID()}, "organizationId", "runId", "page" + 1, "totalPages", "totalResources", "itemCount", "digest", "entries", "createdAt"
      FROM "FortnoxReadManifestPage" WHERE "runId" = ${f.run.id} AND "organizationId" = ${f.org} AND "page" = 1`,
      '23514',
      'V2 manifest child requires manifest phase',
    )
    await sqlReject(
      (client) => client.$executeRaw`
      INSERT INTO "FortnoxReadVoucherCheckpoint" ("id", "organizationId", "runId", "key", "manifestDigest")
      SELECT ${randomUUID()}, "organizationId", "runId", '1|L|999', "manifestDigest"
      FROM "FortnoxReadVoucherCheckpoint" WHERE "runId" = ${f.run.id} AND "organizationId" = ${f.org} AND "key" = ${key(1)}`,
      '23514',
      'V2 manifest child requires manifest phase',
    )
    expect(await durable(f)).toStrictEqual(before)
    expect(await frozen(f)).toStrictEqual(beforeFrozen)
  })

  it('verklig organisationscascade tar hela ägda kedjan men bevarar ett främmande giltigt par', async () => {
    const f = await fixture(),
      foreign = await fixture()
    await publishRaw(f)
    await publishRaw(foreign)
    const foreignBefore = await durable(foreign),
      frozenForeign = await frozen(foreign)
    await prisma.organization.delete({ where: { id: f.org } })
    orgs.delete(f.org)
    expect(await durable(f)).toStrictEqual({ organization: null, run: null, publications: [] })
    const removed = await frozenExceptCatalog(f.org)
    expect(removed.every((count) => count === 0)).toBe(true)
    expect(await durable(foreign)).toStrictEqual(foreignBefore)
    expect(await frozen(foreign)).toStrictEqual(frozenForeign)
    expect(
      await observed((db) => service(db).readPublicationReceipt(foreign.org, foreign.run.id)),
    ).toMatchObject({
      id: foreign.encoded.id,
      publicationDigest: foreign.encoded.publicationDigest,
    })
  })
  async function frozenExceptCatalog(org: string) {
    return observed(async (db) => {
      const where = { organizationId: org }
      return Promise.all([
        db.fortnoxConnection.count({ where }),
        db.fortnoxReadSourceCapture.count({ where }),
        db.fortnoxReadSourceMapping.count({ where }),
        db.fortnoxReadSourceExport.count({ where }),
        db.fortnoxReadNormalizationStage.count({ where }),
        db.fortnoxReadNormalizationPage.count({ where }),
        db.fortnoxReadContextSnapshot.count({ where }),
        db.fortnoxReadContextPage.count({ where }),
        db.fortnoxReadManifestPage.count({ where }),
        db.fortnoxReadVoucherCheckpoint.count({ where }),
      ])
    })
  }
})
