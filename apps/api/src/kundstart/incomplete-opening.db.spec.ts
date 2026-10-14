/** R198: actual services/DB, no providers, bootstrap, resets or deleted evidence. */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async () => {
    throw new Error('S3 forbidden')
  },
}))
import { PrismaClient, Prisma, type OpeningPackageStatus } from '@prisma/client'
import { Logger } from '@nestjs/common'
import type { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { AviseringService } from '../avisering/avisering.service'
import { AviseringScheduler } from '../avisering/avisering.scheduler'
import { RentBackfillService } from '../avisering/rent-backfill.service'
import { DepositsService } from '../deposits/deposits.service'
import { OcrService } from '../common/ocr/ocr.service'
import { CutoverService } from './cutover.service'
import { OpeningPackageService } from './opening-package.service'
import { INCOMPLETE_OPENING_REASON } from './incomplete-opening'

const db = new PrismaClient()
const prisma = db as unknown as PrismaService
const H =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum'
const REG = 'radId;hyresgast;avtal;periodAr;periodManad;dokument;fakturerat;betalt'
const record = (name: string, data: object) => {
  if (process.env.KUNDSTART198_OUTPUT)
    appendFileSync(
      join(process.env.KUNDSTART198_OUTPUT, 'observations.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), name, ...data }) + '\n',
    )
}
let forbiddenCalls: string[] = []
const forbidden = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, key) => () => {
        forbiddenCalls.push(`${name}.${String(key)}`)
        throw new Error(`Förbjudet beroende ${name}.${String(key)}`)
      },
    },
  ) as never
