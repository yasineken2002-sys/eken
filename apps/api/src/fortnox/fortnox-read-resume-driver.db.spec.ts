/** Real synthetic PostgreSQL plus a synthetic, scope-bound reader. No provider calls.
 * Lost responses are injected only AFTER the real service method has committed.
 * Separate clients observe storage; no mocked persistence or disabled SQL guards.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { PrismaClient } from '@prisma/client'
import {
  FortnoxReadResumeDriver,
  type ResumeReadPort,
  type ResumeReadSession,
} from './fortnox-read-resume-driver'
import {
  FortnoxReadSourceRunService,
  type SourceResumeScope,
} from './fortnox-read-source-run.service'
import type { CheckpointCatalog, StartCheckpointInput } from './fortnox-read-checkpoint-context'
import { decodeLedgerResult } from './fortnox-read-result-format'
import type { FortnoxVoucher } from './fortnox.types'

const YEAR = { id: 1, fromDate: '2026-01-01', toDate: '2026-12-31' }
const INPUT: StartCheckpointInput = {
  financialYearId: 1,
  financialYearStart: YEAR.fromDate,
  financialYearEnd: YEAR.toDate,
  periodFrom: '2026-10-01',
  periodTo: '2026-10-31',
  costAccounts: [5170],
}
const EMPTY_COVERAGE = { pages: 1, totalPages: 0, totalResources: 0, itemsSeen: 0 }
const EXPIRED = 'Läsanspråket har upphört'
const CONNECTION_CHANGED = 'Fortnox-anslutningen har ändrats; starta en ny läsning.'
const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'

function isolatedUrl(pool = 3) {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Resume-driver kräver uttrycklig syntetisk DATABASE_URL')
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !(name === 'eveno_fortnox_capacity_test' || (process.env.CI === 'true' && name === 'eken_dev'))
  )
    throw new Error('Resume-driver tillåter bara egen lokal testdatabas eller CI')
  url.searchParams.set('connection_limit', String(pool))
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
    return 1000
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function voucher(year: number, number: number): FortnoxVoucher {
  return {
    Year: year,
    VoucherSeries: 'L',
    VoucherNumber: number,
    TransactionDate: '2026-10-01',
    ReferenceNumber: `R${number}`,
    VoucherRows: [
      { Account: 5170, Debit: number === 1 ? 0.15 : 0.29 },
      { Account: 2440, Credit: number === 1 ? 0.15 : 0.29 },
    ],
  }
}
function manifest(year: number) {
  return {
    MetaInformation: { '@CurrentPage': 1, '@TotalPages': 1, '@TotalResources': 2 },
    Vouchers: [1, 2].map((n) => ({ Year: year, VoucherSeries: 'L', VoucherNumber: n })),
  }
}

// Track whole test promises, not just a held HTTP-like read. Teardown waits for
// settlement before DELETE; a Jest/hook timeout is not cancellation or cleanup proof.
const running = new Set<Promise<void>>()
const unblock = new Set<() => void>()
function tracked(work: () => Promise<void>) {
  return () => {
    const job = Promise.resolve().then(work)
    running.add(job)
    void job.then(
      () => running.delete(job),
      () => running.delete(job),
    )
    return job
  }
}
async function reached(entered: Promise<void>, settled: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entered,
      settled.then(() => {
        throw new Error('Driver settled before the read barrier')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read barrier was not reached')), 5000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('Fortnox v2 resume-driver: real commits and new owners', () => {
  let prisma: TestPrisma
  const orgs = new Set<string>()
  const marker = (id: string) => `synthetic-resume-driver-${id}`
  const service = () => new FortnoxReadSourceRunService(prisma)
  beforeAll(async () => {
    prisma = new TestPrisma({ datasources: { db: { url: DATABASE_URL } } })
    await prisma.$connect()
  })
  afterAll(async () => {
    for (const release of unblock) release()
    await Promise.allSettled([...running])
    try {
      for (const id of orgs) {
        const row = await prisma.organization.findUnique({ where: { id }, select: { name: true } })
        if (!row) continue
        expect(row.name).toBe(marker(id))
        await prisma.organization.delete({ where: { id } })
      }
      const observer = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
      try {
        const where = { organizationId: { in: [...orgs] } }
        expect(await observer.organization.count({ where: { id: { in: [...orgs] } } })).toBe(0)
        expect(await observer.fortnoxConnection.count({ where })).toBe(0)
        expect(await observer.fortnoxReadRun.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceCapture.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceMapping.count({ where })).toBe(0)
        expect(await observer.fortnoxReadSourceExport.count({ where })).toBe(0)
        expect(await observer.fortnoxReadNormalizationStage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadNormalizationPage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadContextSnapshot.count({ where })).toBe(0)
        expect(await observer.fortnoxReadContextPage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadManifestPage.count({ where })).toBe(0)
        expect(await observer.fortnoxReadVoucherCheckpoint.count({ where })).toBe(0)
        expect(await observer.fortnoxReadPublication.count({ where })).toBe(0)
      } finally {
        await observer.$disconnect()
      }
    } finally {
      await prisma.$disconnect()
    }
  }, 30_000)

  async function fixture(prepare = true, year = 1, company = 900001) {
    const org = randomUUID()
    orgs.add(org) // Intended ownership exists even if the create response is lost.
    await prisma.organization.create({
      data: {
        id: org,
        name: marker(org),
        email: `${org}@example.invalid`,
        street: 'Testgata 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    const connection = await prisma.fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: company,
        fortnoxOrgNumber: `SYNTHETIC_${company}`,
      },
    })
    const owner = service()
    const run = await owner.start(org, null, { ...INPUT, financialYearId: year })
    if (prepare) {
      const lease = await owner.claim(org, run.id)
      if (!lease) throw new Error('Fixture claim missing')
      const progress = await owner.prepareNormalization(lease)
      expect(progress).toMatchObject({
        status: 'NORMALIZED',
        mappingCount: 0,
        exportCount: 0,
        next: null,
      })
      const catalog: CheckpointCatalog = {
        version: 1,
        companyDatabaseNumber: company,
        financialYear: { ...YEAR, id: year, accountingMethod: 'ACCRUAL' },
        accounts: [{ number: 5170, active: null, balanceBroughtForwardOre: null }],
        dimensions: [],
        coverage: { costCenters: EMPTY_COVERAGE },
      }
      await owner.commitCatalog(lease, catalog)
      await owner.release(lease)
    }
    if (!run.sourceCaptureId || !run.requestHash) throw new Error('Fixture source binding missing')
    const scope: SourceResumeScope = {
      organizationId: org,
      runId: run.id,
      sourceCaptureId: run.sourceCaptureId,
      requestHash: run.requestHash,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      fortnoxDatabaseNumber: company,
      fortnoxOrgNumber: `SYNTHETIC_${company}`,
      financialYear: { ...YEAR, id: year },
    }
    return { org, run, connection, scope, year }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function reader(f: Fixture) {
    const readManifestPage = jest.fn<Promise<unknown>, [number]>(async (page) => {
      expect(page).toBe(1)
      return manifest(f.year)
    })
    const readVoucher = jest.fn<Promise<FortnoxVoucher | undefined>, [string]>(async (key) => {
      expect([`${f.year}|L|1`, `${f.year}|L|2`]).toContain(key)
      return voucher(f.year, key.endsWith('|1') ? 1 : 2)
    })
    const open = jest.fn<Promise<ResumeReadSession>, [SourceResumeScope]>(async (expected) => {
      expect(expected).toStrictEqual(f.scope)
      return {
        // Independent fixture binding, not an echo of the driver's argument.
        binding: { ...f.scope, financialYear: { ...f.scope.financialYear } },
        readManifestPage,
        readVoucher,
      }
    })
    return { port: { open } satisfies ResumeReadPort, open, readManifestPage, readVoucher }
  }
  async function advanceFresh(f: Fixture, port: ResumeReadPort) {
    const client = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
    try {
      return await new FortnoxReadResumeDriver(
        new FortnoxReadSourceRunService(client),
        port,
      ).advance(f.org, f.run.id)
    } finally {
      await client.$disconnect()
    }
  }
  async function durable(f: Fixture) {
    const observer = new TestPrisma({ datasources: { db: { url: isolatedUrl(1) } } })
    try {
      const where = { organizationId: f.org, runId: f.run.id }
      return {
        run: await observer.fortnoxReadRun.findUniqueOrThrow({
          where: { id: f.run.id, organizationId: f.org },
        }),
        source: await observer.fortnoxReadSourceCapture.findUniqueOrThrow({
          where: { id: f.run.id, organizationId: f.org },
        }),
        pages: await observer.fortnoxReadManifestPage.findMany({ where, orderBy: { page: 'asc' } }),
        details: await observer.fortnoxReadVoucherCheckpoint.findMany({
          where,
          orderBy: { key: 'asc' },
        }),
        publications: await observer.fortnoxReadPublication.findMany({ where }),
      }
    } finally {
      await observer.$disconnect()
    }
  }
  async function databaseExpired(f: Fixture) {
    const end = Date.now() + 4000
    while (Date.now() < end) {
      const [clock] = await prisma.$queryRaw<Array<{ expired: boolean | null }>>`
        SELECT timezone('UTC', clock_timestamp()) > "leaseUntil" AS expired
        FROM "FortnoxReadRun" WHERE "id" = ${f.run.id} AND "organizationId" = ${f.org}`
      if (!clock || clock.expired === null) throw new Error('Committed lease deadline missing')
      if (clock.expired) return
      await pause(10)
    }
    throw new Error('Real PostgreSQL lease expiry was not observed')
  }

  it(
    'new clients/owners advance one unit each and publish the small literal result once',
    tracked(async () => {
      const f = await fixture()
      const r = reader(f)
      const initial = await durable(f)
      const expectedKinds = ['MANIFEST_SAVED', 'DETAIL_SAVED', 'DETAIL_SAVED', 'PUBLICATION']
      for (const [index, kind] of expectedKinds.entries()) {
        const result = await advanceFresh(f, r.port)
        expect(result.kind).toBe(kind)
        const saved = await durable(f)
        expect(saved.run.claimVersion).toBe(index + 2)
        expect(saved.run.claimToken).toBeNull()
        expect(saved.run.leaseUntil).toBeNull()
      }
      expect(r.open).toHaveBeenCalledTimes(3)
      expect(r.readManifestPage.mock.calls).toEqual([[1]])
      expect(r.readVoucher.mock.calls).toEqual([['1|L|1'], ['1|L|2']])
      const saved = await durable(f)
      expect(saved.source).toStrictEqual(initial.source)
      expect(saved.pages).toHaveLength(1)
      expect(saved.details).toHaveLength(2)
      expect(
        saved.details.every((row) => row.detailDigest !== null && row.validated !== null),
      ).toBe(true)
      expect(saved.publications).toHaveLength(1)
      expect(saved.run).toMatchObject({
        status: 'COMPLETE',
        phase: 'READY_TO_REDUCE',
        summary: null,
        rows: null,
      })
      const row = saved.publications[0]!
      const decoded = decodeLedgerResult({
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
      expect(decoded).toStrictEqual({
        status: 'COMPLETE',
        reason: null,
        financialYear: YEAR,
        summary: {
          currency: 'SEK',
          totalOre: 44,
          byProperty: [],
          unmappedDimensions: [],
          unallocatedOre: 44,
          uncertainRemovedOre: 0,
          evenoExportOre: 0,
          balanceBroughtForwardOre: { '5170': null },
          financialYearAccountingMethod: 'ACCRUAL',
        },
        rows: [
          {
            voucher: '1|L|1',
            row: 1,
            transactionDate: '2026-10-01',
            account: 5170,
            amountOre: 15,
            bucket: 'UNALLOCATED',
            dimensionType: null,
            code: null,
            propertyId: null,
            evenoExport: false,
          },
          {
            voucher: '1|L|2',
            row: 1,
            transactionDate: '2026-10-01',
            account: 5170,
            amountOre: 29,
            bucket: 'UNALLOCATED',
            dimensionType: null,
            code: null,
            propertyId: null,
            evenoExport: false,
          },
        ],
        references: [
          { voucher: '1|L|1', referenceType: null, referenceNumber: 'R1' },
          { voucher: '1|L|2', referenceType: null, referenceNumber: 'R2' },
        ],
        coverage: {
          '/3/costcenters': EMPTY_COVERAGE,
          '/3/vouchers/sublist': { pages: 1, totalPages: 1, totalResources: 2, itemsSeen: 2 },
        },
        uncertainties: [LIMITATION],
      })
      const replay = await advanceFresh(f, r.port)
      expect(replay).toMatchObject({
        kind: 'PUBLICATION',
        receipt: { id: row.id, publicationDigest: row.publicationDigest, claimVersion: 5 },
      })
      expect(r.open).toHaveBeenCalledTimes(3)
      expect(await durable(f)).toStrictEqual(saved)
    }),
    30_000,
  )

  it.each(['manifest', 'detail'] as const)(
    'resumes after an actual %s commit whose response was lost',
    (point) =>
      tracked(async () => {
        const f = await fixture()
        const r = reader(f)
        if (point === 'detail') expect((await advanceFresh(f, r.port)).kind).toBe('MANIFEST_SAVED')
        const owner = new ShortLeaseService(prisma)
        const lost = new Error('SYNTHETIC_LOST_COMMITTED_RESPONSE')
        let actualCommitReturned = false
        const spy =
          point === 'manifest'
            ? jest.spyOn(owner, 'commitVoucherPage').mockImplementationOnce(async (...args) => {
                const receipt = await FortnoxReadSourceRunService.prototype.commitVoucherPage.apply(
                  owner,
                  args,
                )
                expect(receipt.page).toBe(1)
                actualCommitReturned = true
                throw lost
              })
            : jest.spyOn(owner, 'commitVoucherDetail').mockImplementationOnce(async (...args) => {
                const receipt =
                  await FortnoxReadSourceRunService.prototype.commitVoucherDetail.apply(owner, args)
                expect(receipt.key).toBe('1|L|1')
                actualCommitReturned = true
                throw lost
              })
        try {
          await expect(
            new FortnoxReadResumeDriver(owner, r.port).advance(f.org, f.run.id),
          ).rejects.toBe(lost)
          expect(actualCommitReturned).toBe(true)
          const committed = await durable(f)
          expect(committed.pages).toHaveLength(1)
          expect(committed.run).toMatchObject({
            phase: 'DETAILS',
            status: 'RUNNING',
            nextManifestPage: 2,
          })
          expect(committed.details.filter((d) => d.detailDigest !== null)).toHaveLength(
            point === 'manifest' ? 0 : 1,
          )
          expect(committed.run.claimToken).not.toBeNull()
          await databaseExpired(f)
          const next = await advanceFresh(f, r.port)
          expect(next).toMatchObject({
            kind: 'DETAIL_SAVED',
            receipt: { key: point === 'manifest' ? '1|L|1' : '1|L|2' },
          })
          const resumed = await durable(f)
          expect(resumed.run.claimVersion).toBe(committed.run.claimVersion + 1)
          expect(resumed.pages).toStrictEqual(committed.pages)
          expect(resumed.details).toHaveLength(2)
          expect(r.readManifestPage.mock.calls).toEqual([[1]])
          expect(r.readVoucher.mock.calls).toEqual(
            point === 'manifest' ? [['1|L|1']] : [['1|L|1'], ['1|L|2']],
          )
        } finally {
          spy.mockRestore()
        }
      })(),
    30_000,
  )

  it(
    'lost final publication is recovered without claim, provider, reduction or a second write',
    tracked(async () => {
      const f = await fixture()
      const r = reader(f)
      for (let step = 0; step < 3; step++) await advanceFresh(f, r.port)
      const owner = service()
      const lost = new Error('SYNTHETIC_LOST_PUBLICATION_RESPONSE')
      let actualReceipt:
        | Awaited<ReturnType<FortnoxReadSourceRunService['publishReadyLedger']>>
        | undefined
      const publish = jest
        .spyOn(owner, 'publishReadyLedger')
        .mockImplementationOnce(async (lease) => {
          actualReceipt = await FortnoxReadSourceRunService.prototype.publishReadyLedger.call(
            owner,
            lease,
          )
          throw lost
        })
      try {
        await expect(
          new FortnoxReadResumeDriver(owner, r.port).advance(f.org, f.run.id),
        ).rejects.toBe(lost)
        expect(actualReceipt).toBeDefined()
        const committed = await durable(f)
        expect(committed.publications).toHaveLength(1)
        expect(committed.run).toMatchObject({
          status: 'COMPLETE',
          claimToken: null,
          leaseUntil: null,
        })
        await prisma.fortnoxConnection.update({
          where: { id: f.connection.id },
          data: { status: 'DISCONNECTED', generation: { increment: 1 } },
        })
        const nextOwner = service()
        const claim = jest.spyOn(nextOwner, 'claim')
        const republish = jest.spyOn(nextOwner, 'publishReadyLedger')
        const result = await new FortnoxReadResumeDriver(nextOwner, r.port).advance(f.org, f.run.id)
        expect(result).toStrictEqual({ kind: 'PUBLICATION', receipt: actualReceipt })
        expect(claim).not.toHaveBeenCalled()
        expect(republish).not.toHaveBeenCalled()
        expect(r.open).toHaveBeenCalledTimes(3)
        expect(await durable(f)).toStrictEqual(committed)
        claim.mockRestore()
        republish.mockRestore()
      } finally {
        publish.mockRestore()
      }
    }),
    30_000,
  )

  it(
    'foreign org/run cannot reach the reader; the other org uses its own company and year',
    tracked(async () => {
      const a = await fixture()
      const b = await fixture(true, 2, 900002)
      const r = reader(b)
      const beforeA = await durable(a)
      const beforeB = await durable(b)
      await expect(
        new FortnoxReadResumeDriver(service(), r.port).advance(a.org, b.run.id),
      ).rejects.toThrow()
      expect(r.open).not.toHaveBeenCalled()
      expect(await durable(a)).toStrictEqual(beforeA)
      expect(await durable(b)).toStrictEqual(beforeB)
      expect((await advanceFresh(b, r.port)).kind).toBe('MANIFEST_SAVED')
      expect(r.open.mock.calls).toEqual([[b.scope]])
      expect(r.readManifestPage.mock.calls).toEqual([[1]])
      const actual = await durable(b)
      expect(actual.details.map((row) => row.key)).toEqual(['2|L|1', '2|L|2'])
      expect(await durable(a)).toStrictEqual(beforeA)
    }),
    30_000,
  )

  it.each(['takeover', 'connection'] as const)(
    'a held GET cannot commit after real %s',
    (mode) =>
      tracked(async () => {
        const f = await fixture()
        const r = reader(f)
        const entered = deferred()
        const release = deferred()
        unblock.add(release.resolve)
        r.readManifestPage.mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
          return manifest(f.year)
        })
        const owner = mode === 'takeover' ? new ShortLeaseService(prisma) : service()
        const work = new FortnoxReadResumeDriver(owner, r.port).advance(f.org, f.run.id)
        const settled = Promise.allSettled([work]) // Attach rejection handling immediately.
        try {
          await reached(entered.promise, settled)
          const pending = await durable(f)
          expect(pending.pages).toEqual([])
          expect(pending.run.claimToken).not.toBeNull()
          if (mode === 'takeover') {
            await databaseExpired(f)
            const replacementReader = reader(f)
            expect((await advanceFresh(f, replacementReader.port)).kind).toBe('MANIFEST_SAVED')
            const won = await durable(f)
            expect(won.run.claimVersion).toBe(pending.run.claimVersion + 1)
            expect(won.pages).toHaveLength(1)
            release.resolve()
            await expect(work).rejects.toThrow(EXPIRED)
            expect(await durable(f)).toStrictEqual(won)
            expect(replacementReader.readManifestPage).toHaveBeenCalledTimes(1)
          } else {
            await prisma.fortnoxConnection.update({
              where: { id: f.connection.id },
              data: { generation: { increment: 1 } },
            })
            release.resolve()
            await expect(work).rejects.toThrow(CONNECTION_CHANGED)
            const stopped = await durable(f)
            expect(stopped.run).toMatchObject({
              status: 'FAILED',
              reason: CONNECTION_CHANGED,
              claimToken: null,
              leaseUntil: null,
            })
            expect(stopped.pages).toEqual([])
            expect(stopped.details).toEqual([])
            expect(stopped.publications).toEqual([])
            expect(stopped.source).toStrictEqual(pending.source)
          }
          expect(r.readManifestPage).toHaveBeenCalledTimes(1)
          expect(r.readVoucher).not.toHaveBeenCalled()
        } finally {
          release.resolve()
          await settled
          unblock.delete(release.resolve)
        }
      })(),
    30_000,
  )

  it(
    'preparation, held ownership and a terminal without publication never start reader work',
    tracked(async () => {
      const fresh = await fixture(false)
      const r = reader(fresh)
      const owner = service()
      const start = jest.spyOn(owner, 'start')
      const driver = new FortnoxReadResumeDriver(owner, r.port)
      expect(await driver.advance(fresh.org, fresh.run.id)).toStrictEqual({
        kind: 'PREPARATION_REQUIRED',
      })
      const prepared = await durable(fresh)
      expect(prepared.run).toMatchObject({
        phase: 'SOURCE_CAPTURED',
        status: 'RUNNING',
        claimToken: null,
        leaseUntil: null,
      })
      const lease = await owner.claim(fresh.org, fresh.run.id)
      if (!lease) throw new Error('Held lease missing')
      const held = await durable(fresh)
      expect(await driver.advance(fresh.org, fresh.run.id)).toStrictEqual({ kind: 'NOT_ACQUIRED' })
      expect(await durable(fresh)).toStrictEqual(held)
      await owner.release(lease)
      const terminal = await fixture()
      const terminalLease = await owner.claim(terminal.org, terminal.run.id)
      if (!terminalLease) throw new Error('Terminal setup claim missing')
      await expect(owner.commitVoucherPage(terminalLease, null)).rejects.toThrow(
        'Verifikationslistan är ofullständig eller ändrades under läsningen.',
      )
      const failed = await durable(terminal)
      expect(failed.run.status).toBe('FAILED')
      expect(failed.publications).toEqual([])
      expect(await driver.advance(terminal.org, terminal.run.id)).toStrictEqual({
        kind: 'NOT_ACQUIRED',
      })
      expect(await durable(terminal)).toStrictEqual(failed)
      expect(r.open).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(
        await prisma.fortnoxReadRun.count({
          where: { organizationId: { in: [fresh.org, terminal.org] } },
        }),
      ).toBe(2)
      start.mockRestore()
    }),
    30_000,
  )
})
