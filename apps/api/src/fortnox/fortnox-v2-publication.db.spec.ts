/** Real synthetic PostgreSQL publication tests.
 * All setup follows the existing source→normalization→catalog→manifest→details
 * service. No provider calls, trigger bypass or real customer data.
 */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Prisma, PrismaClient } from '@prisma/client'
import { FortnoxReadSourceRunService } from './fortnox-read-source-run.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import type { FortnoxVoucher } from './fortnox.types'
import { decodeLedgerResult } from './fortnox-read-result-format'
import {
  decodeLedgerPublication,
  PublicationFormatError,
  PUBLICATION_OVERFLOW_REASON,
} from './fortnox-read-publication-format'

const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: '2026-01-01',
  financialYearEnd: '2026-12-31',
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const YEAR = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const EMPTY_COVERAGE = { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 }
const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'
const EXPIRED = 'Läsanspråket har upphört'
const key = (n: number) => `1|L|${n}`

function isolatedUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Publiceringsproven kräver explicit syntetisk DATABASE_URL')
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Publiceringsproven tillåter endast egen lokal testdatabas eller CI')
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
type Hooks = {
  before?: (params: Prisma.MiddlewareParams) => Promise<void>
  after?: (params: Prisma.MiddlewareParams, value: unknown) => Promise<void>
  transform?: (params: Prisma.MiddlewareParams, value: unknown) => unknown
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
function digest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')
}
function rawText(params: Prisma.MiddlewareParams): string {
  // Query text only, never bound params/payload/tokens. Prisma raw middleware
  // maps Prisma.sql to [Sql] and tagged templates to [strings, ...values].
  if (params.action !== 'queryRaw' && params.action !== 'executeRaw') return ''
  const args: unknown = params.args
  const first: unknown = Array.isArray(args) ? args[0] : args
  if (typeof first === 'string') return first
  if (Array.isArray(first) && first.every((part) => typeof part === 'string'))
    return first.join('?')
  if (record(first) && typeof first.sql === 'string') return first.sql
  return ''
}
const publicationInsert = (p: Prisma.MiddlewareParams) =>
  /INSERT INTO "FortnoxReadPublication"/.test(rawText(p))
function raw(n: number, ore = 1): FortnoxVoucher {
  return {
    Year: 1,
    VoucherSeries: 'L',
    VoucherNumber: n,
    TransactionDate: '2026-10-01',
    ReferenceNumber: `R${n}`,
    VoucherRows: [
      { Account: 5170, Debit: ore / 100 },
      { Account: 2440, Credit: ore / 100 },
    ],
  }
}
const catalog: CheckpointCatalog = {
  version: 1,
  companyDatabaseNumber: 900001,
  financialYear: { ...YEAR, accountingMethod: 'ACCRUAL' },
  accounts: [{ number: 5170, active: null, balanceBroughtForwardOre: null }],
  dimensions: [],
  coverage: { costCenters: EMPTY_COVERAGE },
}