const attempt = async <T>(fn: () => Promise<T>) => {
  try {
    return { returned: await fn(), error: null }
  } catch (e) {
    const err = e as Error & { getStatus?: () => number; getResponse?: () => unknown }
    return {
      returned: null,
      error: {
        name: err.name,
        message: err.message,
        status: err.getStatus?.(),
        response: err.getResponse?.(),
      },
    }
  }
}
jest.setTimeout(60_000)
beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error('R198 kräver verklig DATABASE_URL; inga DB-prov hoppas över')
  await db.$connect()
  const identity = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`
  const counts = {
    organizations: await db.organization.count(),
    notices: await db.rentNotice.count(),
    journals: await db.journalEntry.count(),
  }
  if (process.env.KUNDSTART198_REQUIRE_EMPTY === 'YES')
    expect(Object.values(counts)).toEqual([0, 0, 0])
  record('MANDATORY_DB_PREREQUISITE', {
    identity,
    counts,
    emptyRequired: process.env.KUNDSTART198_REQUIRE_EMPTY === 'YES',
  })
})
beforeEach(() => {
  forbiddenCalls = []
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    forbiddenCalls.push('fetch')
    throw new Error('fetch forbidden')
  })
})
afterEach(() => {
  record('EXTERNAL_BOUNDARIES', { test: expect.getState().currentTestName, forbiddenCalls })
  expect(forbiddenCalls).toEqual([])
  jest.restoreAllMocks()
})
afterAll(async () => {
  await db.$disconnect()
})

function makeAvisering(p: PrismaService) {
  const accounting = new AccountingService(p, new VerifikationsnummerService(p))
  const events = new InvoiceEventsService(p),
    noticeEvents = new RentNoticeEventsService(p)
  const notify = { createForAllOrgUsers: async () => undefined }
  return new AviseringService(
    p,
    new OcrService(p),
    forbidden('Mail'),
    forbidden('Pdf'),
    forbidden('Storage'),
    forbidden('PdfQueue'),
    accounting,
    { attachRentNoticeLineCharges: async () => 0 } as never,
    { attachMiscChargesToRentNotice: async () => 0 } as never,
    new DepositsService(p, accounting, notify as never, events),
    noticeEvents,
  )
}
let serial = 0
async function fixture(label: string, localMonth = false, deposit = 0) {
  const now = new Date(),
    year = localMonth ? now.getUTCFullYear() : 2026,
    month = localMonth ? now.getUTCMonth() + 1 : 11
  const cutDate = new Date(Date.UTC(year, month - 1, 1)),
    startDate = localMonth ? cutDate : new Date('2026-01-01')
  const id = `repro198-${label}-${randomUUID()}`,
    orgNumber = `98${String(Date.now()).slice(-6)}${String(++serial).padStart(2, '0')}`
  await db.organization.create({
    data: {
      id,
      name: `SYNTETISK198 ${label}`,
      orgNumber,
      status: 'TRIAL',
      email: `${id}@example.invalid`,
      street: 'Syntetgatan1',
      city: 'Teststad',
      postalCode: '12345',
    },
  })
  const owner = await db.user.create({
    data: {
      organizationId: id,
      email: `${id}-owner@example.invalid`,
      passwordHash: 'synthetic-not-login',
      firstName: 'Syntetisk',
      lastName: 'Ägare',
      role: 'OWNER',
    },
  })
  const user = { sub: owner.id, role: 'OWNER' as const }
  const property = await db.property.create({
    data: {
      organizationId: id,
      name: 'Syntetfastigheten',
      propertyDesignation: `${id}:1`,
      type: 'RESIDENTIAL',
      street: 'Syntetgatan1',
      city: 'Teststad',
      postalCode: '12345',
      totalArea: 100,
    },
  })
  for (const [number, name, type] of [
    [1510, 'Fordran', 'ASSET'],
    [1930, 'Bank', 'ASSET'],
    [2890, 'Deposition', 'LIABILITY'],
    [3911, 'Hyra', 'REVENUE'],
  ] as const)
    await db.account.create({ data: { organizationId: id, number, name, type } })
  const tenant = await db.tenant.create({
    data: {
      organizationId: id,
      type: 'INDIVIDUAL',
      firstName: 'Syntetisk',
      lastName: 'A',
      email: `${id}-A@example.invalid`,
      ocrNumber: '7771000011',
    },
  })
  const unit = await db.unit.create({
    data: {
      propertyId: property.id,
      name: 'Lgh1',
      unitNumber: '1001',
      type: 'APARTMENT',
      area: 50,
      monthlyRent: 6000,
    },
  })
  const lease = await db.lease.create({
    data: {
      organizationId: id,
      tenantId: tenant.id,
      unitId: unit.id,
      contractNumber: 'K-1',
      status: 'ACTIVE',
      startDate,
      tenancyStartDate: startDate,
      monthlyRent: 6000,
      depositAmount: deposit,
    },
  })
  const cutover = new CutoverService(prisma)
  await cutover.set(id, user, cutDate.toISOString().slice(0, 10))
  const avisering = makeAvisering(prisma)
  const sends = jest
    .spyOn(avisering, 'sendNotices')
    .mockResolvedValue({ queued: 0, failed: 0, jobIds: [], blocked: 0, blockedReason: null })
  const scoped = {
    organization: {
      findMany: (q: Prisma.OrganizationFindManyArgs) =>
        db.organization.findMany({ ...q, where: { ...q.where, id } }),
    },
  }
  const scheduler = new AviseringScheduler(scoped as never, avisering, forbidden('CronErrorSink'))
  const backfill = new RentBackfillService(prisma, avisering, new OcrService(prisma), {
    createForAllOrgUsers: async () => undefined,
  } as never)
  return {
    id,
    orgNumber,
    user,
    lease,
    tenant,
    avisering,
    sends,
    scheduler,
    backfill,
    cutover,
    packages: new OpeningPackageService(prisma, new OcrService(prisma)),
    year,
    month,
    cutDate,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function openingCsv(f: Fixture, document = 'DOC-1') {
  const end = new Date(Date.UTC(f.cutDate.getUTCFullYear(), f.cutDate.getUTCMonth(), 0))
  return `${H}\n${document};FORDRAN;7771000011;K-1;;;${end.getUTCFullYear()};${end.getUTCMonth() + 1};${end.toISOString().slice(0, 10)};6000;6000;\n`
}
async function opening(f: Fixture, state: OpeningPackageStatus, document = 'DOC-1') {
  let p = await f.packages.create(f.id, f.user, {
    sourceName: 'SYNTETISK198.csv',
    innehall: openingCsv(f, document),
  })
  if (state === 'DRAFT') return p
  if (state === 'DISCARDED') {
    await f.packages.discard(f.id, p.id, f.user)
    return p
  }
  const conn = await db.fortnoxConnection.create({
    data: {
      organizationId: f.id,
      status: 'ACTIVE',
      fortnoxDatabaseNumber: 990198,
      fortnoxOrgNumber: f.orgNumber,
      connectedAt: new Date(Date.now() - 3_600_000),
      exportVoucherSeries: 'A',
    },
  })
  expect((await f.packages.validate(f.id, p.id, f.user)).status).toBe('VALIDATED')
  if (state === 'VALIDATED') return p
  const read = await db.fortnoxReadRun.create({
    data: {
      organizationId: f.id,
      connectionId: conn.id,
      fortnoxDatabaseNumber: 990198,
      status: 'COMPLETE',
      financialYearId: 1,
      financialYearStart: new Date('2026-01-01'),
      financialYearEnd: new Date('2026-12-31'),
      periodFrom: new Date('2026-01-01'),
      periodTo: new Date('2026-10-31'),
      costAccounts: [1510, 2890],
      startedAt: new Date(),
      completedAt: new Date(),
      summary: { balanceBroughtForwardOre: { '1510': 0, '2890': 0 } },
      rows: {
        rows: [
          { account: 1510, amountOre: 600000, bucket: 'UNALLOCATED' },
          { account: 2890, amountOre: 0, bucket: 'UNALLOCATED' },
        ],
        references: [],
      },
    },
  })
  await f.packages.bindFortnoxRead(f.id, p.id, f.user, read.id)
  await f.packages.setFirstPeriodRegister(f.id, p.id, f.user, {
    filnamn: 'SYNTETISK198-register.csv',
    innehall: REG,
    system: 'Syntetiskt tidigare system',
    ansvarig: 'Syntetisk granskare',
    tackningFran: '2026-11-01',
    tackningTill: '2026-12-31',
    intaktskonton: [3911],
    forskottskonton: [2420],
  })
  await f.packages.approve(f.id, p.id, f.user, { version: p.version, sourceSha256: p.sourceSha256 })
  if (state === 'EXECUTED')
    expect((await f.packages.execute(f.id, p.id, f.user)).status).toBe('EXECUTED')
  p = await db.openingPackage.findUniqueOrThrow({ where: { id: p.id }, include: { rows: true } })
  return p
}
async function snapshot(f: Fixture) {
  const [
    notices,
    journals,
    payments,
    deposits,
    bankRows,
    exports,
    activations,
    sequences,
    packages,
    cutover,
  ] = await Promise.all([
    db.rentNotice.findMany({ where: { organizationId: f.id }, orderBy: { noticeNumber: 'asc' } }),
    db.journalEntry.findMany({
      where: { organizationId: f.id },
      include: { lines: { include: { account: true } } },
    }),
    db.rentNoticePayment.count({ where: { rentNotice: { organizationId: f.id } } }),
    db.deposit.findMany({ where: { organizationId: f.id } }),
    db.bankTransaction.findMany({ where: { organizationId: f.id } }),
    db.fortnoxVoucherExport.count({ where: { organizationId: f.id } }),
    db.fortnoxCustomerActivation.count({ where: { organizationId: f.id } }),
    db.rentNoticeNumberSequence.findMany({ where: { organizationId: f.id } }),
    db.openingPackage.findMany({
      where: { organizationId: f.id },
      select: { id: true, status: true, cutoverDate: true, version: true, sourceSha256: true },
    }),
    f.cutover.get(f.id),
  ])
  return {
    notices,
    journals,
    payments,
    deposits,
    bankRows,
    exports,
    activations,
    sequences,
    packages,
    cutover,
  }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
function financialFacit(before: Snapshot, after: Snapshot, count: number, bankCount = 0) {
  expect(after.notices.length - before.notices.length).toBe(count)
  expect(after.journals.length - before.journals.length).toBe(count)
  expect(after.payments).toBe(0)
  expect(after.exports).toBe(0)
  expect(after.activations).toBe(0)
  expect(after.deposits).toEqual(before.deposits)
  expect(after.bankRows.length - before.bankRows.length).toBe(bankCount)
  if (count === 0) {
    expect(after.sequences).toEqual(before.sequences)
    expect(after.cutover).toEqual(before.cutover)
  }
  for (const journal of after.journals.filter((j) => !before.journals.some((b) => b.id === j.id))) {
    expect(Number(journal.lines.find((l) => l.account.number === 1510)?.debit)).toBe(6000)
    expect(Number(journal.lines.find((l) => l.account.number === 3911)?.credit)).toBe(6000)
  }
}

const cases = [
  { id: 'M01', name: 'monthly manual DRAFT', path: 'monthly', profile: 'DRAFT', count: 0 },
  { id: 'M02', name: 'cron DRAFT no send', path: 'cron', profile: 'DRAFT', count: 0 },
  {
    id: 'M03',
    name: 'initial DRAFT rent and positive deposit no effect',
    path: 'initial',
    profile: 'DRAFT',
    count: 0,
  },
  {
    id: 'M04',
    name: 'backfill DRAFT correct409 not skippedClosed',
    path: 'backfill',
    profile: 'DRAFT',
    count: 0,
  },
  { id: 'M05', name: 'monthly VALIDATED', path: 'monthly', profile: 'VALIDATED', count: 0 },
  { id: 'M06', name: 'monthly APPROVED', path: 'monthly', profile: 'APPROVED', count: 0 },
  {
    id: 'M07',
    name: 'monthly EXECUTED only existing behavior',
    path: 'monthly',
    profile: 'EXECUTED',
    count: 1,
  },
  { id: 'M08', name: 'monthly DISCARDED only', path: 'monthly', profile: 'DISCARDED', count: 1 },
  {
    id: 'M09',
    name: 'monthly EXECUTED plus DRAFT blocks',
    path: 'monthly',
    profile: 'BOTH',
    count: 0,
  },
  {
    id: 'M10',
    name: 'pending package in other organization',
    path: 'monthly',
    profile: 'OTHER_ORG',
    count: 1,
  },
  {
    id: 'M11',
    name: 'pending package at other cutover date',
    path: 'monthly',
    profile: 'OTHER_DATE',
    count: 1,
  },
  {
    id: 'M12',
    name: 'no package preserves existing behavior',
    path: 'monthly',
    profile: 'NONE',
    count: 1,
  },
  {
    id: 'M13',
    name: 'NULL cutover with prior package preserves existing behavior',
    path: 'monthly',
    profile: 'NULL',
    count: 1,
  },
  {
    id: 'M14',
    name: 'initial no unfinished package positive and replay',
    path: 'initial',
    profile: 'NONE',
    count: 1,
  },
  {
    id: 'M15',
    name: 'backfill no unfinished package positive and replay',
    path: 'backfill',
    profile: 'NONE',
    count: 1,
  },
  {
    id: 'M16',
    name: 'cron no unfinished package positive and replay',
    path: 'cron',
    profile: 'NONE',
    count: 1,
  },
  {
    id: 'M17',
    name: 'initial before cutover unchanged',
    path: 'initial',
    profile: 'BEFORE',
    count: 0,
  },
  {
    id: 'M18',
    name: 'backfill before cutover unchanged',
    path: 'backfill',
    profile: 'BEFORE',
    count: 0,
  },
  {
    id: 'M19',
    name: 'monthly before cutover unchanged',
    path: 'monthly',
    profile: 'BEFORE',
    count: 0,
  },
]
it.each(cases)('R198 $id $name', async (c) => {
  const local = c.path === 'initial' || c.path === 'backfill'
  const f = await fixture(c.id, local, c.id === 'M03' ? 6000 : 0)
  if (['DRAFT', 'VALIDATED', 'APPROVED', 'EXECUTED', 'DISCARDED'].includes(c.profile))
    await opening(f, c.profile as OpeningPackageStatus)
  if (c.profile === 'BOTH') {
    await opening(f, 'EXECUTED')
    await opening(f, 'DRAFT', 'DOC-2')
  }
  if (c.profile === 'OTHER_ORG') await opening(await fixture('OTHER'), 'DRAFT')
  if (c.profile === 'OTHER_DATE') {
    await f.cutover.set(f.id, f.user, '2026-10-01')
    await opening(f, 'DRAFT')
    await f.cutover.set(f.id, f.user, '2026-11-01')
  }
  if (c.profile === 'NULL') {
    await opening(f, 'DRAFT')
    await f.cutover.set(f.id, f.user, null)
  }
  if (c.profile === 'BEFORE') {
    const next = new Date(Date.UTC(f.year, f.month, 1))
    await f.cutover.set(f.id, f.user, next.toISOString().slice(0, 10))
    await opening(f, 'DRAFT')
  }
  const invoke = async () =>
    c.path === 'initial'
      ? f.avisering.createInitialNoticesForLease(f.lease.id)
      : c.path === 'backfill'
        ? f.backfill.createBackfillNotices(f.lease.id, f.id, {
            actorUserId: f.user.sub,
            actorRole: 'OWNER',
          })
        : c.path === 'cron'
          ? f.scheduler.runForMonth(f.year, f.month)
          : f.avisering.generateMonthlyNotices(f.id, f.month, f.year)
  const errorLog = jest.spyOn(Logger.prototype, 'error')
  const before = await snapshot(f),
    result = await attempt(invoke),
    after = await snapshot(f)
  record(`R198 ${c.id}`, {
    scenario: c,
    organizationId: f.id,
    period: { year: f.year, month: f.month },
    before,
    result,
    after,
    sendAttempts: f.sends.mock.calls.length,
  })
  financialFacit(before, after, c.count)
  expect(after.packages).toEqual(before.packages)
  if (c.count === 0) expect(f.sends).not.toHaveBeenCalled()
  if (['M03', 'M04'].includes(c.id)) {
    expect(result.error?.status).toBe(409)
    expect(result.error?.response).toEqual({
      code: 'OPENING_PACKAGE_INCOMPLETE',
      message: INCOMPLETE_OPENING_REASON,
    })
  } else {
    expect(result.error).toBeNull()
    if (['M01', 'M02', 'M05', 'M06', 'M09'].includes(c.id)) {
      expect(result.returned).toMatchObject({
        created: 0,
        failed: 0,
        blockedByOpening: 1,
        blockedReason: INCOMPLETE_OPENING_REASON,
      })
    }
  }
  if (['M14', 'M15', 'M16'].includes(c.id)) {
    const replay = await attempt(invoke),
      replayAfter = await snapshot(f)
    record(`R198 ${c.id} replay`, { replay, after: replayAfter })
    expect(replay.error).toBeNull()
    expect(replayAfter.notices).toEqual(after.notices)
    expect(replayAfter.journals).toEqual(after.journals)
    expect(errorLog).not.toHaveBeenCalled()
  }
})

function signal<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function waitForBlock(waiter: number, blocker: number) {
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const [row] = await db.$queryRaw<
      { blockers: number[] }[]
    >`SELECT pg_blocking_pids(${waiter}::int) AS blockers`
    if (row?.blockers.includes(blocker))
      return { waiter, blocker, blockers: row.blockers, waitObservedMs: Date.now() - start }
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`No observed blocking lock for own backend ${waiter}`)
}
function observedService(
  pid: ReturnType<typeof signal<number>>,
  held?: ReturnType<typeof signal<void>>,
  release?: ReturnType<typeof signal<void>>,
) {
  const trace: { backendPid: number; queries: string[] }[] = []
  const p = new Proxy(db, {
    get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key)
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
        target.$transaction(
          async (tx) => {
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
            const queries: string[] = []
            trace.push({ backendPid: backend!.pid, queries })
            const proxy = new Proxy(tx, {
              get(t, k) {
                if (k !== '$queryRaw') return Reflect.get(t, k)
                return async (...args: unknown[]) => {
                  const sql = String(args[0])
                  queries.push(sql)
                  const noticeLock = sql.includes('"Organization"') && sql.includes('FOR UPDATE')
                  // OCR has its own earlier transaction; signal the notice backend only.
                  if (noticeLock) pid.resolve(backend!.pid)
                  const value = await Reflect.apply(t.$queryRaw, t, args)
                  if (noticeLock && held && release) {
                    held.resolve()
                    await release.promise
                  }
                  return value
                }
              },
            })
            return fn(proxy)
          },
          { ...options, timeout: 15_000 },
        )
    },
  }) as unknown as PrismaService
  return {
    service: makeAvisering(p),
    trace,
    assertNoticeLockFirst: () => {
      const noticeTransactions = trace.filter((t) =>
        t.queries.some((q) => q.includes('"Organization"')),
      )
      expect(noticeTransactions).toHaveLength(1)
      expect(noticeTransactions[0]!.queries[0]).toContain('"Organization"')
      expect(noticeTransactions[0]!.queries[0]).toContain('FOR UPDATE')
    },
  }
}

it('R198 M20 concurrent DRAFT commit precedes generator lock', async () => {
  const f = await fixture('M20'),
    before = await snapshot(f)
  const writerReady = signal<number>(),
    release = signal<void>(),
    generatorPid = signal<number>()
  const writer = db.$transaction(
    async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${f.id} FOR UPDATE`
      await new OpeningPackageService(
        tx as unknown as PrismaService,
        new OcrService(prisma),
      ).create(f.id, f.user, { sourceName: 'SYNTHETIC-M20.csv', innehall: openingCsv(f) })
      writerReady.resolve(backend!.pid)
      await release.promise
    },
    { timeout: 15_000 },
  )
  const writerPid = await writerReady.promise,
    observed = observedService(generatorPid)
  const generation = attempt(() => observed.service.generateMonthlyNotices(f.id, f.month, f.year))
  let lock
  try {
    lock = await waitForBlock(await generatorPid.promise, writerPid)
  } finally {
    release.resolve()
  }
  await writer
  const result = await generation,
    after = await snapshot(f)
  observed.assertNoticeLockFirst()
  record('R198 M20', { before, result, after, lock, transactionQueries: observed.trace })
  financialFacit(before, after, 0)
  expect(result.error).toBeNull()
  expect(result.returned).toMatchObject({
    blockedByOpening: 1,
    blockedReason: INCOMPLETE_OPENING_REASON,
  })
})

