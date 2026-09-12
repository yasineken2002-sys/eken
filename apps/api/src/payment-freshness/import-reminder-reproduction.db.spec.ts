/**
 * Mäter verklig import -> verifierad täckning -> cron -> avgift/event i PostgreSQL.
 * Kan inte bevisa att hyresgästen betalat i banken eller att ett mejl levererats.
 * F02-F05 är AVSIKTLIGT RÖDA säkerhetsregressioner på den frysta produktkoden.
 * F01 beskriver nuläget; NULL är inte bevis för ett medvetet manuellt läge.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentDebtService } from '../avisering/rent-debt.service'
import { RentInterestService } from '../avisering/rent-interest.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { RentReminderService } from '../avisering/rent-reminder.service'
import { BankConsentCryptoService } from '../psd2/bank-consent-crypto.service'
import { Psd2SyncService } from '../psd2/psd2-sync.service'
import type { BankDataProvider } from '../psd2/psd2.types'
import { BankStatementImportService } from '../reconciliation/bank-statement-import.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { PaymentFreshnessService } from './payment-freshness.service'

const NOW = new Date('2026-09-13T12:00:00.000Z')
const TODAY = '2026-09-13'
const CSV_BAD = Buffer.from('Datum;Beskrivning;Belopp\nogiltigt;Syntetisk rad;100\n')
const CSV_WITHDRAWAL = Buffer.from('Datum;Beskrivning;Belopp\n2026-09-13;Syntetiskt uttag;-100\n')
const PDF = Buffer.from('%PDF-1.4\n% syntetiskt parserunderlag\n%%EOF\n')
const tables = [
  'Organization',
  'Property',
  'Unit',
  'Tenant',
  'Lease',
  'RentNotice',
  'RentNoticeEvent',
  'RentNoticeSend',
  'JournalEntry',
  'JournalEntryLine',
  'JournalEntrySequence',
  'Account',
  'BankTransaction',
  'BankStatementImport',
  'BankConsent',
  'ReferenceInterestRate',
  'Notification',
]

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
    for (const table of tables) {
      const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        'SELECT count(*) AS n FROM "' + table + '"',
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
    const accounting = new AccountingService(
      db as never,
      new VerifikationsnummerService(db as never),
    )
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
    reminders = new RentReminderService(
      db as never,
      accounting,
      events,
      new RentInterestService(db as never, accounting, events),
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

  async function runCron(id: string) {
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
      stale: gate.stale,
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
    // Säkerhetskravet, inte en assertion som accepterar det uppmätta felet.
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

  it('F06 KANARIEFÅGEL: verkligt daterat utdrag med endast uttag ger färskhet och avgiftsverifikat', async () => {
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
    expectEffect(observed)
  })

  it('F02 SÄKERHET: första PDF-importens parserfel ska pausa automatisk avgift', async () => {
    await failedPdf()
    const observed = await runCron('F02')
    expect(observed.through).toBeNull()
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
    expectPaused(observed)
  })

  it('F04 SÄKERHET: CSV med enbart ogiltiga datum ska pausa automatisk avgift', async () => {
    const result = await importer.importBankStatement(CSV_BAD, 'fel.csv', orgId!)
    expect(result).toMatchObject({ imported: 0, errors: ['Rad 2: Ogiltigt datum'] })
    expect(await db.bankStatementImport.count({ where: { organizationId: orgId! } })).toBe(0)
    const observed = await runCron('F04')
    expect(observed.through).toBeNull()
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
    expectPaused(observed)
  })

  it('F08: ett gammalt PDF-fel får inte hindra efterföljande verifierat färskt utdrag', async () => {
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
})
