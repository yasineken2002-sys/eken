/**
 * Riktig CSV-import → bankrad → allokering → bokföring → kundtillgodo.
 *
 * Inga allokeringar för importbetalningen seedas. Parser, kontogräns,
 * importförsök, färskhets-/granskningslås och bokföring är riktiga tjänster.
 * Endast filtransport, mejl och skuggkö ersätts; inga bank- eller modell-API
 * anropas. Rollback-provet injicerar ett fel EFTER en riktig kreditinsättning.
 * Varje fall äger nya syntetiska organisationer som bevaras efter körningen.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { RentNotice } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { PaymentOutcomeService } from '../ai/shadow/payment/payment-outcome.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { runWithActor } from '../common/actor/actor.context'
import { OcrService } from '../common/ocr/ocr.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { CustomerCreditService } from '../customer-credit/customer-credit.service'
import type { MailService } from '../mail/mail.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { BankAccountService } from './bank-account.service'
import { BankImportAttemptService } from './bank-import-attempt.service'
import { ReconciliationController } from './reconciliation.controller'
import { ReconciliationService } from './reconciliation.service'

jest.setTimeout(30_000)

function isolatedDatabase(): boolean {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const local =
      url.hostname === '127.0.0.1' &&
      url.port === '56432' &&
      /^\/eveno_bank2000_credit_[a-z0-9_]+$/.test(url.pathname) &&
      process.env.ALLOW_SYNTHETIC_BANK_WRITES === '1'
    const ci =
      process.env.GITHUB_ACTIONS === 'true' &&
      url.hostname === 'localhost' &&
      url.port === '5432' &&
      url.pathname === '/eken_dev'
    return url.protocol === 'postgresql:' && (local || ci)
  } catch {
    return false
  }
}

const ISOLATED = isolatedDatabase()
const medDb = ISOLATED ? describe : describe.skip
const Decimal = Prisma.Decimal
const LIABILITY = 2998 // Explicit syntetiskt konto; inget nytt BAS-standardval.

function unused(name: string): never {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`${name} får inte anropas`)
      },
    },
  ) as never
}

function services(prisma: PrismaService) {
  const accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
  const mailCalls: unknown[][] = []
  const mail = {
    sendCustomEmail: async (...args: Parameters<MailService['sendCustomEmail']>) => {
      mailCalls.push(args)
      return 'syntetiskt-mejl'
    },
  } satisfies Pick<MailService, 'sendCustomEmail'>
  const freshness = new PaymentFreshnessService(prisma, mail as MailService)
  const shadowJobs: unknown[] = []
  const credit = new CustomerCreditService(prisma, accounting, freshness)
  const recon = new ReconciliationService(
    prisma,
    unused('fakturatjänsten'),
    unused('fakturahändelser'),
    accounting,
    freshness,
    new RentNoticeEventsService(prisma),
    {
      enqueue: async (job: unknown) => {
        shadowJobs.push(job)
        return 'syntetiskt-jobb'
      },
    } as never,
    new PaymentOutcomeService(prisma),
    new BankImportAttemptService(prisma),
    credit,
  )
  const controller = new ReconciliationController(
    recon,
    unused('PDF-import'),
    new BankAccountService(prisma),
  )
  return { accounting, credit, recon, controller, freshness, shadowJobs, mailCalls }
}

type Rig = ReturnType<typeof services>
interface Fixture {
  organizationId: string
  tenantId: string
  leaseId: string
  bankAccountId: string
  liabilityAccountId: string
  ocr: string
  source: RentNotice
  neighbors: RentNotice[]
}

async function notice(
  prisma: PrismaService,
  scope: Pick<Fixture, 'organizationId' | 'tenantId' | 'leaseId' | 'ocr'>,
  month: number,
  amount: string,
) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.rentNotice.create({
      data: {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        leaseId: scope.leaseId,
        noticeNumber: `AVI-2026-${String(month).padStart(2, '0')}-0001`,
        ocrNumber: scope.ocr,
        year: 2026,
        month,
        type: 'RENT',
        amount: new Decimal(amount),
        totalAmount: new Decimal(amount),
        status: month > 9 ? 'PENDING' : 'SENT',
        ...(month <= 9 ? { sentAt: new Date(Date.UTC(2026, month - 1, 1)) } : {}),
        createdAt: new Date(Date.UTC(2026, month - 1, 1)),
        dueDate: new Date(Date.UTC(2026, month, 0)),
      },
    })
    const journal = await services(prisma).accounting.createJournalEntryForRentNotice(
      row,
      scope.organizationId,
      null,
      tx,
    )
    if (!journal) throw new Error('Fixturens hyresfordran måste vara bokförd')
    return row
  }, PAYMENT_TX_LIMITS)
}

async function fixture(
  prisma: PrismaService,
  options: { enabled?: boolean; neighbors?: boolean; withPolicy?: boolean } = {},
): Promise<Fixture> {
  return runWithActor('SYSTEM', async () => {
    const suffix = randomUUID()
    const org = await prisma.organization.create({
      data: {
        name: `SYNTETISK kreditimport ${suffix}`,
        email: `${suffix}@example.invalid`,
        street: 'Testgatan 1',
        postalCode: '11111',
        city: 'Teststad',
        fiscalYearStartMonth: 1,
      },
    })
    await services(prisma).accounting.seedDefaultAccounts(org.id)
    const liability = await prisma.account.create({
      data: {
        organizationId: org.id,
        number: LIABILITY,
        name: 'Syntetiskt valt skuldkonto',
        type: 'LIABILITY',
      },
    })
    const bank = await new BankAccountService(prisma).create(org.id, {
      name: `Testkonto ${suffix}`,
    })
    if (options.withPolicy !== false) {
      await prisma.customerCreditPolicy.create({
        data: {
          organizationId: org.id,
          enabled: options.enabled ?? true,
          carryForwardEnabled: true,
          liabilityAccountId: liability.id,
          bankAccountId: bank.id,
        },
      })
    }
    const property = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: 'Testfastighet',
        propertyDesignation: `Test ${suffix}:1`,
        type: 'RESIDENTIAL',
        street: 'Testgatan 1',
        postalCode: '11111',
        city: 'Teststad',
        totalArea: 100,
      },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Testlägenhet',
        unitNumber: '1',
        type: 'APARTMENT',
        rooms: 2,
        area: 50,
        monthlyRent: 1000,
        status: 'OCCUPIED',
      },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Syntetisk',
        lastName: 'Hyresgäst',
        email: `tenant-${suffix}@example.invalid`,
      },
    })
    const ocr = await new OcrService(prisma).assignOcrToTenant(tenant.id, org.id)
    const lease = await prisma.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: tenant.id,
        contractNumber: `TEST-${suffix}`,
        monthlyRent: 1000,
        depositAmount: 0,
        startDate: new Date('2026-07-01T00:00:00Z'),
        tenancyStartDate: new Date('2026-07-01T00:00:00Z'),
        status: 'ACTIVE',
      },
    })
    const scope = { organizationId: org.id, tenantId: tenant.id, leaseId: lease.id, ocr }
    const source = await notice(prisma, scope, 9, '1000.00')
    const neighbors = options.neighbors
      ? [await notice(prisma, scope, 8, '900.00'), await notice(prisma, scope, 10, '1100.00')]
      : []
    return { ...scope, source, neighbors, bankAccountId: bank.id, liabilityAccountId: liability.id }
  })
}

function line(
  f: Fixture,
  options: { amount?: string; description?: string; reference?: string; date?: string } = {},
) {
  return [
    options.date ?? '2026-09-25',
    options.description ?? `Hyra ${f.source.noticeNumber}`,
    options.amount ?? '1025.00',
    options.reference ?? f.ocr,
  ].join(',')
}
function csv(...lines: string[]) {
  return Buffer.from(['Datum,Text,Belopp,Referens', ...lines].join('\n'), 'utf8')
}

function upload(rig: Rig, f: Fixture, buffer = csv(line(f)), accountId = f.bankAccountId) {
  return runWithActor('SYSTEM', () =>
    rig.controller.importStatement(
      f.organizationId,
      {
        file: async () => ({ filename: 'syntetiskt.csv', toBuffer: async () => buffer }),
      } as never,
      accountId,
    ),
  )
}

async function financialSnapshot(prisma: PrismaService, organizationId: string) {
  return JSON.stringify(
    await Promise.all([
      prisma.rentNotice.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      prisma.rentNoticePayment.findMany({
        where: { rentNotice: { organizationId } },
        orderBy: { id: 'asc' },
      }),
      prisma.rentNoticeEvent.findMany({
        where: { rentNotice: { organizationId } },
        orderBy: { id: 'asc' },
      }),
      prisma.customerCredit.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      prisma.customerCreditApplication.findMany({
        where: { organizationId },
        orderBy: { id: 'asc' },
      }),
      prisma.journalEntry.findMany({
        where: { organizationId },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { id: 'asc' } } },
      }),
      prisma.journalEntrySequence.findMany({
        where: { organizationId },
        orderBy: [{ fiscalYear: 'asc' }, { series: 'asc' }],
      }),
    ]),
  )
}

async function allMoneyAndBanks(prisma: PrismaService, organizationId: string) {
  return JSON.stringify({
    financial: await financialSnapshot(prisma, organizationId),
    banks: await prisma.bankTransaction.findMany({
      where: { organizationId },
      orderBy: { id: 'asc' },
    }),
  })
}

async function balances(prisma: PrismaService, organizationId: string) {
  const rows = await prisma.journalEntry.findMany({
    where: { organizationId },
    include: { lines: { include: { account: true } } },
  })
  const result = new Map<number, Prisma.Decimal>()
  for (const row of rows) {
    expect(
      row.lines
        .reduce((sum, l) => sum.plus(l.debit ?? 0).minus(l.credit ?? 0), new Decimal(0))
        .toFixed(2),
    ).toBe('0.00')
    for (const l of row.lines)
      result.set(
        l.account.number,
        (result.get(l.account.number) ?? new Decimal(0)).plus(l.debit ?? 0).minus(l.credit ?? 0),
      )
  }
  return Object.fromEntries([...result].map(([number, amount]) => [number, amount.toFixed(2)]))
}

async function expectUnmatched(prisma: PrismaService, f: Fixture, before: string) {
  expect(await financialSnapshot(prisma, f.organizationId)).toBe(before)
  const banks = await prisma.bankTransaction.findMany({
    where: { organizationId: f.organizationId },
  })
  expect(banks).toHaveLength(1)
  expect(banks[0]).toMatchObject({ status: 'UNMATCHED', matchedRentNoticeId: null })
  expect(await prisma.customerCredit.count({ where: { organizationId: f.organizationId } })).toBe(0)
}

function barrier() {
  let entered = 0
  let release: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered: () => entered,
    wait: async () => {
      entered++
      if (entered === 2) release()
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Båda importer nådde inte barriären')), 5000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

describe('kundtillgodots bankimportförutsättningar', () => {
  it('KANARIEFÅGEL: uttryckligt lokal syntetisk DB eller CI:s testcontainer', () => {
    expect(ISOLATED).toBe(true)
  })
})

medDb('kundtillgodo genom riktig CSV-import', () => {
  let prisma: PrismaService
  const extraClients: PrismaService[] = []
  beforeAll(async () => {
    prisma = new PrismaService()
    await prisma.$connect()
  })
  afterAll(async () => {
    await Promise.all(extraClients.map((p) => p.$disconnect()))
    await prisma?.$disconnect()
  })

  it('första importen reglerar uttrycklig avi och bokför 25 kr tillgodo utan att röra äldre eller senare avi', async () => {
    const f = await fixture(prisma, { neighbors: true })
    const rig = services(prisma)
    const orgBefore = await prisma.organization.findUniqueOrThrow({
      where: { id: f.organizationId },
    })
    expect(orgBefore.paymentImportStartedAt).toBeNull()
    expect(orgBefore.paymentDataThrough).toBeNull()
    const result = await upload(rig, f)
    expect(result).toMatchObject({
      imported: 1,
      autoMatched: 1,
      unmatched: 0,
      errors: [],
      forsok: { status: 'KLAR', replayed: false },
    })
    const bank = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: f.organizationId },
    })
    const credit = await prisma.customerCredit.findFirstOrThrow({
      where: { organizationId: f.organizationId },
    })
    const payments = await prisma.rentNoticePayment.findMany({
      where: { bankTransactionId: bank.id },
    })
    expect(payments).toHaveLength(1)
    expect(payments[0]!.amount.toFixed(2)).toBe('1000.00')
    expect(payments[0]!.rentNoticeId).toBe(f.source.id)
    expect(credit).toMatchObject({
      sourceBankTransactionId: bank.id,
      sourcePaymentId: payments[0]!.id,
      sourceRentNoticeId: f.source.id,
      actorKind: 'SYSTEM',
    })
    expect(credit.amount.toFixed(2)).toBe('25.00')
    expect(bank.status).toBe('MATCHED')
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.source.id } })).status).toBe(
      'PAID',
    )
    for (const neighbor of f.neighbors)
      expect(await prisma.rentNotice.findUniqueOrThrow({ where: { id: neighbor.id } })).toEqual(
        neighbor,
      )
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '2000.00',
      [LIABILITY]: '-25.00',
    })
    const orgAfter = await prisma.organization.findUniqueOrThrow({
      where: { id: f.organizationId },
    })
    expect(orgAfter.paymentImportStartedAt).not.toBeNull()
    expect(orgAfter.paymentDataThrough).not.toBeNull()
    expect(rig.shadowJobs).toEqual([])
  })

  it('avstängd policy behåller det tidigare omatchade överbetalningsfallet', async () => {
    const f = await fixture(prisma, { enabled: false })
    const before = await financialSnapshot(prisma, f.organizationId)
    const result = await upload(services(prisma), f)
    expect(result).toMatchObject({ imported: 1, autoMatched: 0, unmatched: 1, errors: [] })
    await expectUnmatched(prisma, f, before)
  })

  it('utan någon policy är kundtillgodo avstängt som standard', async () => {
    const f = await fixture(prisma, { withPolicy: false })
    const rig = services(prisma)
    const before = await financialSnapshot(prisma, f.organizationId)
    expect(await rig.credit.isReceiptEnabled(f.organizationId)).toBe(false)
    expect(await upload(rig, f)).toMatchObject({ imported: 1, autoMatched: 0, errors: [] })
    await expectUnmatched(prisma, f, before)
    expect(
      await prisma.customerCreditPolicy.findUnique({ where: { organizationId: f.organizationId } }),
    ).toBeNull()
  })

  it('ett annat aktivt konto i rätt organisation får inte ta emot policyns tillgodo', async () => {
    const f = await fixture(prisma)
    const otherAccount = await runWithActor('SYSTEM', () =>
      new BankAccountService(prisma).create(f.organizationId, {
        name: 'Annat syntetiskt bankkonto',
      }),
    )
    const before = await financialSnapshot(prisma, f.organizationId)
    expect(await upload(services(prisma), f, csv(line(f)), otherAccount.id)).toMatchObject({
      imported: 1,
      autoMatched: 0,
      unmatched: 1,
      errors: [],
    })
    await expectUnmatched(prisma, f, before)
    expect(
      await prisma.bankTransaction.findFirstOrThrow({
        where: { organizationId: f.organizationId },
      }),
    ).toMatchObject({ bankAccountId: otherAccount.id })
  })

  it('uttrycklig avi utan angivet OCR och historisk skuld öppnar G2-paus utan att allokera', async () => {
    const f = await fixture(prisma)
    const rig = services(prisma)
    // Bara den redan befintliga historiska fordran seedas. Importens bankrad,
    // granskningsmarkering och paus skapas genom den riktiga importvägen.
    await runWithActor('SYSTEM', () =>
      prisma.rentNotice.create({
        data: {
          organizationId: f.organizationId,
          tenantId: f.tenantId,
          leaseId: f.leaseId,
          noticeNumber: 'HISTORISK-2026-08-0001',
          ocrNumber: f.ocr,
          year: 2026,
          month: 8,
          type: 'RENT',
          origin: 'OPENING_PACKAGE',
          status: 'OPENING',
          amount: 500,
          totalAmount: 500,
          dueDate: new Date('2026-08-31T00:00:00Z'),
        },
      }),
    )
    const before = await financialSnapshot(prisma, f.organizationId)
    expect(await upload(rig, f, csv(line(f, { reference: '' })))).toMatchObject({
      imported: 1,
      autoMatched: 0,
      errors: [],
    })
    await expectUnmatched(prisma, f, before)
    const bank = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: f.organizationId },
    })
    // Befintlig prosakontroll godtar årtalet 2026 som OCR. Det är inte
    // hyresgästens identitet; avisökningen måste ändå hitta den historiska skulden.
    expect(bank.rawOcr).toBe('2026')
    expect(bank.rawOcr).not.toBe(f.ocr)
    expect(bank.identityReviewAt).not.toBeNull()
    expect(bank.identityReviewReason).toBe('HISTORISK_SKULD_FORE_BRYTDATUM')
    expect(await rig.freshness.pausorsaker(f.organizationId)).toEqual({
      identitetsgranskning: 1,
      importstopp: 0,
    })
    await expect(
      prisma.$transaction((tx) =>
        rig.freshness.assertIngenOlostIdentitetsgranskning(tx, f.organizationId),
      ),
    ).rejects.toMatchObject({ code: 'GRANSKNING_PAGAR' })
  })

  it('olöst G2 på en annan bankrad blockerar en i övrigt entydig överbetalning', async () => {
    const f = await fixture(prisma)
    const rig = services(prisma)
    const review = await runWithActor('SYSTEM', () =>
      prisma.$transaction(async (tx) => {
        await rig.freshness.lasOrdningForOlostGranskning(tx, f.organizationId)
        const row = await tx.bankTransaction.create({
          data: {
            organizationId: f.organizationId,
            bankAccountId: f.bankAccountId,
            date: new Date('2026-09-24T00:00:00Z'),
            description: 'Syntetisk tidigare betalning med oklar identitet',
            amount: 12,
            status: 'UNMATCHED',
            identityReviewAt: new Date('2026-09-24T00:00:00Z'),
            identityReviewReason: 'HISTORIK_UTAN_KONTO',
          },
        })
        await rig.freshness.oppnaGranskningsperiod(tx, f.organizationId)
        return row
      }, PAYMENT_TX_LIMITS),
    )
    const before = await financialSnapshot(prisma, f.organizationId)
    const result = await upload(rig, f)
    expect(result.autoMatched).toBe(0)
    expect(result.errors.join(' ')).toContain('identitetsgranskning')
    expect(await financialSnapshot(prisma, f.organizationId)).toBe(before)
    expect(await prisma.bankTransaction.findUniqueOrThrow({ where: { id: review.id } })).toEqual(
      review,
    )
    const imported = await prisma.bankTransaction.findMany({
      where: { organizationId: f.organizationId, id: { not: review.id } },
    })
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ status: 'UNMATCHED', matchedRentNoticeId: null })
  })

  it('ett olöst importstopp blockerar mottagning trots rätt avi, OCR och konto', async () => {
    const f = await fixture(prisma)
    const rig = services(prisma)
    const stop = await runWithActor('SYSTEM', () =>
      prisma.$transaction(async (tx) => {
        await rig.freshness.lasOrdningForOlostGranskning(tx, f.organizationId)
        return tx.bankImportStop.create({
          data: {
            organizationId: f.organizationId,
            bankAccountId: f.bankAccountId,
            kind: 'BGMAX',
            fileName: 'tidigare-syntetisk.txt',
            contentHash: randomUUID(),
            scope: 'BETALARE',
            reasonCode: 'AVDRAG_BETALARE',
            message: 'Syntetiskt olöst bankimportstopp',
            stopKey: randomUUID(),
          },
        })
      }, PAYMENT_TX_LIMITS),
    )
    const before = await financialSnapshot(prisma, f.organizationId)
    const result = await upload(rig, f)
    expect(result.autoMatched).toBe(0)
    expect(result.errors.join(' ')).toContain('importstopp är olöst')
    await expectUnmatched(prisma, f, before)
    expect(await prisma.bankImportStop.findUniqueOrThrow({ where: { id: stop.id } })).toEqual(stop)
  })

  it('samma fil spelas upp utan ytterligare allokering, tillgodo eller verifikat', async () => {
    const f = await fixture(prisma)
    const rig = services(prisma)
    const file = csv(line(f))
    await upload(rig, f, file)
    const before = await allMoneyAndBanks(prisma, f.organizationId)
    const replay = await upload(rig, f, file)
    expect(replay.forsok).toMatchObject({ replayed: true, status: 'KLAR' })
    expect(await allMoneyAndBanks(prisma, f.organizationId)).toBe(before)
    expect(
      await prisma.bankImportAttempt.count({ where: { organizationId: f.organizationId } }),
    ).toBe(1)
  })

  it('samma betalningsrad i en överlappande fil ger inget andra tillgodo', async () => {
    const f = await fixture(prisma)
    const rig = services(prisma)
    await upload(rig, f, csv(line(f)))
    const before = await allMoneyAndBanks(prisma, f.organizationId)
    const result = await upload(rig, f, csv(line(f), '2026-09-25,Kontrollrad,0.00,'))
    expect(result).toMatchObject({
      duplicates: 1,
      imported: 0,
      autoMatched: 0,
      errors: [],
      forsok: { replayed: false },
    })
    expect(await allMoneyAndBanks(prisma, f.organizationId)).toBe(before)
  })

  it('två importer som når filanspråket samtidigt ger exakt en bokförd betalning', async () => {
    const f = await fixture(prisma)
    const sync = barrier()
    const clients = [new PrismaService(), new PrismaService()]
    extraClients.push(...clients)
    await Promise.all(clients.map((p) => p.$connect()))
    const rigs = clients.map((p) =>
      services(
        p.$extends({
          query: {
            bankImportAttempt: {
              async create({ args, query }) {
                await sync.wait()
                return query(args)
              },
            },
          },
        }) as unknown as PrismaService,
      ),
    )
    const results = await Promise.allSettled(rigs.map((rig) => upload(rig, f)))
    expect(sync.entered()).toBe(2)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { status: 409 } })
    expect(
      await prisma.bankTransaction.count({ where: { organizationId: f.organizationId } }),
    ).toBe(1)
    expect(await prisma.customerCredit.count({ where: { organizationId: f.organizationId } })).toBe(
      1,
    )
    expect(await prisma.rentNoticePayment.count({ where: { rentNoticeId: f.source.id } })).toBe(1)
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '0.00',
      [LIABILITY]: '-25.00',
    })
  })

  it('olika filer och betalningar som når samma avis lås samtidigt kan bara reglera den en gång', async () => {
    const f = await fixture(prisma)
    const sync = barrier()
    const clients = [new PrismaService(), new PrismaService()]
    extraClients.push(...clients)
    await Promise.all(clients.map((p) => p.$connect()))
    const rigs = clients.map((p) => services(p))
    const spies = rigs.map((rig) => {
      const lock = rig.credit.lockReceiptInTransaction.bind(rig.credit)
      let firstCall = true
      return jest
        .spyOn(rig.credit, 'lockReceiptInTransaction')
        .mockImplementation(async (...args) => {
          // Båda riktiga betalningstransaktionerna måste nå fram innan någon
          // tar org-/avtalslåset. recordReceipt återtar låset utan en ny barriär.
          if (firstCall) {
            firstCall = false
            await sync.wait()
          }
          return lock(...args)
        })
    })
    try {
      const results = await Promise.all([
        upload(rigs[0]!, f, csv(line(f, { date: '2026-09-25' }))),
        upload(rigs[1]!, f, csv(line(f, { date: '2026-09-26' }))),
      ])
      expect(sync.entered()).toBe(2)
      for (const result of results) {
        expect(result).toMatchObject({ imported: 1, duplicates: 0, errors: [] })
      }
      expect(results.map((result) => result.autoMatched).sort()).toEqual([0, 1])
      const banks = await prisma.bankTransaction.findMany({
        where: { organizationId: f.organizationId },
      })
      expect(banks).toHaveLength(2)
      expect(banks.map((bank) => bank.status).sort()).toEqual(['MATCHED', 'UNMATCHED'])
      const matched = banks.find((bank) => bank.status === 'MATCHED')!
      const credits = await prisma.customerCredit.findMany({
        where: { organizationId: f.organizationId },
      })
      expect(credits).toHaveLength(1)
      expect(credits[0]).toMatchObject({ sourceBankTransactionId: matched.id })
      expect(credits[0]!.amount.toFixed(2)).toBe('25.00')
      const payments = await prisma.rentNoticePayment.findMany({
        where: { rentNoticeId: f.source.id },
      })
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({ bankTransactionId: matched.id })
      expect(payments[0]!.amount.toFixed(2)).toBe('1000.00')
      // En vanlig betalningsjournal och en tillgodojournal, utöver fordran.
      expect(
        await prisma.journalEntry.count({
          where: { organizationId: f.organizationId, source: 'PAYMENT' },
        }),
      ).toBe(2)
      expect(await balances(prisma, f.organizationId)).toMatchObject({
        1930: '1025.00',
        1510: '0.00',
        [LIABILITY]: '-25.00',
      })
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })

  it('en redan betald uttrycklig avi leder inte nästa betalning vidare till andra öppna avier', async () => {
    const f = await fixture(prisma, { neighbors: true })
    const rig = services(prisma)
    await upload(rig, f)
    const before = await financialSnapshot(prisma, f.organizationId)
    const second = await upload(rig, f, csv(line(f, { date: '2026-09-26' })))
    expect(second.autoMatched).toBe(0)
    expect(await financialSnapshot(prisma, f.organizationId)).toBe(before)
    const banks = await prisma.bankTransaction.findMany({
      where: { organizationId: f.organizationId },
    })
    expect(banks.map((bank) => bank.status).sort()).toEqual(['MATCHED', 'UNMATCHED'])
  })

  it('OCR för en annan hyresgäst får inte överridas av ett uttryckligt avinummer', async () => {
    const f = await fixture(prisma, { neighbors: true })
    const otherOcr = await runWithActor('SYSTEM', async () => {
      const other = await prisma.tenant.create({
        data: {
          organizationId: f.organizationId,
          type: 'INDIVIDUAL',
          email: `${randomUUID()}@example.invalid`,
        },
      })
      return new OcrService(prisma).assignOcrToTenant(other.id, f.organizationId)
    })
    const before = await financialSnapshot(prisma, f.organizationId)
    const result = await upload(services(prisma), f, csv(line(f, { reference: otherOcr })))
    expect(result.autoMatched).toBe(0)
    await expectUnmatched(prisma, f, before)
  })

  it('två olika avinummer i samma betalning stoppar fallback och vattenfall', async () => {
    const f = await fixture(prisma, { neighbors: true })
    const before = await financialSnapshot(prisma, f.organizationId)
    const result = await upload(
      services(prisma),
      f,
      csv(
        line(f, {
          description: `Hyra ${f.source.noticeNumber} och ${f.neighbors[0]!.noticeNumber}`,
        }),
      ),
    )
    expect(result.autoMatched).toBe(0)
    await expectUnmatched(prisma, f, before)
  })

  it('AVI i CSV-referensen bevarar extraherat årtals-OCR och stoppar motstridig identitet', async () => {
    const f = await fixture(prisma)
    const before = await financialSnapshot(prisma, f.organizationId)
    const result = await upload(
      services(prisma),
      f,
      csv(line(f, { description: 'Hyra', reference: f.source.noticeNumber })),
    )
    expect(result).toMatchObject({ imported: 1, autoMatched: 0, errors: [] })
    await expectUnmatched(prisma, f, before)
    expect(
      await prisma.bankTransaction.findFirstOrThrow({
        where: { organizationId: f.organizationId },
      }),
    ).toMatchObject({ rawOcr: '2026', reference: f.source.noticeNumber })
  })

  it('samma avinummer och OCR i två organisationer bokför endast i importens organisation', async () => {
    const f = await fixture(prisma)
    const other = await fixture(prisma)
    expect(other.ocr).toBe(f.ocr)
    expect(other.source.noticeNumber).toBe(f.source.noticeNumber)
    const before = await allMoneyAndBanks(prisma, other.organizationId)
    expect((await upload(services(prisma), f)).autoMatched).toBe(1)
    expect(await allMoneyAndBanks(prisma, other.organizationId)).toBe(before)
    const credit = await prisma.customerCredit.findFirstOrThrow({
      where: { organizationId: f.organizationId },
    })
    expect(credit.tenantId).toBe(f.tenantId)
  })

  it('controllerns riktiga kontogräns avvisar en annan organisations bankkonto', async () => {
    const f = await fixture(prisma)
    const other = await fixture(prisma)
    const before = await allMoneyAndBanks(prisma, f.organizationId)
    const otherBefore = await allMoneyAndBanks(prisma, other.organizationId)
    await expect(
      upload(services(prisma), f, csv(line(f)), other.bankAccountId),
    ).rejects.toMatchObject({ status: 404 })
    expect(await allMoneyAndBanks(prisma, f.organizationId)).toBe(before)
    expect(await allMoneyAndBanks(prisma, other.organizationId)).toBe(otherBefore)
    expect(
      await prisma.bankImportAttempt.count({ where: { organizationId: f.organizationId } }),
    ).toBe(0)
  })

  it('OCR utan uttrycklig avi behåller det befintliga vattenfallet', async () => {
    const f = await fixture(prisma)
    const next = await runWithActor('SYSTEM', () => notice(prisma, f, 10, '1000.00'))
    expect(
      (await upload(services(prisma), f, csv(line(f, { description: 'Hyra' })))).autoMatched,
    ).toBe(1)
    const payments = await prisma.rentNoticePayment.findMany({
      where: { rentNotice: { organizationId: f.organizationId } },
      orderBy: { amount: 'desc' },
    })
    expect(payments.map((p) => [p.rentNoticeId, p.amount.toFixed(2)])).toEqual([
      [f.source.id, '1000.00'],
      [next.id, '25.00'],
    ])
    expect(await prisma.customerCredit.count({ where: { organizationId: f.organizationId } })).toBe(
      0,
    )
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '975.00',
    })
  })

  it('nytt tillgodo börjar över 1 kr; befintlig tolerans på exakt 1 kr behålls', async () => {
    for (const [amount, creditAmount] of [
      ['1001.00', null],
      ['1001.01', '1.01'],
    ] as const) {
      const f = await fixture(prisma)
      expect((await upload(services(prisma), f, csv(line(f, { amount })))).autoMatched).toBe(1)
      const credits = await prisma.customerCredit.findMany({
        where: { organizationId: f.organizationId },
      })
      expect(credits.map((credit) => credit.amount.toFixed(2))).toEqual(
        creditAmount ? [creditAmount] : [],
      )
      const accounts = await balances(prisma, f.organizationId)
      expect(accounts[1510]).toBe('0.00')
      expect(accounts[1930]).toBe(creditAmount ? '1001.01' : '1000.00')
    }
  })

  it.each(['interestAccruedAmount', 'probableLossAt', 'writtenOffAt'] as const)(
    'uttrycklig överbetalning med %s lämnas orörd',
    async (field) => {
      const f = await fixture(prisma, { neighbors: true })
      await runWithActor('SYSTEM', () =>
        prisma.rentNotice.update({
          where: { id: f.source.id },
          data: {
            [field]:
              field === 'interestAccruedAmount'
                ? new Decimal('5.00')
                : new Date('2026-09-20T00:00:00Z'),
          },
        }),
      )
      const before = await financialSnapshot(prisma, f.organizationId)
      expect((await upload(services(prisma), f)).autoMatched).toBe(0)
      await expectUnmatched(prisma, f, before)
    },
  )

  it('framtida 990 kr får inte göra en äldre import på 35 kr till full betalning och 25 kr tillgodo', async () => {
    const f = await fixture(prisma)
    await runWithActor('SYSTEM', () =>
      prisma.$transaction(async (tx) => {
        const paidAt = new Date('2026-09-26T00:00:00Z')
        const payment = await tx.rentNoticePayment.create({
          data: { rentNoticeId: f.source.id, amount: 990, paidAt, source: 'MANUAL' },
        })
        const journal = await services(
          prisma,
        ).accounting.createJournalEntryForRentNoticeManualPayment(
          f.source,
          990,
          paidAt,
          'BANK',
          f.organizationId,
          null,
          payment.id,
          tx,
        )
        if (!journal) throw new Error('Framtidsbetalningen måste vara verkligt bokförd')
        await tx.rentNotice.update({ where: { id: f.source.id }, data: { paidAmount: 990 } })
      }, PAYMENT_TX_LIMITS),
    )
    const before = await financialSnapshot(prisma, f.organizationId)
    expect((await upload(services(prisma), f, csv(line(f, { amount: '35.00' })))).autoMatched).toBe(
      0,
    )
    await expectUnmatched(prisma, f, before)
  })

  it('fel efter riktig tillgodoinsättning rullar tillbaka både vanliga betalningen och tillgodot', async () => {
    const f = await fixture(prisma)
    const before = await financialSnapshot(prisma, f.organizationId)
    let inserted = false
    const failing = prisma.$extends({
      query: {
        customerCredit: {
          async create({ args, query }) {
            await query(args) // Båda verkliga journalerna och den nya raden finns nu i samma transaktion.
            inserted = true
            throw new Error('SYNTETISKT_AVBROTT_EFTER_TILLGODO')
          },
        },
      },
    }) as unknown as PrismaService
    const result = await upload(services(failing), f)
    expect(inserted).toBe(true)
    expect(result.autoMatched).toBe(0)
    expect(result.errors.join(' ')).toContain('SYNTETISKT_AVBROTT_EFTER_TILLGODO')
    expect(result.forsok?.status).toBe('DELVIS')
    await expectUnmatched(prisma, f, before)
  })

  it('avmatchning av en bankrad med tillgodo ger begriplig 409 utan delvis reversering', async () => {
    const f = await fixture(prisma)
    const rig = services(prisma)
    await upload(rig, f)
    const bank = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: f.organizationId },
    })
    const before = await allMoneyAndBanks(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        rig.recon.unmatchTransaction(bank.id, f.organizationId, null, 'Syntetiskt rättelseförsök'),
      ),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/tillgodo/i) })
    expect(await allMoneyAndBanks(prisma, f.organizationId)).toBe(before)
  })
})