it('R198 M21 concurrent generator precedes new DRAFT then next notice blocked', async () => {
  const f = await fixture('M21'),
    before = await snapshot(f),
    generatorPid = signal<number>(),
    held = signal<void>(),
    release = signal<void>()
  const observed = observedService(generatorPid, held, release)
  const generation = attempt(() => observed.service.generateMonthlyNotices(f.id, f.month, f.year))
  await held.promise
  const pid = await generatorPid.promise,
    writerPid = signal<number>()
  const writer = db.$transaction(
    async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      writerPid.resolve(backend!.pid)
      return new OpeningPackageService(
        tx as unknown as PrismaService,
        new OcrService(prisma),
      ).create(f.id, f.user, { sourceName: 'SYNTHETIC-M21.csv', innehall: openingCsv(f) })
    },
    { timeout: 15_000 },
  )
  let lock
  try {
    lock = await waitForBlock(await writerPid.promise, pid)
  } finally {
    release.resolve()
  }
  const result = await generation
  await writer
  const after = await snapshot(f)
  const next = await f.avisering.generateMonthlyNotices(f.id, 12, 2026),
    nextAfter = await snapshot(f)
  observed.assertNoticeLockFirst()
  record('R198 M21', {
    before,
    result,
    after,
    lock,
    next,
    nextAfter,
    transactionQueries: observed.trace,
  })
  expect(result.error).toBeNull()
  financialFacit(before, after, 1)
  expect(next).toMatchObject({ created: 0, blockedByOpening: 1 })
  financialFacit(after, nextAfter, 0)
})

