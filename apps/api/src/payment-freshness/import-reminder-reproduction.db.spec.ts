/**
 * Mäter verklig import -> registrerat datum/försök -> cron -> avgift/event i PostgreSQL.
 * F02-F05 är regressioner för nivå 1: första försök + NULL pausar automatiska effekter.
 * F01 bevarar nuläget utan registrerat försök; det intygar varken manuellt läge eller färskhet.
 * Två anslutningsordningar verifieras med pg_blocking_pids och riktiga tjänstetransaktioner.
 * Spionerna flyttar bara tidpunkter; felprovet F15 injicerar ett uttryckligt skrivfel.
 * Provet intygar inte fullständig kontotäckning, bankbetalning eller levererat mejl.
 * Separata avgifts-/räntetransaktioner och senare köleverans är inte en atomisk helhet.
 * F19 och F24-F34 prövar filfel; matchError och parserprefix särredovisas som kvarvarande gränser.
 * Alla egna rader städas; lika tabellantal/radantal intygar inte äldre raders innehåll.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
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
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'

const NOW = new Date('2026-09-13T12:00:00.000Z')
const TODAY = '2026-09-13'

// Fasta lagringsfacit, beslutade före produktionsändring; inte härledda av parsern.
const AMOUNT_ACCEPTANCE = [
  ['heltal', '123', '123.00', false],
  ['noll', '0', null, false],
  ['plustecken', '+123', '123.00', false],
  ['uttag', '-123', null, false],
  ['decimalcomma', '123,45', '123.45', false],
  ['decimalpunkt', '123.45', '123.45', false],
  ['grupp blanksteg', '1 234,56', '1234.56', false],
  ['grupp NBSP', '1 234,56', '1234.56', false],
  ['grupp smalt NBSP', '1 234.56', '1234.56', false],
  ['flera grupper', '1 234 567,89', '1234567.89', false],
  ['blandade godkända gruppblanksteg', '1 234 567,89', '1234567.89', false],
  ['omgivande blanktecken', '\t +1 234,56  ', '1234.56', false],
  ['inledande decimalpunkt', '.5', '0.50', false],
  ['inledande decimalcomma', ',5', '0.50', false],
  ['avslutande decimalpunkt', '1.', '1.00', false],
  ['avslutande decimalcomma', '1,', '1.00', false],
  ['hel exponent', '1e2', '100.00', false],
  ['decimal exponent', '1,25e+2', '125.00', false],
  ['negativ exponentbetalning', '-1E2', null, false],
  ['grupperad mantissa', '1 234e-1', '123.40', false],
  ['single comma är decimal', '1,234', '1.23', false],
  ['single punkt är decimal', '1.234', '1.23', false],
  ['avrundning 1.005', '1.005', '1.00', false],
  ['avrundning 2.675', '2.675', '2.67', false],
  ['positivt under öret', '0.001', '0.00', false],
  ['underflow till noll', '1e-999', null, false],
  ['minsta positiva avrundning', '3e-324', '0.00', false],
  ['databasens max', '9999999999.99', '9999999999.99', false],
  ['suffix skräp', '123skräp', null, true],
  ['suffix valuta', '123kr', null, true],
  ['inre bokstäver', '123abc456', null, true],
  ['ofullständig exponent', '1e', null, true],
  ['ofullständig plus-exponent', '1e+', null, true],
  ['ofullständig minus-exponent', '1e-', null, true],
  ['exponent med suffix', '1e2skräp', null, true],
  ['grupp 1 2 3', '1 2 3', null, true],
  ['kort sista grupp', '12 34', null, true],
  ['för lång första grupp', '1234 567', null, true],
  ['för lång sista grupp', '1 2345', null, true],
  ['inre tab', '1\t234', null, true],
  ['inre CR', '1\r234', null, true],
  ['dubbla commas', '1,2,3', null, true],
  ['dubbla punkter', '1.2.3', null, true],
  ['blandade separatorer US', '1,234.56', null, true],
  ['blandade separatorer EU', '1.234,56', null, true],
  ['inre tecken', '1-23', null, true],
  ['mellanrum efter plus', '+ 123', null, true],
  ['dubbelt tecken', '--1', null, true],
  ['hexliknande', '0x10', null, true],
  ['binärliknande', '0b10', null, true],
  ['NaN', 'NaN', null, true],
  ['Infinity', 'Infinity', null, true],
  ['negativ Infinity', '-Infinity', null, true],
  ['exponentoverflow', '1e309', null, true],
  ['över databasens max', '10000000000', null, true],
  ['avrundning över max', '9 999 999 999,995', null, true],
  ['över Number-heltalsprecision', '9007199254740993', null, true],
] as const

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
  const shadowQueue = { enqueue: jest.fn(async () => 'syntetiskt-skuggjobb') }
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
      shadowQueue as never,
      outside as never,
      // #F034b — filnivåns importskydd. Riktig tjänst över samma prisma som
      // resten av riggen: proven nedan som inte kör en import når den aldrig,
      // och de som gör det ska se skyddet och inte ett genomsläpp.
      new BankImportAttemptService(db as never),
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

  async function runCron(id: string, expectedBankRows = 0) {
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(
      expectedBankRows,
    )
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
      // #F034b — filnivåns importskydd. Riktig tjänst över samma prisma som
      // resten av riggen: proven nedan som inte kör en import når den aldrig,
      // och de som gör det ska se skyddet och inte ett genomsläpp.
      new BankImportAttemptService(db as never),
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
    expect(result).toMatchObject({
      imported: 0,
      errors: [
        'Rad 2: Ogiltigt datum. Betalningsunderlagets datum uppdaterades inte. Rätta filen och importera igen.',
      ],
    })
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
      // #F034b — filnivåns importskydd. Riktig tjänst över samma prisma som
      // resten av riggen: proven nedan som inte kör en import når den aldrig,
      // och de som gör det ska se skyddet och inte ett genomsläpp.
      new BankImportAttemptService(db as never),
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
      // #F034b — filnivåns importskydd. Riktig tjänst över samma prisma som
      // resten av riggen: proven nedan som inte kör en import når den aldrig,
      // och de som gör det ska se skyddet och inte ett genomsläpp.
      new BankImportAttemptService(db as never),
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

  it('F19 FILFEL: giltigt datum men ogiltigt belopp får inte förnya datum eller frigöra avgift', async () => {
    const csv = Buffer.from(
      'Datum;Beskrivning;Belopp\n2026-09-13;Syntetisk felaktig rad;ogiltigt\n',
    )
    const result = await importer.importBankStatement(csv, 'felbelopp.csv', orgId!)
    expect(result).toMatchObject({
      imported: 0,
      errors: [
        'Rad 2: Ogiltigt belopp. Betalningsunderlagets datum uppdaterades inte. Rätta filen och importera igen.',
      ],
    })
    expect(await db.bankTransaction.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F19')
    expect(observed.importStartedAt).toBe(NOW.toISOString())
    expect(observed.through).toBeNull()
    expectPaused(observed)
    fileCasePassed('F19', result, observed)
  })

  // Inga parser-/datum-/cronmockar. XLSX.write skapar riktiga små arbetsböcker.
  type FileFormat = 'csv' | 'xlsx' | 'xls'
  type Cell = string | number | undefined
  function fileBuffer(
    format: FileFormat,
    rows: Cell[][],
    headers = ['Datum', 'Beskrivning', 'Belopp'],
  ) {
    const cells = [headers, ...rows]
    if (format === 'csv') return Buffer.from(cells.map((row) => row.join(';')).join('\n') + '\n')
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(cells), 'Syntetiskt')
    return XLSX.write(book, { type: 'buffer', bookType: format }) as Buffer
  }

  async function importRows(format: FileFormat, rows: Cell[][], headers?: string[]) {
    return importer.importBankStatement(
      fileBuffer(format, rows, headers),
      'syntetiskt.' + format,
      orgId!,
    )
  }

  async function bankRows() {
    return db.bankTransaction.findMany({
      where: { organizationId: orgId! },
      orderBy: { description: 'asc' },
    })
  }

  function expectFileError(result: Awaited<ReturnType<typeof importRows>>, count = 1) {
    expect(result.errors).toHaveLength(count)
    for (const error of result.errors) {
      expect(error).toContain('Betalningsunderlagets datum uppdaterades inte.')
      expect(error).toContain('Rätta filen och importera igen.')
      expect(error).not.toMatch(/paus/i)
    }
  }

  // Skrivs först EFTER fallets assertions. CI-loggen kan kontrollera namngivna fall,
  // inte bara att filen laddades. Utfallen innehåller enbart syntetiska uppgifter.
  function fileCasePassed(
    id: string,
    result: Awaited<ReturnType<typeof importRows>> | { rejectedEmptyFile: true },
    observed: Awaited<ReturnType<typeof runCron>>,
  ) {
    const effect = {
      through: observed.through,
      importStartedAt: observed.importStartedAt,
      summary: observed.summary,
      stage: observed.stage,
      fee: observed.fee,
      events: observed.events,
      vouchers: observed.vouchers,
      queued: observed.queued,
    }
    console.warn(
      'FILFEL_ASSERTIONS_OK ' +
        JSON.stringify({ test: expect.getState().currentTestName, id, result, effect }),
    )
  }

  describe.each(['csv', 'xlsx'] as const)('filkontrakt genom produktionsparser: %s', (format) => {
    it.each([
      { position: 'först', failedDate: '2026-09-12' },
      { position: 'sist', failedDate: '2026-09-12' },
      { position: 'först', failedDate: '2026-09-14' },
      { position: 'sist', failedDate: '2026-09-14' },
    ])(
      'F24 BLANDAT: fel $position med datum $failedDate maskeras inte av lyckad aktuell rad',
      async ({ position, failedDate }) => {
        const good = [TODAY, 'Syntetisk giltig rad', '100']
        const bad = [failedDate, 'Syntetisk felaktig rad', 'ogiltigt']
        const result = await importRows(format, position === 'först' ? [bad, good] : [good, bad])
        expect(result).toMatchObject({ imported: 1, duplicates: 0, autoMatched: 0, unmatched: 1 })
        expectFileError(result)
        expect(await bankRows()).toMatchObject([
          { description: 'Syntetisk giltig rad', date: new Date(TODAY), status: 'UNMATCHED' },
        ])
        const observed = await runCron(`F24 ${format} ${position} ${failedDate}`, 1)
        expect(observed.through).toBeNull()
        expectPaused(observed)
        fileCasePassed(observed.id, result, observed)
      },
    )

    it.each([
      { label: 'ogiltigt datum', date: 'ogiltigt', amount: '100' },
      { label: 'saknad datumcell', date: '', amount: '100' },
      { label: 'saknad beloppscell', date: TODAY, amount: '' },
      { label: 'ogiltigt belopp', date: TODAY, amount: 'ogiltigt' },
      { label: 'Infinity', date: TODAY, amount: 'Infinity' },
      { label: '-Infinity', date: TODAY, amount: '-Infinity' },
      { label: 'överflöde', date: TODAY, amount: '1e999' },
      { label: 'tomma obligatoriska fält i datarad', date: '', amount: '' },
    ])('F25 VALIDERING: $label lämnar inget datum', async ({ label, date, amount }) => {
      const result = await importRows(format, [[date, 'Syntetisk felrad', amount]])
      expect(result).toMatchObject({ imported: 0, duplicates: 0, autoMatched: 0, unmatched: 0 })
      expectFileError(result)
      const observed = await runCron(`F25 ${format} ${label}`)
      expect(observed.through).toBeNull()
      expectPaused(observed)
      fileCasePassed(observed.id, result, observed)
    })

    it.each(['Datum', 'Belopp'])(
      'F26 FÄLT: saknad obligatorisk kolumn %s är radfel',
      async (missing) => {
        const headers = missing === 'Datum' ? ['Beskrivning', 'Belopp'] : ['Datum', 'Beskrivning']
        const row = missing === 'Datum' ? ['Syntetisk rad', '100'] : [TODAY, 'Syntetisk rad']
        const result = await importRows(format, [row], headers)
        expect(result.imported).toBe(0)
        expectFileError(result)
        const observed = await runCron(`F26 ${format} ${missing}`)
        expect(observed.through).toBeNull()
        expectPaused(observed)
        fileCasePassed(observed.id, result, observed)
      },
    )

    it('F27 LAGRING/ÅTERIMPORT: DB nekar en rad; sparad rad behålls och verklig dedup används vid nytt försök', async () => {
      const rows = [
        [TODAY, 'Syntetisk behållen rad', '100'],
        ['2026-09-14', 'Syntetisk lagringsrad', '200'],
      ]
      const buffer = fileBuffer(format, rows)
      // Egen trigger avgränsad till fixturens org och rad. Inga andra rader påverkas.
      // UUID och namn skapas av riggen; inga användarsträngar interpoleras i SQL.
      const trigger = 'filfel_' + randomUUID().replace(/-/g, '')
      await db.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."organizationId" = '${orgId!}' AND NEW.description = 'Syntetisk lagringsrad' THEN
            RAISE EXCEPTION 'Ogiltigt belopp';
          END IF;
          RETURN NEW;
        END $$`)
      let keptId: string
      try {
        await db.$executeRawUnsafe(
          `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`,
        )
        const first = await importer.importBankStatement(buffer, 'syntetiskt.' + format, orgId!)
        expect(first).toMatchObject({ imported: 1, duplicates: 0, unmatched: 1 })
        expectFileError(first)
        expect(first.errors[0]).toContain('Ogiltigt belopp')
        const saved = await bankRows()
        expect(saved).toHaveLength(1)
        expect(saved[0]).toMatchObject({
          description: rows[0]![1],
          date: new Date(TODAY),
          status: 'UNMATCHED',
        })
        expect(Number(saved[0]!.amount)).toBe(100)
        keptId = saved[0]!.id
        const observed = await runCron(`F27 ${format} lagringsfel`, 1)
        expect(observed.through).toBeNull()
        expectPaused(observed)
        fileCasePassed(observed.id, first, observed)
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "BankTransaction"`)
        await db.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`)
      }
      // Samma bytes, felet avhjälpt. findFirst/create/matchTransaction är verkliga.
      const second = await importer.importBankStatement(buffer, 'syntetiskt.' + format, orgId!)
      expect(second).toMatchObject({
        imported: 1,
        duplicates: 1,
        autoMatched: 0,
        unmatched: 1,
        errors: [],
      })
      const saved = await bankRows()
      expect(
        saved.map((row) => ({
          id: row.id,
          description: row.description,
          amount: Number(row.amount),
          date: row.date.toISOString().slice(0, 10),
          status: row.status,
        })),
      ).toEqual([
        {
          id: keptId!,
          description: 'Syntetisk behållen rad',
          amount: 100,
          date: TODAY,
          status: 'UNMATCHED',
        },
        {
          id: expect.any(String),
          description: 'Syntetisk lagringsrad',
          amount: 200,
          date: '2026-09-14',
          status: 'UNMATCHED',
        },
      ])
      expect(
        await db.rentNoticePayment.count({ where: { rentNotice: { organizationId: orgId! } } }),
      ).toBe(0)
      const observed = await runCron(`F27 ${format} återimport`, 2)
      // Befintlig färskhetstjänst begränsar framtida datum till dagens datum.
      expect(observed.through).toBe(TODAY)
      expectEffect(observed)
      fileCasePassed(observed.id, second, observed)
    })

    it.each(['uttag', 'noll', 'dubblett'])(
      'F28 BEVARAT: endast %s behåller datumunderlaget',
      async (kind) => {
        await db.organization.update({
          where: { id: orgId! },
          data: { paymentDataThrough: new Date('2026-09-01') },
        })
        const amount = kind === 'uttag' ? -100 : kind === 'noll' ? 0 : 100
        const description = 'Syntetisk bevarad rad'
        const seeded =
          kind === 'dubblett'
            ? await db.bankTransaction.create({
                data: { organizationId: orgId!, date: new Date(TODAY), description, amount },
              })
            : null
        const result = await importRows(format, [[TODAY, description, amount]])
        expect(result).toMatchObject({
          imported: 0,
          duplicates: seeded ? 1 : 0,
          autoMatched: 0,
          unmatched: 0,
          errors: [],
        })
        const saved = await bankRows()
        expect(saved.map((row) => row.id)).toEqual(seeded ? [seeded.id] : [])
        const observed = await runCron(`F28 ${format} ${kind}`, seeded ? 1 : 0)
        expect(observed.through).toBe(TODAY)
        expectEffect(observed)
        fileCasePassed(observed.id, result, observed)
      },
    )

    it.each(['unmatched', 'matchError'])(
      'F29 MATCHNING: %s efter lagring särredovisas med bevarad policy',
      async (kind) => {
        if (kind === 'matchError')
          jest.spyOn(importer, 'matchTransaction').mockRejectedValue(new Error('Ogiltigt belopp'))
        const result = await importRows(format, [[TODAY, 'Syntetisk omatchad rad', 123]])
        expect(result).toMatchObject({
          imported: 1,
          duplicates: 0,
          autoMatched: 0,
          unmatched: kind === 'unmatched' ? 1 : 0,
          errors: kind === 'unmatched' ? [] : ['Rad 2: Ogiltigt belopp'],
        })
        const saved = await bankRows()
        expect(saved).toHaveLength(1)
        expect(saved[0]!.status).toBe('UNMATCHED')
        expect(Number(saved[0]!.amount)).toBe(123)
        expect(shadowQueue.enqueue).toHaveBeenCalledTimes(kind === 'unmatched' ? 1 : 0)
        const observed = await runCron(`F29 ${format} ${kind}`, 1)
        expect(observed.through).toBe(TODAY)
        expectEffect(observed)
        fileCasePassed(observed.id, result, observed)
      },
    )

    it.each(['tom', 'rubriker', 'blankrader'])(
      'F30 TOMT: %s ger inget påhittat datum',
      async (kind) => {
        let buffer: Buffer
        if (kind === 'tom') {
          if (format === 'csv') buffer = Buffer.alloc(0)
          else {
            const book = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Tomt')
            buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
          }
        } else buffer = fileBuffer(format, kind === 'blankrader' ? [[], [], []] : [])
        let result: Awaited<ReturnType<typeof importRows>> | { rejectedEmptyFile: true }
        if (kind === 'tom' && format === 'csv') {
          await expect(importer.importBankStatement(buffer, 'tom.csv', orgId!)).rejects.toThrow(
            BadRequestException,
          )
          result = { rejectedEmptyFile: true }
        } else {
          result = await importer.importBankStatement(buffer, 'tom.' + format, orgId!)
          expect(result).toMatchObject({ imported: 0, duplicates: 0, unmatched: 0, errors: [] })
        }
        const observed = await runCron(`F30 ${format} ${kind}`)
        expect(observed.through).toBeNull()
        expect(observed.importStartedAt).toBe(NOW.toISOString())
        expectPaused(observed)
        fileCasePassed(observed.id, result, observed)
      },
    )

    it.each([null, '2026-09-01', '2026-09-10'])(
      'F31 TIDIGARE DATUM: %s bevaras efter filfel med dagens åldersregel',
      async (prior) => {
        await db.organization.update({
          where: { id: orgId! },
          data: { paymentDataThrough: prior ? new Date(prior) : null },
        })
        const result = await importRows(format, [[TODAY, 'Syntetisk felrad', 'ogiltigt']])
        expectFileError(result)
        const observed = await runCron(`F31 ${format} ${prior}`)
        expect(observed.through).toBe(prior)
        if (prior === '2026-09-10') expectEffect(observed)
        else expectPaused(observed)
        fileCasePassed(observed.id, result, observed)
      },
    )

    it('F32 STRIKT BELOPP: numeriskt prefix får inte skapa bankrad, datum eller avgift', async () => {
      const result = await importRows(format, [[TODAY, 'Syntetisk prefixrad', '123skräp']])
      const saved = await bankRows()
      // Observera faktisk cron före säkerhetsassertionerna även i före-/negativprovet.
      const observed = await runCron(`F32 ${format}`, saved.length)
      console.warn(
        'BELOPP_F32_OBSERVATION ' +
          JSON.stringify({
            format,
            result,
            amounts: saved.map((row) => row.amount.toFixed(2)),
            through: observed.through,
            fee: observed.fee,
            events: observed.events,
            vouchers: observed.vouchers,
            queued: observed.queued,
          }),
      )
      expect(saved).toHaveLength(0)
      expect(result).toMatchObject({ imported: 0, duplicates: 0, unmatched: 0 })
      expectFileError(result)
      expect(observed.through).toBeNull()
      expectPaused(observed)
      fileCasePassed(observed.id, result, observed)
    })

    it('F33 MONOTONI: lyckad äldre fil backar inte ett aktuellt tidigare datum', async () => {
      await db.organization.update({
        where: { id: orgId! },
        data: { paymentDataThrough: new Date(TODAY) },
      })
      const result = await importRows(format, [['2026-09-01', 'Syntetiskt uttag', -100]])
      expect(result).toMatchObject({ imported: 0, errors: [] })
      const observed = await runCron(`F33 ${format}`)
      expect(observed.through).toBe(TODAY)
      expectEffect(observed)
      fileCasePassed(observed.id, result, observed)
    })
  })

  it('F34 XLS: riktig äldre Excel-arbetsbok med felaktigt belopp spärrar datum', async () => {
    const result = await importRows('xls', [[TODAY, 'Syntetisk felrad', 'ogiltigt']])
    expectFileError(result)
    const observed = await runCron('F34 xls')
    expect(observed.through).toBeNull()
    expectPaused(observed)
    fileCasePassed(observed.id, result, observed)
  })

  function amountCasePassed(
    id: string,
    result: Awaited<ReturnType<typeof importRows>>,
    saved: Awaited<ReturnType<typeof bankRows>>,
    observed: Awaited<ReturnType<typeof runCron>>,
  ) {
    // Markören ligger efter fallets kravassertioner, inklusive lagrat värde och cron.
    console.warn(
      'BELOPP_ASSERTIONS_OK ' +
        JSON.stringify({
          test: expect.getState().currentTestName,
          id,
          result,
          saved: saved.map((row) => ({
            amount: row.amount.toFixed(2),
            balance: row.balance?.toFixed(2) ?? null,
            date: row.date.toISOString().slice(0, 10),
            status: row.status,
          })),
          through: observed.through,
          fee: observed.fee,
          events: observed.events,
          vouchers: observed.vouchers,
          queued: observed.queued,
          summary: observed.summary,
        }),
    )
  }

  describe.each(['csv', 'xlsx', 'xls'] as const)(
    'strikt belopp genom faktisk import: %s',
    (format) => {
      it.each(AMOUNT_ACCEPTANCE)(
        'B01 ACCEPTANSMATRIS: %s',
        async (name, input, expectedAmount, rejected) => {
          const result = await importRows(format, [[TODAY, 'Syntetisk matrisrad', input]])
          const expectedCount = expectedAmount === null ? 0 : 1
          expect(result).toMatchObject({
            imported: expectedCount,
            duplicates: 0,
            autoMatched: 0,
            unmatched: expectedCount,
          })
          if (rejected) expectFileError(result)
          else expect(result.errors).toEqual([])
          const saved = await bankRows()
          expect(
            saved.map((row) => ({
              amount: row.amount.toFixed(2),
              balance: row.balance?.toFixed(2) ?? null,
              description: row.description,
              date: row.date,
              status: row.status,
            })),
          ).toEqual(
            expectedAmount === null
              ? []
              : [
                  {
                    amount: expectedAmount,
                    balance: null,
                    description: 'Syntetisk matrisrad',
                    date: new Date(TODAY),
                    status: 'UNMATCHED',
                  },
                ],
          )
          const observed = await runCron(`B01 ${format} ${name}`, expectedCount)
          expect(observed.through).toBe(rejected ? null : TODAY)
          if (rejected) expectPaused(observed)
          else expectEffect(observed)
          amountCasePassed(observed.id, result, saved, observed)
        },
      )

      it.each([
        ['frånvarande', undefined, null, false],
        ['tomt', '', null, false],
        ['textfel', 'ogiltigt', null, false],
        ['finit prefixtext', '123skräp', null, false],
        ['valutasuffix', '123kr', null, false],
        ['felgrupperat finit', '1 2 3', null, false],
        ['blandade separatorer', '1,234.56', null, false],
        ['NaN', 'NaN', null, false],
        ['korrekt grupperat', '1 234,56', '1234.56', false],
        ['negativt grupperat', '-1\u00a0234,56', '-1234.56', false],
        ['noll', '0', '0.00', false],
        ['hel exponent', '1e2', '100.00', false],
        ['Infinity', 'Infinity', null, true],
        ['negativ Infinity', '-Infinity', null, true],
        ['overflow', '1e309', null, true],
        ['overflowprefix', '1e309skräp', null, true],
        ['Infinityprefix', 'Infinityskräp', null, true],
        ['felgrupperat overflow', '1  e309', null, true],
        ['databasoverflow', '10000000000', null, true],
        ['avrundning över databasgräns', '9 999 999 999,995', null, true],
      ] as const)('B02 VALFRITT SALDO: %s', async (name, input, expectedBalance, blocked) => {
        const result = await importRows(
          format,
          [[TODAY, 'Syntetisk saldorad', '100', input]],
          ['Datum', 'Beskrivning', 'Belopp', 'Saldo'],
        )
        expect(result).toMatchObject({
          imported: blocked ? 0 : 1,
          duplicates: 0,
          autoMatched: 0,
          unmatched: blocked ? 0 : 1,
        })
        if (blocked) expectFileError(result)
        else expect(result.errors).toEqual([])
        const saved = await bankRows()
        expect(
          saved.map((row) => ({
            amount: row.amount.toFixed(2),
            balance: row.balance?.toFixed(2) ?? null,
          })),
        ).toEqual(blocked ? [] : [{ amount: '100.00', balance: expectedBalance }])
        const observed = await runCron(`B02 ${format} ${name}`, blocked ? 0 : 1)
        expect(observed.through).toBe(blocked ? null : TODAY)
        if (blocked) expectPaused(observed)
        else expectEffect(observed)
        amountCasePassed(observed.id, result, saved, observed)
      })

      it('B03 RÄTTAD ÅTERIMPORT: prefixfel stoppar filens datum, riktig dubblett bevarar första id', async () => {
        const good = [TODAY, 'Syntetisk bevarad betalning', '100,50']
        const first = await importRows(format, [
          good,
          ['2026-09-12', 'Syntetisk rättad betalning', '123skräp'],
        ])
        expect(first).toMatchObject({ imported: 1, duplicates: 0, unmatched: 1 })
        expectFileError(first)
        const before = await bankRows()
        expect(before.map((row) => row.amount.toFixed(2))).toEqual(['100.50'])
        const paused = await runCron(`B03 ${format} före rättning`, 1)
        expect(paused.through).toBeNull()
        expectPaused(paused)
        amountCasePassed(paused.id, first, before, paused)
        const second = await importRows(format, [
          good,
          ['2026-09-12', 'Syntetisk rättad betalning', '123,45'],
        ])
        expect(second).toMatchObject({
          imported: 1,
          duplicates: 1,
          autoMatched: 0,
          unmatched: 1,
          errors: [],
        })
        const after = await bankRows()
        expect(
          after.map((row) => ({
            description: row.description,
            amount: row.amount.toFixed(2),
            date: row.date.toISOString().slice(0, 10),
          })),
        ).toEqual([
          { description: 'Syntetisk bevarad betalning', amount: '100.50', date: TODAY },
          { description: 'Syntetisk rättad betalning', amount: '123.45', date: '2026-09-12' },
        ])
        expect(after[0]!.id).toBe(before[0]!.id)
        const observed = await runCron(`B03 ${format} efter rättning`, 2)
        expect(observed.through).toBe(TODAY)
        expectEffect(observed)
        amountCasePassed(observed.id, second, after, observed)
      })

      it.each([null, '2026-09-01', '2026-09-10'])(
        'B04 TIDIGARE DATUM: %s bevaras vid prefixfel',
        async (prior) => {
          await db.organization.update({
            where: { id: orgId! },
            data: { paymentDataThrough: prior ? new Date(prior) : null },
          })
          // Felet först: även efterföljande giltig bankrad måste behållas utan nytt datum.
          const result = await importRows(format, [
            [TODAY, 'Syntetisk prefixrad', '123skräp'],
            [TODAY, 'Syntetisk bevarad rad', '100'],
          ])
          expect(result).toMatchObject({ imported: 1, duplicates: 0, unmatched: 1 })
          expectFileError(result)
          const saved = await bankRows()
          expect(saved.map((row) => row.amount.toFixed(2))).toEqual(['100.00'])
          const observed = await runCron(`B04 ${format} ${prior}`, 1)
          expect(observed.through).toBe(prior)
          if (prior === '2026-09-10') expectEffect(observed)
          else expectPaused(observed)
          amountCasePassed(observed.id, result, saved, observed)
        },
      )

      it.each(['uttag', 'noll', 'dubblett'])(
        'B05 SALDOGRÄNS: %s med Infinity-saldo behåller befintlig väg före lagring',
        async (kind) => {
          const amount = kind === 'uttag' ? -100 : kind === 'noll' ? 0 : 100
          const description = 'Syntetisk befintlig väg'
          const seeded =
            kind === 'dubblett'
              ? await db.bankTransaction.create({
                  data: {
                    organizationId: orgId!,
                    date: new Date(TODAY),
                    description,
                    amount,
                    balance: 321.45,
                  },
                })
              : null
          const result = await importRows(
            format,
            [[TODAY, description, amount, 'Infinity']],
            ['Datum', 'Beskrivning', 'Belopp', 'Saldo'],
          )
          expect(result).toMatchObject({
            imported: 0,
            duplicates: seeded ? 1 : 0,
            autoMatched: 0,
            unmatched: 0,
            errors: [],
          })
          const saved = await bankRows()
          expect(saved.map((row) => ({ id: row.id, balance: row.balance?.toFixed(2) }))).toEqual(
            seeded ? [{ id: seeded.id, balance: '321.45' }] : [],
          )
          const observed = await runCron(`B05 ${format} ${kind}`, seeded ? 1 : 0)
          expect(observed.through).toBe(TODAY)
          expectEffect(observed)
          amountCasePassed(observed.id, result, saved, observed)
        },
      )
    },
  )

  describe.each(['xlsx', 'xls'] as const)('råa numeriska Excelceller: %s', (format) => {
    it.each([
      [
        'tusental och avrundad saldovisning',
        1234.56,
        '#,##0.00',
        '1234.56',
        4321.99,
        '#,##0',
        '4321.99',
      ],
      ['exponent och procent', 1234.56, '0.00E+00', '1234.56', 0.01234, '0%', '0.01'],
      ['binär avrundning', 1.005, '0.00', '1.00', 2.675, '0.00', '2.67'],
      ['procent och tusental', 0.01234, '0%', '0.01', 1234.56, '#,##0.00', '1234.56'],
      [
        'heltalsvisning och negativt saldo',
        123.456,
        '0',
        '123.46',
        -1234.56,
        '#,##0.00;(#,##0.00)',
        '-1234.56',
      ],
    ] as const)(
      'B06 NUMERISKA CELLER: %s',
      async (
        name,
        value,
        numberFormat,
        expectedAmount,
        balance,
        balanceFormat,
        expectedBalance,
      ) => {
        const sheet = XLSX.utils.aoa_to_sheet([
          ['Datum', 'Beskrivning', 'Belopp', 'Saldo'],
          [TODAY, 'Syntetisk råvärdesrad', value, balance],
        ])
        sheet['C2']!.z = numberFormat
        sheet['D2']!.z = balanceFormat
        const book = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(book, sheet, 'Syntetiskt')
        const buffer = XLSX.write(book, { type: 'buffer', bookType: format }) as Buffer
        // Kontrollera att arbetsboken verkligen bär avsedda numeriska cellvärden.
        const read = XLSX.read(buffer, { type: 'buffer', cellDates: true }).Sheets['Syntetiskt']!
        expect(read['C2']).toMatchObject({ t: 'n', v: value })
        expect(read['D2']).toMatchObject({ t: 'n', v: balance })
        const result = await importer.importBankStatement(buffer, 'syntetiskt.' + format, orgId!)
        expect(result).toMatchObject({ imported: 1, autoMatched: 0, unmatched: 1, errors: [] })
        const saved = await bankRows()
        expect(
          saved.map((row) => ({ amount: row.amount.toFixed(2), balance: row.balance?.toFixed(2) })),
        ).toEqual([{ amount: expectedAmount, balance: expectedBalance }])
        const observed = await runCron(`B06 ${format} ${name}`, 1)
        expect(observed.through).toBe(TODAY)
        expectEffect(observed)
        amountCasePassed(observed.id, result, saved, observed)
      },
    )

    it('B07 EXCEL-MAPPNING: offset, heltalsrubrik, blankrad och andra blad ändrar inte datum/radurval', async () => {
      const sheet = XLSX.utils.aoa_to_sheet([])
      XLSX.utils.sheet_add_aoa(
        sheet,
        [
          ['Datum', '7', 'Beskrivning', 'Belopp', 'Saldo', 'Referens'],
          [new Date('2026-09-12T00:00:00Z'), 'decoy', 'Syntetisk A', 1234.56, 4321.99, 'ref-A'],
          [],
          [new Date('2026-09-13T00:00:00Z'), 'decoy', 'Syntetisk B', 2345.67, 5432.98, 'ref-B'],
        ],
        { origin: 'C3', cellDates: true },
      )
      // sheet_add_aoa på ett tomt blad behåller annars A1 i !ref. Fixturen avser C3.
      sheet['!ref'] = 'C3:H6'
      for (const addr of ['C4', 'C6']) sheet[addr]!.z = 'yyyy-mm-dd'
      for (const addr of ['F4', 'F6']) sheet[addr]!.z = '#,##0.00'
      for (const addr of ['G4', 'G6']) sheet[addr]!.z = '0.00E+00'
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Första')
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['Datum', 'Beskrivning', 'Belopp'],
          [TODAY, 'Ska inte väljas', '123skräp'],
        ]),
        'Andra',
      )
      const result = await importer.importBankStatement(
        XLSX.write(book, { type: 'buffer', bookType: format }) as Buffer,
        'offset.' + format,
        orgId!,
      )
      expect(result).toMatchObject({
        imported: 2,
        duplicates: 0,
        autoMatched: 0,
        unmatched: 2,
        errors: [],
      })
      const saved = await bankRows()
      expect(
        saved.map((row) => ({
          amount: row.amount.toFixed(2),
          balance: row.balance?.toFixed(2),
          date: row.date.toISOString().slice(0, 10),
          description: row.description,
          reference: row.reference,
        })),
      ).toEqual([
        {
          amount: '1234.56',
          balance: '4321.99',
          date: '2026-09-12',
          description: 'Syntetisk A',
          reference: 'ref-A',
        },
        {
          amount: '2345.67',
          balance: '5432.98',
          date: TODAY,
          description: 'Syntetisk B',
          reference: 'ref-B',
        },
      ])
      const observed = await runCron(`B07 ${format}`, 2)
      expect(observed.through).toBe(TODAY)
      expectEffect(observed)
      amountCasePassed(observed.id, result, saved, observed)
    })

    it('B08 TEXTCELL: inre radbrytning avvisas som en hel ogiltig token', async () => {
      const result = await importRows(format, [[TODAY, 'Syntetisk flerradscell', '12\n34']])
      expect(result.imported).toBe(0)
      expectFileError(result)
      const saved = await bankRows()
      expect(saved).toHaveLength(0)
      const observed = await runCron(`B08 ${format}`)
      expect(observed.through).toBeNull()
      expectPaused(observed)
      amountCasePassed(observed.id, result, saved, observed)
    })
  })

  it.each([
    ['citerat flerradsbelopp', '"12\n34"', true],
    ['ensidigt inledande citat', '"123', true],
    ['ensidigt avslutande citat', '123"', true],
    ['helt citatpar', '"123,45"', false],
  ] as const)('B09 CSV-CITAT: %s', async (name, input, rejected) => {
    const result = await importRows('csv', [[TODAY, 'Syntetisk citerad rad', input]])
    expect(result.imported).toBe(rejected ? 0 : 1)
    if (rejected) expectFileError(result, input.includes('\n') ? 2 : 1)
    else expect(result.errors).toEqual([])
    const saved = await bankRows()
    expect(saved.map((row) => row.amount.toFixed(2))).toEqual(rejected ? [] : ['123.45'])
    const observed = await runCron(`B09 ${name}`, rejected ? 0 : 1)
    expect(observed.through).toBe(rejected ? null : TODAY)
    if (rejected) expectPaused(observed)
    else expectEffect(observed)
    amountCasePassed(observed.id, result, saved, observed)
  })

  it('B10 CSV-SALDO: tidigare ensidig quote-strip av Infinity behåller lagringsspärren', async () => {
    const result = await importRows(
      'csv',
      [[TODAY, 'Syntetisk citerad saldorad', '100', '"Infinity']],
      ['Datum', 'Beskrivning', 'Belopp', 'Saldo'],
    )
    expect(result.imported).toBe(0)
    expectFileError(result)
    const saved = await bankRows()
    expect(saved).toHaveLength(0)
    const observed = await runCron('B10 csv')
    expect(observed.through).toBeNull()
    expectPaused(observed)
    amountCasePassed(observed.id, result, saved, observed)
  })

  describe.each(['csv', 'xlsx', 'xls'] as const)(
    'saldo och befintlig lagringsprecision: %s',
    (format) => {
      it.each([
        '10000000000skräp',
        '-10000000000skräp',
        '9999999999.995skräp',
        '-9999999999.995skräp',
        '10000 000000skräp',
      ])(
        'B11 FINIT OVERFLOWPREFIX: %s får inte bli utelämnat saldo och frigöra datum',
        async (input) => {
          const result = await importRows(
            format,
            [[TODAY, 'Syntetisk overflowrad', '100', input]],
            ['Datum', 'Beskrivning', 'Belopp', 'Saldo'],
          )
          const saved = await bankRows()
          const observed = await runCron(`B11 ${format} ${input}`, saved.length)
          console.warn(
            'BELOPP_OVERFLOW_OBSERVATION ' +
              JSON.stringify({
                format,
                input,
                imported: result.imported,
                rows: saved.length,
                through: observed.through,
                fee: observed.fee,
              }),
          )
          expect(saved).toHaveLength(0)
          expect(result.imported).toBe(0)
          expectFileError(result)
          expect(observed.through).toBeNull()
          expectPaused(observed)
          amountCasePassed(observed.id, result, saved, observed)
        },
      )
    },
  )

  it.each(['xlsx', 'xls'] as const)(
    'B12 NUMERISKT SALDO: %s med rått saldo över databasprecision får inte döljas av visningsformat',
    async (format) => {
      const sheet = XLSX.utils.aoa_to_sheet([
        ['Datum', 'Beskrivning', 'Belopp', 'Saldo'],
        [TODAY, 'Syntetisk numerisk overflowrad', 100, 10000000000],
      ])
      sheet['D2']!.z = '#,##0'
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Syntetiskt')
      const result = await importer.importBankStatement(
        XLSX.write(book, { type: 'buffer', bookType: format }) as Buffer,
        'overflow.' + format,
        orgId!,
      )
      expect(result.imported).toBe(0)
      expectFileError(result)
      const saved = await bankRows()
      expect(saved).toHaveLength(0)
      const observed = await runCron(`B12 ${format}`)
      expect(observed.through).toBeNull()
      expectPaused(observed)
      amountCasePassed(observed.id, result, saved, observed)
    },
  )

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
