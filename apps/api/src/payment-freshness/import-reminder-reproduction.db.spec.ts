/**
 * Mäter verklig import -> registrerat datum/försök -> cron -> avgift/event i PostgreSQL.
 * F02-F05 är regressioner för nivå 1: första försök + NULL pausar automatiska effekter.
 * F01 bevarar nuläget utan registrerat försök; det intygar varken manuellt läge eller färskhet.
 * Två anslutningsordningar verifieras med pg_blocking_pids och riktiga tjänstetransaktioner.
 * Spionerna flyttar bara tidpunkter; felprovet F15 injicerar ett uttryckligt skrivfel.
 * Provet intygar inte fullständig kontotäckning, bankbetalning eller levererat mejl.
 * Separata avgifts-/räntetransaktioner och senare köleverans är inte en atomisk helhet.
 * F19 visar uttryckligen att giltigt datum + ogiltigt belopp fortfarande kan avancera datumet.
 * Alla egna rader städas; lika tabellantal/radantal intygar inte äldre raders innehåll.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma, PrismaClient } from '@prisma/client'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentBadDebtService } from '../avisering/rent-bad-debt.service'
import { RentDebtService } from '../avisering/rent-debt.service'
import { RentInterestService } from '../avisering/rent-interest.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { RentReminderService } from '../avisering/rent-reminder.service'
import { BankConsentCryptoService } from '../psd2/bank-consent-crypto.service'
import { Psd2SyncService } from '../psd2/psd2-sync.service'
import type { BankDataProvider } from '../psd2/psd2.types'
import { BankStatementImportService } from '../reconciliation/bank-statement-import.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { PaymentDataPausedError, PaymentFreshnessService } from './payment-freshness.service'

const NOW = new Date('2026-09-13T12:00:00.000Z')
const TODAY = '2026-09-13'
const CSV_BAD = Buffer.from('Datum;Beskrivning;Belopp\nogiltigt;Syntetisk rad;100\n')
const CSV_WITHDRAWAL = Buffer.from('Datum;Beskrivning;Belopp\n2026-09-13;Syntetiskt uttag;-100\n')
const PDF = Buffer.from('%PDF-1.4\n% syntetiskt parserunderlag\n%%EOF\n')
const outside = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error('Ej tillåten sidoeffekt i provet: ' + String(property))
    },
  },
)

describe('betalningsfärskhet — import till verklig påminnelse', () => {
  let db: PrismaClient
  let orgId: string | undefined
  let noticeId: string
  let rateId: string | undefined
  let freshness: PaymentFreshnessService
  let importer: ReconciliationService
  let reminders: RentReminderService
  let interest: RentInterestService
  let accounting: AccountingService
  let badDebt: RentBadDebtService
  const extraOrgIds: string[] = []
  let baseline: Record<string, number>
  const queue = { enqueue: jest.fn(async () => 'syntetiskt-jobb') }
  const mail = { sendCustomEmail: jest.fn(async () => undefined) }
  const errors = { report: jest.fn(async () => undefined) }
  const crypto = new BankConsentCryptoService(
    new ConfigService({
      PSD2_TOKEN_KEY: 'ab'.repeat(32),
    }),
  )

  async function counts() {
    const result: Record<string, number> = {}
    // Alla tabeller i testschemat, inklusive migrationshistorik och felsänkor.
    // Lika radantal bevisar städningens antal, inte varje äldre rads innehåll.
    const tables = await db.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename
    `
    for (const { tablename: table } of tables) {
      const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        'SELECT count(*) AS n FROM "' + table.replace(/"/g, '""') + '"',
      )
      result[table] = Number(rows[0]!.n)
    }
    return result
  }

  beforeAll(async () => {
    const value = process.env.DATABASE_URL
    if (!value) throw new Error('DATABASE_URL saknas: provet får inte hoppas över.')
    const url = new URL(value)
    if (
      !['localhost', '127.0.0.1', 'postgres'].includes(url.hostname) ||
      !(
        url.pathname === '/eveno_farskhet_test' ||
        (process.env.CI === 'true' && url.pathname === '/eken_dev')
      )
    ) {
      throw new Error('Endast egen lokal provdatabas eller CI:s databas tillåts.')
    }
    url.searchParams.set('connection_limit', '10')
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await db.$connect()
    baseline = await counts()
    console.warn('FARSKHET_RADER_FORE ' + JSON.stringify(baseline))
    const prior = await db.referenceInterestRate.findUnique({
      where: { effectiveFrom: new Date('2026-09-01') },
    })
    if (prior) throw new Error('Fixturens räntedatum är upptaget; låna inte omgivningens data.')
    const rate = await db.referenceInterestRate.create({
      data: {
        effectiveFrom: new Date('2026-09-01'),
        ratePercent: 2,
        source: 'syntetiskt färskhetsprov',
      },
    })
    rateId = rate.id
  }, 30_000)

  beforeEach(async () => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'hrtime',
        'queueMicrotask',
      ],
    })
    jest.clearAllMocks()
    const suffix = randomUUID()
    const org = await db.organization.create({
      data: {
        name: 'Färskhetsprov ' + suffix,
        email: 'org@example.invalid',
        street: 'Testgatan',
        city: 'Teststad',
        postalCode: '11111',
        remindersEnabled: true,
        rentReminderDay: 5,
        reminderFeeSek: 60,
        paymentDataStaleDays: 3,
        paymentDataThrough: null,
        paymentImportStartedAt: null,
      },
    })
    orgId = org.id
    await db.account.createMany({
      data: [
        { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: org.id, number: 3593, name: 'Påminnelseavgift', type: 'REVENUE' },
        { organizationId: org.id, number: 8131, name: 'Ränta', type: 'REVENUE' },
      ],
    })
    const property = await db.property.create({
      data: {
        organizationId: org.id,
        name: 'Testfastighet',
        propertyDesignation: suffix,
        type: 'RESIDENTIAL',
        street: 'Testgatan',
        city: 'Teststad',
        postalCode: '11111',
        totalArea: 100,
      },
    })
    const unit = await db.unit.create({
      data: {
        propertyId: property.id,
        name: 'Testlägenhet',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 9000,
      },
    })
    const tenant = await db.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: 'Hyresgäst',
        email: 'tenant@example.invalid',
      },
    })
    const lease = await db.lease.create({
      data: {
        organizationId: org.id,
        tenantId: tenant.id,
        unitId: unit.id,
        status: 'DRAFT',
        monthlyRent: 9000,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        reminderFeeTermsFrom: new Date('2026-01-01'),
      },
    })
    const notice = await db.rentNotice.create({
      data: {
        organizationId: org.id,
        tenantId: tenant.id,
        leaseId: lease.id,
        noticeNumber: 'TEST-' + suffix,
        ocrNumber: suffix.replace(/\D/g, '').slice(0, 10),
        month: 9,
        year: 2026,
        amount: 9000,
        totalAmount: 9000,
        dueDate: new Date('2026-09-01'),
        periodStart: new Date('2026-09-01'),
        status: 'OVERDUE',
        type: 'RENT',
        collectionStage: 'NONE',
        isBackfill: false,
      },
    })
    noticeId = notice.id
    accounting = new AccountingService(db as never, new VerifikationsnummerService(db as never))
    const events = new RentNoticeEventsService(db as never)
    freshness = new PaymentFreshnessService(db as never, mail as never)
    importer = new ReconciliationService(
      db as never,
      outside as never,
      outside as never,
      accounting,
      freshness,
      events,
      outside as never,
      outside as never,
    )
    interest = new RentInterestService(db as never, accounting, events, freshness)
    badDebt = new RentBadDebtService(
      db as never,
      accounting,
      events,
      new RentDebtService(db as never),
      freshness,
      outside as never,
      errors as never,
    )
    reminders = new RentReminderService(
      db as never,
      accounting,
      events,
      interest,
      queue as never,
      mail as never,
      outside as never,
      outside as never,
      new RentDebtService(db as never),
      freshness,
      errors as never,
      outside as never,
    )
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    if (!orgId || !db) return
    const where = { organizationId: orgId }
    await db.rentNoticeEvent.deleteMany({ where: { rentNotice: where } })
    await db.rentNoticeSend.deleteMany({ where: { rentNotice: where } })
    await db.journalEntryLine.deleteMany({ where: { journalEntry: where } })
    await db.journalEntry.deleteMany({ where })
    await db.journalEntrySequence.deleteMany({ where })
    await db.bankTransaction.deleteMany({ where })
    await db.bankStatementImport.deleteMany({ where })
    await db.bankConsent.deleteMany({ where })
    await db.rentNotice.deleteMany({ where })
    await db.account.deleteMany({ where })
    await db.lease.deleteMany({ where })
    await db.unit.deleteMany({ where: { property: where } })
    await db.property.deleteMany({ where })
    await db.notification.deleteMany({ where })
    await db.tenant.deleteMany({ where })
    await db.organization.delete({ where: { id: orgId } })
    orgId = undefined
    for (const extraOrgId of extraOrgIds.splice(0)) {
      await db.organization.delete({ where: { id: extraOrgId } })
    }
  })

  afterAll(async () => {
    if (!db) return
    try {
      if (rateId) await db.referenceInterestRate.delete({ where: { id: rateId } })
      const after = await counts()
      console.warn('FARSKHET_RADER_EFTER ' + JSON.stringify(after))
      expect(after).toEqual(baseline)
    } finally {
      await db.$disconnect()
    }
  })

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Tidsgräns i prov: ' + label)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // Fånga även förväntade avvisningar direkt, innan ett låsprov väntar på motparten.
  function settle<T>(promise: Promise<T>) {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
  }

  type LockableFreshness = {
    lockOrganization(
      tx: Prisma.TransactionClient,
      organizationId: string,
      shared?: boolean,
    ): Promise<void>
  }

  function holdFirstOrganizationLock() {
    const target = freshness as unknown as LockableFreshness
    const original = target.lockOrganization.bind(freshness)
    const firstLocked = deferred<number>()
    const secondEntered = deferred<number>()
    const release = deferred<void>()
    let calls = 0
    const spy = jest
      .spyOn(target, 'lockOrganization')
      .mockImplementation(async (tx, lockedOrgId, shared) => {
        if (lockedOrgId !== orgId) return original(tx, lockedOrgId, shared)
        const order = ++calls
        // Fast SQL; ingen låsnyckel konstrueras av testet. Produktionsporten äger den.
        const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          'SELECT pg_backend_pid() AS pid',
        )
        const pid = rows[0]!.pid
        if (order === 2) secondEntered.resolve(pid)
        await original(tx, lockedOrgId, shared)
        if (order === 1) {
          firstLocked.resolve(pid)
          await release.promise
        }
      })
    return {
      firstLocked: firstLocked.promise,
      secondEntered: secondEntered.promise,
      release: () => release.resolve(),
      restore: () => spy.mockRestore(),
    }
  }

  async function expectDatabaseBlocking(blockedPid: number, blockerPid: number) {
    expect(blockedPid).not.toBe(blockerPid)
    const deadline = performance.now() + 2_000
    let blockers: number[] = []
    do {
      // Parametriserat PID. Den tredje poolanslutningen observerar de två tjänsteanslutningarna.
      const rows = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
        'SELECT pg_blocking_pids($1::integer) AS blockers',
        blockedPid,
      )
      blockers = rows[0]!.blockers
      if (blockers.includes(blockerPid)) {
        console.warn('FARSKHET_LASVANTAN ' + JSON.stringify({ blockedPid, blockerPid, blockers }))
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    } while (performance.now() < deadline)
    throw new Error(
      'Ingen bevisad PostgreSQL-blockering: ' +
        JSON.stringify({ blockedPid, blockerPid, blockers }),
    )
  }

  async function expectNoPersistentEffect() {
    const notice = await db.rentNotice.findUniqueOrThrow({ where: { id: noticeId } })
    expect(notice.collectionStage).toBe('NONE')
    expect(notice.remindedAt).toBeNull()
    expect(Number(notice.reminderFeeAmount)).toBe(0)
    expect(Number(notice.interestAccruedAmount)).toBe(0)
    expect(await db.journalEntry.count({ where: { organizationId: orgId! } })).toBe(0)
    expect(await db.rentNoticeEvent.count({ where: { rentNoticeId: noticeId } })).toBe(0)
    expect(queue.enqueue).not.toHaveBeenCalled()
  }

  async function prepareCollectionNotice(stage: 'REMINDED' | 'INKASSO_READY') {
    await db.organization.update({
      where: { id: orgId! },
      data: {
        orgNumber: 'syntetiskt-orgnummer',
        rentInkassoDaysAfterReminder: 7,
        reminderFeeSek: 0,
      },
    })
    await db.account.createMany({
      data: [
        { organizationId: orgId!, number: 3911, name: 'Hyresintäkter', type: 'REVENUE' },
        { organizationId: orgId!, number: 1515, name: 'Osäkra kundfordringar', type: 'ASSET' },
      ],
    })
    const notice = await db.rentNotice.update({
      where: { id: noticeId },
      data: {
        collectionStage: stage,
        remindedAt: new Date('2026-09-06'),
        sentAt: new Date('2026-09-01'),
        reminderPdfStorageKey: 'syntetiskt/paaminnelse.pdf',
        vatAmount: 0,
        reminderFeeAmount: 0,
      },
    })
    await db.tenant.update({
      where: { id: notice.tenantId },
      data: {
        personalNumberHash: 'syntetisk-hash-' + orgId!,
        street: 'Hyresgästens testgata',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    const send = await db.rentNoticeSend.create({
      data: { rentNoticeId: noticeId, kind: 'REMINDER', toHash: 'syntetisk-mottagarhash' },
    })
    // Syntetiska registerbevis för befintliga INV-B-villkor; ingen PDF eller webhook skickas.
    await db.rentNoticeEvent.createMany({
      data: [
        { rentNoticeId: noticeId, type: 'SENT', actorType: 'SYSTEM' },
        { rentNoticeId: noticeId, type: 'REMINDER_SENT', actorType: 'SYSTEM', sendId: send.id },
        { rentNoticeId: noticeId, type: 'EMAIL_DELIVERED', actorType: 'SYSTEM', sendId: send.id },
      ],
    })
    if (!notice.leaseId) throw new Error('Fixturen saknar avtal')
    const entry = await accounting.createJournalEntryForRentNotice(
      { ...notice, leaseId: notice.leaseId },
      orgId!,
      null,
    )
    expect(entry).not.toBeNull()
    const persisted = await db.journalEntry.findFirstOrThrow({
      where: { organizationId: orgId!, source: 'INVOICE', sourceId: 'rent-notice:' + noticeId },
      include: { lines: { include: { account: true } } },
    })
    expect(
      persisted.lines
        .map((line) => ({
          account: line.account.number,
          debit: Number(line.debit),
          credit: Number(line.credit),
        }))
        .sort((a, b) => a.account - b.account),
    ).toEqual([
      { account: 1510, debit: 9000, credit: 0 },
      { account: 3911, debit: 0, credit: 9000 },
    ])
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    expect((await new RentDebtService(db as never).outstanding(noticeId, orgId!)).outstanding).toBe(
      9000,
    )
  }

  async function runCron(id: string) {
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    // Cronen saknar org-parameter: stoppa före anrop om den kan röra någon annans avi.
    const candidates = await db.rentNotice.findMany({
      where: {
        status: 'OVERDUE',
        type: 'RENT',
        collectionStage: 'NONE',
        isBackfill: false,
        organization: { remindersEnabled: true },
      },
      select: { id: true },
    })
    expect(candidates.map((row) => row.id)).toEqual([noticeId])
    expect(
      (await new RentDebtService(db as never).outstanding(noticeId, orgId!)).ocrOutstanding,
    ).toBe(9000)
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
    const gate = freshness.evaluate(org, NOW)
    const summary = await reminders.escalateOverdueRentNotices()
    expect(summary.errors).toBe(0)
    expect(errors.report).not.toHaveBeenCalled()
    const notice = await db.rentNotice.findUniqueOrThrow({ where: { id: noticeId } })
    const events = await db.rentNoticeEvent.count({
      where: { rentNoticeId: noticeId, type: 'REMINDER_SENT' },
    })
    const entries = await db.journalEntry.findMany({
      where: {
        organizationId: orgId!,
        sourceId: 'reminder-fee:' + noticeId,
      },
      include: { lines: { include: { account: true } } },
    })
    const observation = {
      id,
      through: org.paymentDataThrough?.toISOString().slice(0, 10) ?? null,
      importStartedAt: org.paymentImportStartedAt?.toISOString() ?? null,
      evaluateStaleDiagnostic: gate.stale,
      summary,
      stage: notice.collectionStage,
      fee: Number(notice.reminderFeeAmount),
      events,
      vouchers: entries.length,
      queued: queue.enqueue.mock.calls.length,
    }
    console.warn('FARSKHET_FALL ' + JSON.stringify(observation))
    return { ...observation, entries, remindedAt: notice.remindedAt }
  }

  function expectEffect(result: Awaited<ReturnType<typeof runCron>>) {
    expect(result).toMatchObject({
      stage: 'REMINDED',
      fee: 60,
      events: 1,
      vouchers: 1,
      queued: 1,
      summary: { reminded: 1, pausedStale: 0, errors: 0 },
    })
    expect(result.remindedAt).toEqual(NOW)
    expect(
      result.entries[0]!.lines.map((line) => ({
        account: line.account.number,
        debit: Number(line.debit),
        credit: Number(line.credit),
      })).sort((a, b) => a.account - b.account),
    ).toEqual([
      { account: 1510, debit: 60, credit: 0 },
      { account: 3593, debit: 0, credit: 60 },
    ])
  }

  function expectPaused(result: Awaited<ReturnType<typeof runCron>>) {
    // Mäter beständiga effekter, inte bara diagnosen från den första org-läsningen.
    expect(result).toMatchObject({
      stage: 'NONE',
      fee: 0,
      events: 0,
      vouchers: 0,
      queued: 0,
      summary: { reminded: 0, pausedStale: 1, errors: 0 },
    })
    expect(result.remindedAt).toBeNull()
  }

  async function failedPdf() {
    const parse = jest.fn(async () => {
      throw new Error('Syntetiskt parserfel')
    })
    const pdfImport = new BankStatementImportService(
      db as never,
      { parse } as never,
      importer,
      freshness,
    )
    await expect(pdfImport.uploadAndParsePdf(PDF, 'test.pdf', orgId!, null)).rejects.toThrow(
      'Syntetiskt parserfel',
    )
    expect(parse).toHaveBeenCalledTimes(1)
    expect(
      await db.bankStatementImport.findMany({
        where: { organizationId: orgId! },
        select: { status: true, errorMessage: true },
      }),
    ).toEqual([{ status: 'FAILED', errorMessage: 'Syntetiskt parserfel' }])
  }

  it('F06 KANARIEFÅGEL: daterat syntetiskt utdrag med endast uttag registrerar datum och avgiftsverifikat', async () => {
    const result = await importer.importBankStatement(CSV_WITHDRAWAL, 'test.csv', orgId!)
    expect(result).toMatchObject({ imported: 0, errors: [] })
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F06')
    expect(observed.through).toBe(TODAY)
    expectEffect(observed)
    const again = await reminders.escalateOverdueRentNotices()
    expect(again.reminded).toBe(0)
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(
      await db.journalEntry.count({
        where: {
          organizationId: orgId!,
          sourceId: 'reminder-fee:' + noticeId,
        },
      }),
    ).toBe(1)
  })

  it('F07 KANARIEFÅGEL: verklig äldre täckning pausar samma kandidat utan avgift eller köning', async () => {
    const csv = Buffer.from(CSV_WITHDRAWAL.toString().replace(TODAY, '2026-09-01'))
    await importer.importBankStatement(csv, 'gammalt.csv', orgId!)
    const observed = await runCron('F07')
    expect(observed.through).toBe('2026-09-01')
    expectPaused(observed)
  })

  it('F01 NULÄGE: NULL utan import eller samtycke släpper igenom; inget bevis på manuellt godkännande', async () => {
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    expect(await db.bankConsent.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F01')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBeNull()
    expectEffect(observed)
  })

  it('F02 SÄKERHET: första PDF-importens parserfel ska pausa automatisk avgift', async () => {
    await failedPdf()
    const observed = await runCron('F02')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expectPaused(observed)
  })

  it('F03 SÄKERHET: misslyckad första PSD2-hämtning ska pausa automatisk avgift', async () => {
    const consent = await db.bankConsent.create({
      data: {
        organizationId: orgId!,
        provider: 'MOCK',
        consentId: randomUUID(),
        status: 'ACTIVE',
        accessTokenEnc: crypto.encrypt('syntetisk-token'),
      },
    })
    const listAccounts = jest.fn(async () => {
      throw new Error('Syntetiskt providerfel')
    })
    const provider: BankDataProvider = {
      name: 'MOCK',
      beginConsent: async () => {
        throw new Error('Inte anropbar')
      },
      exchangeCallback: async () => {
        throw new Error('Inte anropbar')
      },
      revokeConsent: async () => {
        throw new Error('Inte anropbar')
      },
      getConsentStatus: async () => ({ status: 'ACTIVE' }),
      listAccounts,
      fetchTransactions: async () => {
        throw new Error('Får inte nås efter felet')
      },
    }
    const sync = new Psd2SyncService(db as never, importer, crypto, provider)
    await expect(sync.syncOrganization(orgId!)).rejects.toThrow('Syntetiskt providerfel')
    expect(listAccounts).toHaveBeenCalledTimes(1)
    expect(await db.bankConsent.findUnique({ where: { id: consent.id } })).toMatchObject({
      status: 'ACTIVE',
      lastSyncedAt: null,
      syncCursor: null,
    })
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F03')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expectPaused(observed)
  })

  it('F04 SÄKERHET: CSV med enbart ogiltiga datum ska pausa automatisk avgift', async () => {
    const result = await importer.importBankStatement(CSV_BAD, 'fel.csv', orgId!)
    expect(result).toMatchObject({ imported: 0, errors: ['Rad 2: Ogiltigt datum'] })
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F04')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expectPaused(observed)
  })

  it('F05 SÄKERHET: BgMax utan giltigt belopp ska pausa automatisk avgift', async () => {
    const section = '05' + ' '.repeat(20) + '20260913'
    const payment = '20' + ' '.repeat(10) + '12345'.padEnd(25) + 'X'.repeat(18)
    await expect(
      importer.importBgMaxFile(Buffer.from(section + '\n' + payment + '\n'), 'fel.txt', orgId!),
    ).rejects.toThrow('Inga giltiga BgMax-poster')
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F05')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expectPaused(observed)
  })

  it('F08: ett gammalt PDF-fel får inte hindra ett senare registrerat aktuellt datum', async () => {
    await failedPdf()
    await importer.importBankStatement(CSV_WITHDRAWAL, 'senare.csv', orgId!)
    const observed = await runCron('F08')
    expect(observed.through).toBe(TODAY)
    expectEffect(observed)
    expect(
      await db.bankStatementImport.count({
        where: { organizationId: orgId!, status: 'FAILED' },
      }),
    ).toBe(1)
  })
  it('F09 SÄKERHET: avvisad PDF-signatur registrerar försök före avvisning och pausar cron', async () => {
    const parse = jest.fn(async () => {
      throw new Error('Parsern får inte nås')
    })
    const pdfImport = new BankStatementImportService(
      db as never,
      { parse } as never,
      importer,
      freshness,
    )
    await expect(
      pdfImport.uploadAndParsePdf(Buffer.from('detta är inte en PDF'), 'fel.pdf', orgId!, null),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(parse).not.toHaveBeenCalled()
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F09')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expectPaused(observed)
  })

  it('F10 SÄKERHET: tom lyckad PSD2-synk skriver api-historik och försök men pausar utan datum', async () => {
    const consent = await db.bankConsent.create({
      data: {
        organizationId: orgId!,
        provider: 'MOCK',
        consentId: randomUUID(),
        status: 'ACTIVE',
        accessTokenEnc: crypto.encrypt('syntetisk-token'),
      },
    })
    const fetchTransactions = jest.fn(async () => ({ transactions: [], cursor: 'tom-sida' }))
    const provider: BankDataProvider = {
      name: 'MOCK',
      beginConsent: async () => {
        throw new Error('Inte anropbar')
      },
      exchangeCallback: async () => {
        throw new Error('Inte anropbar')
      },
      revokeConsent: async () => {
        throw new Error('Inte anropbar')
      },
      getConsentStatus: async () => ({ status: 'ACTIVE' }),
      listAccounts: async () => [{ accountId: 'syntetiskt-konto', currency: 'SEK' }],
      fetchTransactions,
    }
    const sync = new Psd2SyncService(db as never, importer, crypto, provider)
    expect(await sync.syncOrganization(orgId!)).toMatchObject({
      consents: 1,
      fetched: 0,
      imported: 0,
      matched: 0,
    })
    expect(fetchTransactions).toHaveBeenCalledTimes(1)
    expect(await db.bankConsent.findUnique({ where: { id: consent.id } })).toMatchObject({
      status: 'ACTIVE',
      lastSyncedAt: NOW,
      syncCursor: 'tom-sida',
    })
    expect(
      await db.bankStatementImport.findMany({
        where: { organizationId: orgId! },
        select: { status: true, fileType: true, transactionCount: true },
      }),
    ).toEqual([{ status: 'CONFIRMED', fileType: 'api', transactionCount: 0 }])
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F10')
    expect(observed.through).toBeNull()
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expectPaused(observed)
  })

  it('F11 BESTÄNDIGHET: första försöksdatum består vid nytt försök och SQL-triggern nekar radering eller ändring', async () => {
    await freshness.recordImportStarted(orgId!)
    const first = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
    expect(first.paymentImportStartedAt).toEqual(NOW)
    expect(first.paymentDataThrough).toBeNull()
    jest.setSystemTime(new Date('2026-09-14T12:00:00.000Z'))
    await freshness.recordImportStarted(orgId!)
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: orgId! } })).paymentImportStartedAt,
    ).toEqual(first.paymentImportStartedAt)
    await expect(
      db.organization.update({
        where: { id: orgId! },
        data: { paymentImportStartedAt: null },
      }),
    ).rejects.toThrow()
    await expect(
      db.organization.update({
        where: { id: orgId! },
        data: { paymentImportStartedAt: new Date('2026-09-14T12:00:00.000Z') },
      }),
    ).rejects.toThrow()
    const after = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
    expect(after.paymentImportStartedAt).toEqual(first.paymentImportStartedAt)
    expect(after.paymentDataThrough).toBeNull()
    await expectNoPersistentEffect()
  })

  it('F12 TOCTOU: ett försök efter cronens verkliga första utvärdering pausar med errors=0', async () => {
    const original = freshness.evaluateAndAlert.bind(freshness)
    const initial = jest
      .spyOn(freshness, 'evaluateAndAlert')
      .mockImplementationOnce(async (...args) => {
        const cached = await original(...args)
        expect(cached.has(orgId!)).toBe(false)
        await freshness.recordImportStarted(orgId!)
        // Samma oförändrade svar; bara ordningen mellan riktiga operationer styrs.
        return cached
      })
    const observed = await runCron('F12')
    expect(initial).toHaveBeenCalled()
    expect(observed.evaluateStaleDiagnostic).toBe(false)
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: orgId! } })).paymentImportStartedAt,
    ).toEqual(NOW)
    expectPaused(observed)
    await expectNoPersistentEffect()
  })

  it('F13 SAMTIDIGHET: importmarkörens verkliga transaktion vinner och blockerad effekt läser den efter commit', async () => {
    const timing = holdFirstOrganizationLock()
    const pending: Promise<unknown>[] = []
    try {
      const marker = settle(freshness.recordImportStarted(orgId!))
      pending.push(marker)
      const markerPid = await within(timing.firstLocked, 'markörens lås')
      const effect = settle(reminders.escalateNoticeToReminded(noticeId, orgId!, 12, 60))
      pending.push(effect)
      const effectPid = await within(timing.secondEntered, 'effektens låsförsök')
      await expectDatabaseBlocking(effectPid, markerPid)
      await expectNoPersistentEffect()
      timing.release()
      const markerResult = await marker
      if (!markerResult.ok) throw markerResult.error
      const effectResult = await effect
      expect(effectResult.ok).toBe(false)
      if (effectResult.ok) throw new Error('Effekten passerade trots tidigare committat försök')
      expect(effectResult.error).toBeInstanceOf(PaymentDataPausedError)
      const org = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
      expect(org.paymentImportStartedAt).toEqual(NOW)
      expect(org.paymentDataThrough).toBeNull()
      await expectNoPersistentEffect()
    } finally {
      timing.release()
      await Promise.all(pending)
      timing.restore()
    }
  }, 15_000)

  it('F14 SAMTIDIGHET: effektens verkliga transaktion vinner före importmarkören och dess committade avgift består', async () => {
    const timing = holdFirstOrganizationLock()
    const pending: Promise<unknown>[] = []
    try {
      const effect = settle(reminders.escalateNoticeToReminded(noticeId, orgId!, 12, 60))
      pending.push(effect)
      const effectPid = await within(timing.firstLocked, 'effektens lås')
      const marker = settle(freshness.recordImportStarted(orgId!))
      pending.push(marker)
      const markerPid = await within(timing.secondEntered, 'markörens låsförsök')
      await expectDatabaseBlocking(markerPid, effectPid)
      await expectNoPersistentEffect()
      timing.release()
      const effectResult = await effect
      if (!effectResult.ok) throw effectResult.error
      expect(effectResult.value).toBe(true)
      const markerResult = await marker
      if (!markerResult.ok) throw markerResult.error
      const org = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
      expect(org.paymentImportStartedAt).toEqual(NOW)
      expect(org.paymentDataThrough).toBeNull()
      expect(freshness.evaluate(org, NOW).stale).toBe(true)
      const notice = await db.rentNotice.findUniqueOrThrow({ where: { id: noticeId } })
      expect(notice.collectionStage).toBe('REMINDED')
      expect(Number(notice.reminderFeeAmount)).toBe(60)
      expect(
        await db.journalEntry.count({
          where: { organizationId: orgId!, sourceId: 'reminder-fee:' + noticeId },
        }),
      ).toBe(1)
      expect(
        await db.rentNoticeEvent.count({
          where: { rentNoticeId: noticeId, type: 'REMINDER_SENT' },
        }),
      ).toBe(1)
      // Direkt effektmetod: varken separat räntebokning eller köleverans ingår.
      expect(queue.enqueue).not.toHaveBeenCalled()
    } finally {
      timing.release()
      await Promise.all(pending)
      timing.restore()
    }
  }, 15_000)

  it('F15 FELINJEKTION: fel i försöksskrivningen stoppar PDF före parser och importrad', async () => {
    const failure = new Error('Syntetiskt fel vid beständig försöksskrivning')
    const start = jest.spyOn(freshness, 'recordImportStarted').mockRejectedValueOnce(failure)
    const parse = jest.fn(async () => {
      throw new Error('Parsern får inte nås efter skrivfelet')
    })
    const pdfImport = new BankStatementImportService(
      db as never,
      { parse } as never,
      importer,
      freshness,
    )
    await expect(pdfImport.uploadAndParsePdf(PDF, 'test.pdf', orgId!, null)).rejects.toThrow(
      failure.message,
    )
    expect(start).toHaveBeenCalledTimes(1)
    expect(parse).not.toHaveBeenCalled()
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: orgId! } })).paymentImportStartedAt,
    ).toBeNull()
    await expectNoPersistentEffect()
  })

  it('F16 ORGISOLERING: annan organisation kan committa ett försök medan första organisationens lås hålls', async () => {
    const other = await db.organization.create({
      data: {
        name: 'Annat låsprov ' + randomUUID(),
        email: 'annan-org@example.invalid',
        street: 'Andra testgatan',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    extraOrgIds.push(other.id)
    const timing = holdFirstOrganizationLock()
    const pending: Promise<unknown>[] = []
    try {
      const first = settle(freshness.recordImportStarted(orgId!))
      pending.push(first)
      await within(timing.firstLocked, 'första organisationens lås')
      const second = settle(freshness.recordImportStarted(other.id))
      pending.push(second)
      const secondResult = await within(second, 'annan organisation utan första låsets frigivning')
      if (!secondResult.ok) throw secondResult.error
      expect(
        (await db.organization.findUniqueOrThrow({ where: { id: other.id } }))
          .paymentImportStartedAt,
      ).toEqual(NOW)
      expect(
        (await db.organization.findUniqueOrThrow({ where: { id: orgId! } })).paymentImportStartedAt,
      ).toBeNull()
      timing.release()
      const firstResult = await first
      if (!firstResult.ok) throw firstResult.error
    } finally {
      timing.release()
      await Promise.all(pending)
      timing.restore()
    }
    await expectNoPersistentEffect()
  }, 15_000)

  it('F17 PORTKONTRAKT: root-Prisma nekas även när organisationen skulle tillåtas', async () => {
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
    expect(freshness.evaluate(org, NOW).stale).toBe(false)
    const result = await settle(freshness.assertAutomaticEffectAllowed(db as never, orgId!, NOW))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Root-klienten accepterades som transaktionsport')
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error).not.toBeInstanceOf(PaymentDataPausedError)
    expect((result.error as Error).message).toMatch(/transaction|transaktion|client|klient/i)
    await expectNoPersistentEffect()
  })

  it('F18 PORTKONTRAKT: verklig RepeatableRead-transaktion nekas före effekt', async () => {
    await db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ transaction_isolation: string }>>(
          'SHOW transaction_isolation',
        )
        expect(rows[0]!.transaction_isolation).toBe('repeatable read')
        const result = await settle(freshness.assertAutomaticEffectAllowed(tx, orgId!, NOW))
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('RepeatableRead accepterades som transaktionsport')
        expect(result.error).toBeInstanceOf(Error)
        expect(result.error).not.toBeInstanceOf(PaymentDataPausedError)
        expect((result.error as Error).message).toMatch(/read.?committed/i)
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    )
    await expectNoPersistentEffect()
  })

  it('F19 KVARSTÅENDE NULÄGE: CSV med giltigt datum men ogiltigt belopp registrerar ändå datum och tillåter avgift', async () => {
    const csv = Buffer.from(
      'Datum;Beskrivning;Belopp\n2026-09-13;Syntetisk felaktig rad;ogiltigt\n',
    )
    const result = await importer.importBankStatement(csv, 'felbelopp.csv', orgId!)
    expect(result).toMatchObject({ imported: 0, errors: ['Rad 2: Ogiltigt belopp'] })
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F19')
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expect(observed.through).toBe(TODAY)
    // GRÖNT nulägesprov av avgränsningen; detta är inte löst eller verifierad banktäckning.
    expectEffect(observed)
  })

  it('F20 RÄNTA: ett registrerat försök skyddar även den separata riktiga räntetransaktionen', async () => {
    await freshness.recordImportStarted(orgId!)
    await expect(interest.crystallizeInterest(noticeId, orgId!, NOW)).rejects.toBeInstanceOf(
      PaymentDataPausedError,
    )
    await expectNoPersistentEffect()
  })

  it('F21 INKASSO: sen markör efter riktig ränta och första croncheck stoppar själva inkassoflippen', async () => {
    await prepareCollectionNotice('REMINDED')
    const candidates = await db.rentNotice.findMany({
      where: {
        type: 'RENT',
        status: 'OVERDUE',
        collectionStage: 'REMINDED',
        organization: { remindersEnabled: true },
      },
      select: { id: true },
    })
    expect(candidates.map((row) => row.id)).toEqual([noticeId])
    const initial = jest.spyOn(freshness, 'evaluateAndAlert')
    const effect = jest.spyOn(reminders, 'escalateNoticeToInkassoReady')
    const originalInterest = interest.crystallizeInterest.bind(interest)
    const timedInterest = jest
      .spyOn(interest, 'crystallizeInterest')
      .mockImplementationOnce(async (...args) => {
        const result = await originalInterest(...args)
        // Verklig ränta har redan committat. Markören ska stoppa NÄSTA effekttransaktion.
        expect(result?.delta).toBeGreaterThan(0)
        expect(initial).toHaveBeenCalled()
        await freshness.recordImportStarted(orgId!)
        return result
      })
    const summary = await reminders.escalateRemindedToInkassoReady()
    expect(summary).toMatchObject({ ready: 0, pausedStale: 1, blocked: 0, skipped: 0, errors: 0 })
    expect(errors.report).not.toHaveBeenCalled()
    expect((await initial.mock.results[0]!.value).has(orgId!)).toBe(false)
    expect(effect).toHaveBeenCalledTimes(1)
    await expect(effect.mock.results[0]!.value).rejects.toBeInstanceOf(PaymentDataPausedError)
    expect(timedInterest).toHaveBeenCalledTimes(1)
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
    expect(org.paymentImportStartedAt).toEqual(NOW)
    expect(org.paymentDataThrough).toBeNull()
    const paused = await db.rentNotice.findUniqueOrThrow({ where: { id: noticeId } })
    expect(paused.collectionStage).toBe('REMINDED')
    expect(paused.collectionReadyAt).toBeNull()
    expect(Number(paused.interestAccruedAmount)).toBeGreaterThan(0)
    expect(
      await db.rentNoticeEvent.count({
        where: { rentNoticeId: noticeId, type: 'COLLECTION_READY' },
      }),
    ).toBe(0)
    expect(
      await db.rentNoticeEvent.count({
        where: { rentNoticeId: noticeId, type: 'INTEREST_ACCRUED' },
      }),
    ).toBe(1)
    // Ursprung + redan committad ränta består; provet lovar ingen återställning av tidigare effekt.
    expect(await db.journalEntry.count({ where: { organizationId: orgId! } })).toBe(2)
    expect(queue.enqueue).not.toHaveBeenCalled()
    console.warn(
      'FARSKHET_FALL ' + JSON.stringify({ id: 'F21', summary, stage: paused.collectionStage }),
    )

    // Samma kompletta fixtur passerar när ett datum registrerats: annan precheck maskerar inte grinden.
    await freshness.recordPaymentDataThrough(orgId!, NOW)
    await expect(
      reminders.escalateNoticeToInkassoReady(noticeId, orgId!, NOW),
    ).resolves.toMatchObject({
      flipped: true,
    })
    expect(
      await db.rentNoticeEvent.count({
        where: { rentNoticeId: noticeId, type: 'COLLECTION_READY' },
      }),
    ).toBe(1)
    expect(await db.journalEntry.count({ where: { organizationId: orgId! } })).toBe(2)
  }, 15_000)

  it('F22 BEFARAD FÖRLUST: sen markör pausar riktig automatisk omklassning; explicit manuell väg består', async () => {
    await prepareCollectionNotice('INKASSO_READY')
    const candidates = await db.rentNotice.findMany({
      where: {
        type: 'RENT',
        collectionStage: 'INKASSO_READY',
        probableLossAt: null,
        status: { notIn: ['PAID', 'CANCELLED'] },
        organization: { remindersEnabled: true },
      },
      select: { id: true },
    })
    expect(candidates.map((row) => row.id)).toEqual([noticeId])
    const original = freshness.evaluateAndAlert.bind(freshness)
    jest.spyOn(freshness, 'evaluateAndAlert').mockImplementationOnce(async (...args) => {
      const cached = await original(...args)
      expect(cached.has(orgId!)).toBe(false)
      await freshness.recordImportStarted(orgId!)
      return cached
    })
    const automatic = jest.spyOn(badDebt, 'automaticallyReclassifyToProbableLoss')
    const summary = await badDebt.reclassifyProbableLosses()
    expect(summary).toMatchObject({
      reclassified: 0,
      pausedStale: 1,
      errors: 0,
      skipped: 0,
      manual: 0,
      blockedNoAccrual: 0,
      creditedInterestOnly: 0,
    })
    expect(errors.report).not.toHaveBeenCalled()
    expect(automatic).toHaveBeenCalledTimes(1)
    await expect(automatic.mock.results[0]!.value).rejects.toBeInstanceOf(PaymentDataPausedError)
    const paused = await db.rentNotice.findUniqueOrThrow({ where: { id: noticeId } })
    expect(paused.collectionStage).toBe('INKASSO_READY')
    expect(paused.probableLossAt).toBeNull()
    expect(await db.journalEntry.count({ where: { organizationId: orgId! } })).toBe(1)
    expect(
      await db.journalEntry.count({
        where: { organizationId: orgId!, sourceId: 'bad-debt-probable:' + noticeId },
      }),
    ).toBe(0)
    expect(
      await db.rentNoticeEvent.count({
        where: { rentNoticeId: noticeId, type: 'NOTE_ADDED' },
      }),
    ).toBe(0)
    console.warn(
      'FARSKHET_FALL ' +
        JSON.stringify({ id: 'F22', summary, probableLossAt: paused.probableLossAt }),
    )

    // Explicit metodval styr vägen; actorId=null får inte ensamt betyda automatisk policy.
    // Detta provar tjänstekontraktet, inte HTTP-auktorisering för den manuella åtgärden.
    await expect(badDebt.reclassifyToProbableLoss(noticeId, orgId!, null)).resolves.toEqual({
      booked: true,
    })
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { organizationId: orgId!, sourceId: 'bad-debt-probable:' + noticeId },
      include: { lines: { include: { account: true } } },
    })
    expect(
      entry.lines
        .map((line) => ({
          account: line.account.number,
          debit: Number(line.debit),
          credit: Number(line.credit),
        }))
        .sort((a, b) => a.account - b.account),
    ).toEqual([
      { account: 1510, debit: 0, credit: 9000 },
      { account: 1515, debit: 9000, credit: 0 },
    ])
    expect(
      (await db.rentNotice.findUniqueOrThrow({ where: { id: noticeId } })).probableLossAt,
    ).toEqual(NOW)
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId! } })
    expect(org.paymentImportStartedAt).toEqual(NOW)
    expect(org.paymentDataThrough).toBeNull()
    expect(queue.enqueue).not.toHaveBeenCalled()
  }, 15_000)

  it('F23 LÅSRÄCKVIDD: två riktiga effektportar i samma org kan passera delat lås utan bokföring', async () => {
    const timing = holdFirstOrganizationLock()
    const pending: Promise<unknown>[] = []
    const passEffectPort = () =>
      db.$transaction(
        async (tx) => {
          await freshness.assertAutomaticEffectAllowed(tx, orgId!, NOW)
          return true
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      )
    try {
      const first = settle(passEffectPort())
      pending.push(first)
      const firstPid = await within(timing.firstLocked, 'första delade effektlåset')
      const second = settle(passEffectPort())
      pending.push(second)
      const secondPid = await within(timing.secondEntered, 'andra delade effektlåset')
      expect(secondPid).not.toBe(firstPid)
      const secondResult = await within(second, 'andra effektporten innan första frigörs')
      if (!secondResult.ok) throw secondResult.error
      expect(secondResult.value).toBe(true)
      // Första tx hålls fortfarande öppen av spionen. Bara porten, inga pengalås, har passerats.
      await expectNoPersistentEffect()
      timing.release()
      const firstResult = await first
      if (!firstResult.ok) throw firstResult.error
      expect(firstResult.value).toBe(true)
    } finally {
      timing.release()
      await Promise.all(pending)
      timing.restore()
    }
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: orgId! } })).paymentImportStartedAt,
    ).toBeNull()
  }, 15_000)
})