it('R198 M22 concurrent same-period generators no duplicate', async () => {
  const f = await fixture('M22'),
    before = await snapshot(f)
  const results = await Promise.all([
    f.avisering.generateMonthlyNotices(f.id, f.month, f.year),
    f.avisering.generateMonthlyNotices(f.id, f.month, f.year),
  ])
  const after = await snapshot(f)
  record('R198 M22', { before, results, after })
  financialFacit(before, after, 1)
  expect(results.reduce((n, r) => n + r.created, 0)).toBe(1)
  expect(results.every((r) => r.blockedByOpening === 0)).toBe(true)
})

it('R198 M23 unrelated bank row insert waits for notice org lock then succeeds', async () => {
  const f = await fixture('M23'),
    before = await snapshot(f),
    generatorPid = signal<number>(),
    held = signal<void>(),
    release = signal<void>()
  const observed = observedService(generatorPid, held, release)
  const generation = attempt(() => observed.service.generateMonthlyNotices(f.id, f.month, f.year))
  await held.promise
  const pid = await generatorPid.promise,
    bankPid = signal<number>()
  const bank = db.$transaction(
    async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      bankPid.resolve(backend!.pid)
      return tx.bankTransaction.create({
        data: {
          organizationId: f.id,
          date: new Date('2026-11-01'),
          description: 'SYNTETISK198 kontention, ingen matchning',
          amount: 1,
        },
      })
    },
    { timeout: 15_000 },
  )
  let lock
  try {
    lock = await waitForBlock(await bankPid.promise, pid)
  } finally {
    release.resolve()
  }
  const result = await generation,
    bankRow = await bank,
    after = await snapshot(f)
  observed.assertNoticeLockFirst()
  record('R198 M23', { before, result, bankRow, after, lock, transactionQueries: observed.trace })
  expect(result.error).toBeNull()
  financialFacit(before, after, 1, 1)
  expect(bankRow.status).toBe('UNMATCHED')
})