describe('Intern v2-publicering: beständigt atomiskt slutpar', () => {
  let prisma: TestPrisma
  const orgs = new Set<string>()
  const owner = (client = prisma) => new FortnoxReadSourceRunService(client)
  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
  })
  afterAll(async () => {
    try {
      for (const id of orgs) await prisma.organization.delete({ where: { id } })
      const observer = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
      try {
        const where = { organizationId: { in: [...orgs] } }
        expect(await observer.fortnoxReadPublication.count({ where })).toBe(0)
        expect(await observer.fortnoxReadRun.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceCapture.count({ where })).toBe(0)
        expect(await observer.fortnoxReadNormalizationStage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadContextPage.count({ where })).toBe(0)
      } finally {
        await observer.$disconnect()
      }
    } finally {
      await prisma.$disconnect()
    }
  })
  async function controlled() {
    const url = new URL(DATABASE_URL)
    url.searchParams.set('connection_limit', '1')
    const client = new TestPrisma({ datasources: { db: { url: url.toString() } } })
    const hooks: Hooks = {}
    client.$use(async (params, next) => {
      await hooks.before?.(params)
      const result: unknown = await next(params)
      await hooks.after?.(params, result)
      return hooks.transform ? hooks.transform(params, result) : result
    })
    await client.$connect()
    return { client, hooks }
  }
  async function fixture(
    details: readonly FortnoxVoucher[] = [raw(1)],
    customPages?: readonly (readonly number[])[],
  ) {
    const org = randomUUID()
    await prisma.organization.create({
      data: {
        id: org,
        name: `synthetic-v2-publication-${org}`,
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
        fortnoxOrgNumber: 'SYNTHETIC_PUBLICATION',
      },
    })
    const service = owner(),
      run = await service.start(org, null, INPUT)
    const lease = await service.claim(org, run.id)
    if (!lease) throw new Error('Syntetiskt claim saknas')
    let progress = await service.prepareNormalization(lease)
    while (progress.next) {
      await service.normalizePage(lease, progress.next)
      progress = await service.prepareNormalization(lease)
    }
    await service.commitCatalog(lease, catalog)
    const numbers = details.map((d) => Number(d.VoucherNumber))
    const pages =
      customPages ??
      Array.from({ length: Math.max(1, Math.ceil(numbers.length / 100)) }, (_, i) =>
        numbers.slice(i * 100, (i + 1) * 100),
      )
    for (const [i, entries] of pages.entries())
      await service.commitVoucherPage(lease, {
        MetaInformation: {
          '@CurrentPage': i + 1,
          '@TotalPages': numbers.length ? pages.length : 0,
          '@TotalResources': numbers.length,
        },
        Vouchers: entries.map((n) => ({ Year: 1, VoucherSeries: 'L', VoucherNumber: n })),
      })
    for (const d of [...details].sort((a, b) =>
      key(Number(a.VoucherNumber)) < key(Number(b.VoucherNumber)) ? -1 : 1,
    ))
      await service.commitVoucherDetail(lease, key(Number(d.VoucherNumber)), d)
    return { org, run, lease, connection }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function durable(f: Fixture) {
    const observer = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      return {
        run: await observer.fortnoxReadRun.findUniqueOrThrow({
          where: { id: f.run.id, organizationId: f.org },
        }),
        publications: await observer.fortnoxReadPublication.findMany({
          where: { organizationId: f.org, runId: f.run.id },
        }),
      }
    } finally {
      await observer.$disconnect()
    }
  }
  async function historical(f: Fixture) {
    const observer = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    try {
      return await owner(observer).readPublicationReceipt(f.org, f.run.id)
    } finally {
      await observer.$disconnect()
    }
  }
  function body(row: Awaited<ReturnType<typeof durable>>['publications'][number]) {
    return decodeLedgerResult({
      formatVersion: row.formatVersion,
      resultDigest: row.resultDigest,
      canonicalBytes: Number(row.canonicalBytes),
      status: row.status,
      reason: row.reason,
      summary: row.summary,
      rows: row.rows,
      coverage: row.coverage,
      uncertainties: row.uncertainties,
      financialYear: row.financialYear,
    })
  }
  async function databaseAfter(f: Fixture) {
    const { leaseUntil } = await prisma.fortnoxReadRun.findUniqueOrThrow({
      where: { id: f.run.id },
      select: { leaseUntil: true },
    })
    if (!leaseUntil) throw new Error('Aktuell committed deadline saknas')
    const end = Date.now() + 2500
    while (Date.now() < end) {
      const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      if (clock && clock.now > leaseUntil) return
      await pause(10)
    }
    throw new Error('Verklig DB-deadline passerades inte')
  }

  it('tom riktig kedja bevarar helt handfacit och återläses från ny klient', async () => {
    const f = await fixture([]),
      reduced = await owner().reduceReadyLedger(f.lease)
    expect(reduced.kind).toBe('REDUCED')
    expect((await durable(f)).publications).toEqual([])
    const expected = {
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
    }
    const receipt = await owner().publishReadyLedger(f.lease),
      saved = await durable(f)
    expect(saved.publications).toHaveLength(1)
    expect(body(saved.publications[0]!)).toStrictEqual(expected)
    expect(receipt.resultDigest).toBe(digest(expected))
    expect(receipt.canonicalBytes).toBe(Buffer.byteLength(JSON.stringify(ordered(expected))))
    expect(await historical(f)).toStrictEqual(receipt)
    expect(saved.run).toMatchObject({
      status: 'COMPLETE',
      phase: 'READY_TO_REDUCE',
      summary: null,
      rows: null,
      frozenContext: null,
      coverage: {},
      uncertainties: [],
      claimToken: null,
      leaseUntil: null,
      claimVersion: f.lease.claimVersion,
      completedAt: receipt.publishedAt,
    })
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'id',
        'organizationId',
        'runId',
        'formatVersion',
        'status',
        'failureCode',
        'reason',
        'publishedAt',
        'claimVersion',
        'resultDigest',
        'canonicalBytes',
        'publicationDigest',
        'proof',
      ].sort(),
    )
  })

  it('manifestsidornas fyra förekomster bevaras men tre unika verifikationer summeras', async () => {
    const f = await fixture(
      [raw(1), raw(2), raw(3)],
      [
        [1, 2],
        [2, 3],
      ],
    )
    const receipt = await owner().publishReadyLedger(f.lease)
    expect(receipt.proof).toMatchObject({
      manifestPageCount: 2,
      manifestItemsSeen: 4,
      voucherCount: 3,
    })
    const actual = body((await durable(f)).publications[0]!)
    expect(actual.summary.totalOre).toBe(3)
    expect(actual.rows.map((r) => [r.voucher, r.amountOre])).toEqual([
      [key(1), 1],
      [key(2), 1],
      [key(3), 1],
    ])
    expect(actual.coverage['/3/vouchers/sublist']).toEqual({
      pages: 2,
      totalPages: 2,
      totalResources: 3,
      itemsSeen: 4,
    })
    expect(await historical(f)).toStrictEqual(receipt)
  })

  it('verklig overflow efter fulla A–F ger bara proof och SQL NULL i alla ekonomiska fält', async () => {
    const f = await fixture(
      Array.from({ length: 101 }, (_, i) =>
        raw(i + 1, i === 0 ? 9007199254740990 : i === 9 ? 2 : 0),
      ),
    )
    const receipt = await owner().publishReadyLedger(f.lease),
      saved = await durable(f)
    expect(receipt).toMatchObject({
      status: 'FAILED',
      failureCode: 'AMOUNT_OVERFLOW',
      reason: PUBLICATION_OVERFLOW_REASON,
      resultDigest: null,
      canonicalBytes: null,
    })
    expect(receipt.proof).toMatchObject({
      voucherCount: 101,
      manifestItemsSeen: 101,
      manifestPageCount: 2,
    })
    const [isNull] = await prisma.$queryRaw<Array<{ allNull: boolean }>>`SELECT
      "summary" IS NULL AND "rows" IS NULL AND "coverage" IS NULL AND "uncertainties" IS NULL
      AND "financialYear" IS NULL AND "resultDigest" IS NULL AND "canonicalBytes" IS NULL AS "allNull"
      FROM "FortnoxReadPublication" WHERE "runId" = ${f.run.id} AND "organizationId" = ${f.org}`
    expect(isNull?.allNull).toBe(true)
    expect(saved.publications).toHaveLength(1)
    expect(saved.run.status).toBe('FAILED')
    expect(await historical(f)).toStrictEqual(receipt)
  }, 45_000)

  it.each(['insert', 'terminal'] as const)(
    'propagerat fel efter faktisk %s rullar tillbaka hela paret',
    async (point) => {
      const f = await fixture(),
        before = await durable(f),
        c = await controlled(),
        failure = new Error('SYNTHETIC_AFTER_ACTUAL_WRITE')
      let observed = false
      c.hooks.after = async (params, value) => {
        if (
          (point === 'insert' && publicationInsert(params)) ||
          (point === 'terminal' &&
            params.model === 'FortnoxReadRun' &&
            params.action === 'update' &&
            record(params.args.data) &&
            params.args.data.status === 'COMPLETE')
        ) {
          if (point === 'insert')
            expect(value).toEqual([{ id: expect.any(String), publishedAt: expect.any(Date) }])
          else expect(value).toEqual({ id: f.run.id, status: 'COMPLETE' })
          observed = true
          throw failure
        }
      }
      try {
        await expect(owner(c.client).publishReadyLedger(f.lease)).rejects.toBe(failure)
        expect(observed).toBe(true)
        expect(await durable(f)).toStrictEqual(before)
      } finally {
        await c.client.$disconnect()
      }
    },
  )

  it.each(['insert', 'immediate'] as const)(
    'utgången verklig lease efter %s rullar tillbaka båda skriverna',
    async (point) => {
      const f = await fixture(),
        c = await controlled(),
        service = new ShortLeaseService(c.client)
      await owner().release(f.lease)
      const lease = await service.claim(f.org, f.run.id)
      if (!lease) throw new Error('Kort claim saknas')
      let observed = false,
        deadlinePassed = false
      const writes: string[] = []
      c.hooks.after = async (params) => {
        const sql = rawText(params)
        const pairImmediate =
          /SET CONSTRAINTS/.test(sql) &&
          /IMMEDIATE/.test(sql) &&
          sql.includes('fortnox_publication_must_finish') &&
          sql.includes('fortnox_run_publication_required')
        if (publicationInsert(params)) writes.push('insert')
        if (
          params.model === 'FortnoxReadRun' &&
          params.action === 'update' &&
          record(params.args.data) &&
          params.args.data.status === 'COMPLETE'
        )
          writes.push('terminal')
        if (pairImmediate) writes.push('immediate')
        if (
          (point === 'insert' && publicationInsert(params)) ||
          (point === 'immediate' && pairImmediate)
        ) {
          observed = true
          await databaseAfter(f)
          deadlinePassed = true
        }
      }
      try {
        await expect(service.publishReadyLedger(lease)).rejects.toThrow(EXPIRED)
        expect(observed).toBe(true)
        expect(deadlinePassed).toBe(true)
        expect(writes).toEqual(
          point === 'insert' ? ['insert'] : ['insert', 'terminal', 'immediate'],
        )
        const saved = await durable(f)
        expect(saved.publications).toEqual([])
        expect(saved.run).toMatchObject({
          status: 'RUNNING',
          completedAt: null,
          claimVersion: lease.claimVersion,
        })
      } finally {
        await c.client.$disconnect()
      }
    },
    20_000,
  )

  it('tappad lyckad retur återfinns historiskt även efter disconnect; stale publish återupptas aldrig', async () => {
    const f = await fixture()
    let returned: Awaited<ReturnType<FortnoxReadSourceRunService['publishReadyLedger']>> | undefined
    const lost = new Error('SYNTHETIC_LOST_RETURN')
    await expect(
      (async () => {
        returned = await owner().publishReadyLedger(f.lease)
        throw lost
      })(),
    ).rejects.toBe(lost)
    expect(returned).toBeDefined()
    await prisma.fortnoxConnection.update({
      where: { id: f.connection.id },
      data: { status: 'DISCONNECTED', generation: { increment: 1 } },
    })
    expect(await historical(f)).toStrictEqual(returned)
    await expect(owner().publishReadyLedger(f.lease)).rejects.toThrow(EXPIRED)
    expect((await durable(f)).publications).toHaveLength(1)
    expect(await owner().readPublicationReceipt(randomUUID(), f.run.id)).toBeNull()
  })

  it('reader avvisar verkligt läst body med gammal digest och lämnar lagringen orörd', async () => {
    const f = await fixture(),
      receipt = await owner().publishReadyLedger(f.lease),
      before = await durable(f),
      c = await controlled()
    let observed = false
    c.hooks.transform = (params, value) => {
      if (
        params.model === 'FortnoxReadPublication' &&
        params.action === 'findUnique' &&
        record(value) &&
        record(value.summary)
      ) {
        observed = true
        return { ...value, summary: { ...value.summary, totalOre: 999 } }
      }
      return value
    }
    try {
      await expect(owner(c.client).readPublicationReceipt(f.org, f.run.id)).rejects.toBeInstanceOf(
        PublicationFormatError,
      )
      expect(observed).toBe(true)
      expect(await durable(f)).toStrictEqual(before)
      expect(await historical(f)).toStrictEqual(receipt)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('ett verkligt PG-fel efter INSERT propageras och lämnar inget halvt par', async () => {
    const f = await fixture(),
      before = await durable(f),
      c = await controlled()
    let observed = false
    c.hooks.after = async (params, value) => {
      if (publicationInsert(params)) {
        expect(value).toEqual([{ id: expect.any(String), publishedAt: expect.any(Date) }])
        observed = true
        await prisma.$queryRaw`SELECT 1/0`
      }
    }
    try {
      await expect(owner(c.client).publishReadyLedger(f.lease)).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '22012' },
      })
      expect(observed).toBe(true)
      expect(await durable(f)).toStrictEqual(before)
    } finally {
      await c.client.$disconnect()
    }
  })

  it('fel efter första riktiga P3-SELECT lämnar ett återläsbart committat par utan automatisk retry', async () => {
    const f = await fixture(),
      c = await controlled(),
      failure = new Error('SYNTHETIC_P3_READ_FAILURE')
    let inserts = 0,
      read = false
    c.hooks.after = async (params, value) => {
      if (publicationInsert(params)) inserts++
      if (params.model === 'FortnoxReadPublication' && params.action === 'findUnique') {
        expect(value).toMatchObject({ runId: f.run.id, organizationId: f.org, status: 'COMPLETE' })
        read = true
        throw failure
      }
    }
    try {
      await expect(owner(c.client).publishReadyLedger(f.lease)).rejects.toBe(failure)
      expect(read).toBe(true)
      expect(inserts).toBe(1)
      const saved = await durable(f)
      expect(saved.publications).toHaveLength(1)
      expect(saved.run.status).toBe('COMPLETE')
      const receipt = await historical(f)
      expect(receipt).toMatchObject({
        id: saved.publications[0]!.id,
        publicationDigest: saved.publications[0]!.publicationDigest,
      })
      c.hooks.after = async (params) => {
        if (publicationInsert(params)) inserts++
      }
      expect(await owner(c.client).readPublicationReceipt(f.org, f.run.id)).toStrictEqual(receipt)
      await expect(owner(c.client).publishReadyLedger(f.lease)).rejects.toThrow(EXPIRED)
      expect(inserts).toBe(1)
      expect(await durable(f)).toStrictEqual(saved)
    } finally {
      await c.client.$disconnect()
    }
  })

  it.each(['digest', 'bytes', 'version', 'coherent-binding'] as const)(
    'historisk reader nekar modifierad faktisk retur: %s',
    async (mode) => {
      const f = await fixture(),
        receipt = await owner().publishReadyLedger(f.lease),
        before = await durable(f),
        c = await controlled()
      let observed = false,
        pureAccepted = false
      c.hooks.transform = (params, value) => {
        if (
          params.model !== 'FortnoxReadPublication' ||
          params.action !== 'findUnique' ||
          !record(value)
        )
          return value
        observed = true
        if (mode === 'digest') return { ...value, resultDigest: 'a'.repeat(64) }
        if (mode === 'bytes') {
          if (typeof value.canonicalBytes !== 'bigint') throw new Error('Faktiskt byteantal saknas')
          return { ...value, canonicalBytes: value.canonicalBytes + 1n }
        }
        if (mode === 'version') return { ...value, formatVersion: 2 }
        if (
          !record(value.summary) ||
          !record(value.rows) ||
          !record(value.binding) ||
          !record(value.binding.connection)
        )
          throw new Error('Faktiskt publiceringsunderlag saknas')
        // Full body and BOTH hashes are coherent. Only the historical binding
        // contradicts the stored run/source; the pure format must accept it.
        const summary = { ...value.summary, totalOre: 999 }
        const result = {
          status: value.status,
          reason: value.reason,
          summary,
          rows: value.rows.rows,
          references: value.rows.references,
          coverage: value.coverage,
          uncertainties: value.uncertainties,
          financialYear: value.financialYear,
        }
        const canonicalBytes = Buffer.byteLength(JSON.stringify(ordered(result)))
        const binding = {
          ...value.binding,
          connection: {
            ...value.binding.connection,
            generation: Number(value.binding.connection.generation) + 1,
          },
        }
        const envelope = {
          formatVersion: value.formatVersion,
          id: value.id,
          organizationId: value.organizationId,
          runId: value.runId,
          status: value.status,
          failureCode: value.failureCode,
          reason: value.reason,
          binding,
          proof: value.proof,
          resultDigest: digest(result),
          canonicalBytes,
        }
        const portable = {
          ...envelope,
          publicationDigest: digest(envelope),
          summary,
          rows: value.rows,
          coverage: value.coverage,
          uncertainties: value.uncertainties,
          financialYear: value.financialYear,
        }
        expect(decodeLedgerPublication(portable)).toMatchObject({ binding })
        pureAccepted = true
        return { ...value, ...portable, canonicalBytes: BigInt(canonicalBytes) }
      }
      try {
        await expect(owner(c.client).readPublicationReceipt(f.org, f.run.id)).rejects.toThrow(
          'Ogiltig lagrad huvudbokspublicering',
        )
        expect(observed).toBe(true)
        expect(pureAccepted).toBe(mode === 'coherent-binding')
        expect(await durable(f)).toStrictEqual(before)
        expect(await historical(f)).toStrictEqual(receipt)
      } finally {
        await c.client.$disconnect()
      }
    },
  )
})
