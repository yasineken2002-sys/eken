/**
 * Kundtillgodo mot riktig Postgres, ordinarie bokföring och skuldberäkning.
 *
 * Mottagningsgränsens förutsättning byggs uttryckligen i samma transaktion:
 * bankrad, källallokering och ordinarie betalningsverifikat. Detta är INTE ett
 * prov av bankimportens automatiska inkoppling; reconciliation är orörd.
 *
 * Varje fall har egen organisation, hyresgäst och avtal. De append-only-rader
 * som är mätningens bevis bevaras efteråt i den uttryckligt isolerade test-DB:n.
 * Ingen trigger stängs av och ingen annan kunds data lånas eller städas.
 */
import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import type { CustomerCredit, RentNotice } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { appendPeriodClosedEvent } from '../accounting/closed-period'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { computeRentDebt } from '../avisering/rent-debt.service'
import { runWithActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { HistoryService } from '../history/history.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { CustomerCreditService } from './customer-credit.service'

jest.setTimeout(30_000)

function isIsolatedDatabase(): boolean {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const local =
      url.hostname === '127.0.0.1' &&
      url.port === '56432' &&
      /^\/eveno_bank2000_credit_[a-z0-9_]+$/.test(url.pathname) &&
      process.env.ALLOW_SYNTHETIC_BANK_WRITES === '1'
    // Den befintliga CI-tjänsten är en ny lokal container för varje jobb.
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

const ISOLATED = isIsolatedDatabase()
const medDb = ISOLATED ? describe : describe.skip
const Decimal = Prisma.Decimal
const RECEIVED_AT = new Date('2026-09-25T12:00:00Z')
const APPLIED_AT = new Date('2026-10-01T12:00:00Z')
const LIABILITY_NUMBER = 2998 // Explicit testkonto, inget beslutat BAS-standardval.

function services(prisma: PrismaService) {
  const accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
  const freshness = new PaymentFreshnessService(prisma, {
    send: async () => {
      throw new Error('Testet får inte skicka e-post')
    },
  } as never)
  return {
    accounting,
    credit: new CustomerCreditService(prisma, accounting, freshness),
  }
}

interface Fixture {
  organizationId: string
  tenantId: string
  propertyId: string
  leaseId: string
  bankAccountId: string
  bankTransactionId: string
  liabilityAccountId: string
  source: RentNotice
  target: RentNotice
}

async function notice(
  prisma: PrismaService,
  input: Pick<Fixture, 'organizationId' | 'tenantId' | 'leaseId'>,
  month: number,
  amount = '1000.00',
) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.rentNotice.create({
      data: {
        ...input,
        noticeNumber: `TEST-${randomUUID()}`,
        ocrNumber: '1234567890',
        year: 2026,
        month,
        amount: new Decimal(amount),
        totalAmount: new Decimal(amount),
        // Historiskt scenario: avin fanns före den syntetiska betalningsdagen.
        createdAt: new Date(Date.UTC(2026, month - 1, 1, 0)),
        dueDate: new Date(Date.UTC(2026, month, 0, 12)),
        status: month === 9 ? 'SENT' : 'PENDING',
        ...(month === 9 ? { sentAt: new Date('2026-09-01T12:00:00Z') } : {}),
        type: 'RENT',
      },
    })
    const entry = await services(prisma).accounting.createJournalEntryForRentNotice(
      row,
      input.organizationId,
      null,
      tx,
    )
    if (!entry) throw new Error('Fixturen måste ha en verkligt bokförd fordran')
    return row
  }, PAYMENT_TX_LIMITS)
}

async function fixture(
  prisma: PrismaService,
  options: { enabled?: boolean; carry?: boolean; targetAmount?: string } = {},
): Promise<Fixture> {
  return runWithActor('SYSTEM', async () => {
    const suffix = randomUUID()
    const org = await prisma.organization.create({
      data: {
        name: `SYNTETISKT kundtillgodo ${suffix}`,
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
        number: LIABILITY_NUMBER,
        name: 'Uttryckligt valt syntetiskt skuldkonto',
        type: 'LIABILITY',
      },
    })
    const bankAccount = await prisma.bankAccount.create({
      data: { organizationId: org.id, name: `Syntetiskt konto ${suffix}` },
    })
    await prisma.customerCreditPolicy.create({
      data: {
        organizationId: org.id,
        enabled: options.enabled ?? true,
        carryForwardEnabled: options.carry ?? true,
        liabilityAccountId: liability.id,
        bankAccountId: bankAccount.id,
      },
    })
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
    const lease = await prisma.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: tenant.id,
        contractNumber: `TEST-${suffix}`,
        monthlyRent: 1000,
        depositAmount: 0,
        startDate: new Date('2026-08-01T12:00:00Z'),
        tenancyStartDate: new Date('2026-08-01T12:00:00Z'),
        status: 'ACTIVE',
      },
    })
    const scope = { organizationId: org.id, tenantId: tenant.id, leaseId: lease.id }
    const source = await notice(prisma, scope, 9)
    const target = await notice(prisma, scope, 10, options.targetAmount)
    const bank = await prisma.bankTransaction.create({
      data: {
        organizationId: org.id,
        bankAccountId: bankAccount.id,
        date: RECEIVED_AT,
        description: `SYNTETISK överbetalning ${suffix}`,
        amount: new Decimal('1025.00'),
        rawOcr: source.ocrNumber,
      },
    })
    return {
      ...scope,
      propertyId: property.id,
      bankAccountId: bankAccount.id,
      bankTransactionId: bank.id,
      liabilityAccountId: liability.id,
      source,
      target,
    }
  })
}

/** Simulerar den framtida anroparens atomiska allokeringsgräns, inte importen. */
async function receive(
  prisma: PrismaService,
  f: Fixture,
  options: { omitPaymentJournal?: boolean } = {},
): Promise<CustomerCredit> {
  return runWithActor('SYSTEM', () =>
    prisma.$transaction(async (tx) => {
      const s = services(prisma)
      await s.credit.lockReceiptInTransaction(
        {
          organizationId: f.organizationId,
          bankTransactionId: f.bankTransactionId,
          rentNoticeId: f.source.id,
        },
        tx,
      )
      const allocation = await tx.rentNoticePayment.create({
        data: {
          rentNoticeId: f.source.id,
          bankTransactionId: f.bankTransactionId,
          amount: new Decimal('1000.00'),
          paidAt: RECEIVED_AT,
          source: 'BANK_RECONCILIATION',
        },
      })
      await tx.rentNotice.update({
        where: { id: f.source.id },
        data: { status: 'PAID', paidAmount: 1000, paidAt: RECEIVED_AT },
      })
      await tx.bankTransaction.update({
        where: { id: f.bankTransactionId },
        data: { status: 'MATCHED', matchedRentNoticeId: f.source.id, matchedAt: RECEIVED_AT },
      })
      if (!options.omitPaymentJournal) {
        const entry = await s.accounting.createJournalEntryForRentNoticePayment(
          f.source,
          { id: f.bankTransactionId, date: RECEIVED_AT, amount: new Decimal('1000.00') },
          f.organizationId,
          null,
          tx,
          allocation.id,
        )
        if (!entry) throw new Error('Fixturens vanliga betalningsverifikat saknas')
      }
      return s.credit.recordReceiptInTransaction(
        {
          organizationId: f.organizationId,
          bankTransactionId: f.bankTransactionId,
          rentNoticeId: f.source.id,
        },
        tx,
      )
    }, PAYMENT_TX_LIMITS),
  )
}

function application(f: Fixture, credit: CustomerCredit, amount = '25.00') {
  return {
    organizationId: f.organizationId,
    creditId: credit.id,
    rentNoticeId: f.target.id,
    requestId: randomUUID(),
    amount: new Decimal(amount),
    appliedAt: APPLIED_AT,
  }
}

async function snapshot(prisma: PrismaService, organizationId: string) {
  const data = await Promise.all([
    prisma.customerCredit.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.customerCreditApplication.findMany({
      where: { organizationId },
      orderBy: { id: 'asc' },
    }),
    prisma.bankTransaction.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.rentNotice.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.rentNoticePayment.findMany({
      where: { rentNotice: { organizationId } },
      orderBy: { id: 'asc' },
    }),
    prisma.journalEntry.findMany({
      where: { organizationId },
      orderBy: { id: 'asc' },
      include: { lines: { orderBy: { id: 'asc' } } },
    }),
    prisma.journalEntrySequence.findMany({
      where: { organizationId },
      orderBy: [{ series: 'asc' }, { fiscalYear: 'asc' }],
    }),
  ])
  return JSON.stringify(data)
}

async function balances(prisma: PrismaService, organizationId: string) {
  const entries = await prisma.journalEntry.findMany({
    where: { organizationId },
    include: { lines: { include: { account: true } } },
  })
  const result = new Map<number, Prisma.Decimal>()
  for (const entry of entries) {
    const total = entry.lines.reduce(
      (sum, line) => sum.plus(line.debit ?? 0).minus(line.credit ?? 0),
      new Decimal(0),
    )
    expect(total.toFixed(2)).toBe('0.00')
    for (const line of entry.lines) {
      result.set(
        line.account.number,
        (result.get(line.account.number) ?? new Decimal(0))
          .plus(line.debit ?? 0)
          .minus(line.credit ?? 0),
      )
    }
  }
  return Object.fromEntries([...result].map(([number, amount]) => [number, amount.toFixed(2)]))
}

/** Två riktiga transaktioner måste vara öppna innan någon service får fortsätta. */
function transactionBarrier() {
  let entered = 0
  let release: () => void = () => undefined
  const bothEntered = new Promise<void>((resolve) => {
    release = resolve
  })
  function wrap(prisma: PrismaService): PrismaService {
    return new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver)
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: typeof PAYMENT_TX_LIMITS,
        ) =>
          target.$transaction(async (tx) => {
            entered++
            if (entered === 2) release()
            let timer: NodeJS.Timeout | undefined
            try {
              await Promise.race([
                bothEntered,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('Två transaktioner öppnades aldrig')),
                    4000,
                  )
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
            return callback(tx)
          }, options)
      },
    })
  }
  return { wrap, entered: () => entered }
}

describe('kundtillgodots databasförutsättningar', () => {
  it('KANARIEFÅGEL: endast explicit lokal syntetisk DB eller CI:s testcontainer', () => {
    expect(ISOLATED).toBe(true)
  })
})

medDb('kundtillgodo med verklig Postgres och bokföring', () => {
  let prisma: PrismaService
  const extraClients: PrismaService[] = []

  beforeAll(async () => {
    if (!ISOLATED) throw new Error('Testdatabasen är inte uttryckligen godkänd')
    prisma = new PrismaService()
    await prisma.$connect()
  })

  afterAll(async () => {
    await Promise.all(extraClients.map((client) => client.$disconnect()))
    await prisma?.$disconnect()
  })

  it('bokför 25 kr skuld och reglerar nästa avi utan att debitera bank en gång till', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    expect(credit.amount.toFixed(2)).toBe('25.00')
    expect(credit.actorKind).toBe('SYSTEM')
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '1000.00',
      [LIABILITY_NUMBER]: '-25.00',
    })
    const applied = await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(application(f, credit)),
    )
    expect(applied.actorKind).toBe('SYSTEM')
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '975.00',
      [LIABILITY_NUMBER]: '0.00',
    })
    const target = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: f.target.id },
      include: { payments: true, credits: true },
    })
    expect(target.paidAmount?.toFixed(2)).toBe('25.00')
    expect(target.payments).toHaveLength(1)
    expect(target.payments[0]).toMatchObject({
      bankTransactionId: null,
      customerCreditApplicationId: applied.id,
      source: 'CUSTOMER_CREDIT',
    })
    expect(
      computeRentDebt({
        ...target,
        allocations: target.payments.map((p) => p.amount),
        credits: target.credits.map((c) => c.amount),
      }).ocrOutstanding,
    ).toBe(975)
    expect(target.status).toBe('PENDING')
    expect(target.sentAt).toBeNull()
  })

  it('hyresgästens verkliga historik visar mottagande och användning med rätt källa och aktör', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const applied = await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(application(f, credit)),
    )
    const history = new HistoryService(prisma)
    const events = await history.forTenant(f.organizationId, f.tenantId, 'OWNER')
    const creditTables = ['CustomerCredit', 'CustomerCreditApplication']
    const creditEvents = events.filter((event) => creditTables.includes(event.source.table))
    expect(creditEvents).toHaveLength(2)
    expect(creditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'CUSTOMER_CREDIT_RECEIVED',
          at: RECEIVED_AT,
          amount: 25,
          actor: { kind: 'SYSTEM', id: null, label: null },
          source: { table: 'CustomerCredit', id: credit.id },
          subject: { kind: 'RENT_NOTICE', id: f.source.id, label: f.source.noticeNumber },
        }),
        expect.objectContaining({
          type: 'CUSTOMER_CREDIT_APPLIED',
          at: APPLIED_AT,
          amount: 25,
          actor: { kind: 'SYSTEM', id: null, label: null },
          source: { table: 'CustomerCreditApplication', id: applied.id },
          subject: { kind: 'RENT_NOTICE', id: f.target.id, label: f.target.noticeNumber },
        }),
      ]),
    )
    const neighbor = await runWithActor('SYSTEM', () =>
      prisma.tenant.create({
        data: {
          organizationId: f.organizationId,
          type: 'INDIVIDUAL',
          firstName: 'Annan syntetisk',
          lastName: 'Hyresgäst',
          email: `${randomUUID()}@example.invalid`,
        },
      }),
    )
    const neighborHistory = await history.forTenant(f.organizationId, neighbor.id, 'OWNER')
    expect(neighborHistory.filter((event) => creditTables.includes(event.source.table))).toEqual([])
    const other = await fixture(prisma)
    await expect(history.forTenant(other.organizationId, f.tenantId, 'OWNER')).rejects.toThrow()
  })

  it('mottagningsreplay återanvänder tillgodo och verifikat utan ny effekt', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    const replay = await runWithActor('SYSTEM', () =>
      prisma.$transaction(
        (tx) =>
          services(prisma).credit.recordReceiptInTransaction(
            {
              organizationId: f.organizationId,
              bankTransactionId: f.bankTransactionId,
              rentNoticeId: f.source.id,
            },
            tx,
          ),
        PAYMENT_TX_LIMITS,
      ),
    )
    expect(replay.id).toBe(credit.id)
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('saknat ordinärt betalningsverifikat rullar tillbaka hela mottagningen', async () => {
    const f = await fixture(prisma)
    const before = await snapshot(prisma, f.organizationId)
    await expect(receive(prisma, f, { omitPaymentJournal: true })).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('identisk användningsreplay bevarar alla rader och verifikationsnummer', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const input = application(f, credit)
    const first = await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(input),
    )
    const before = await snapshot(prisma, f.organizationId)
    const replay = await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(input),
    )
    expect(replay.id).toBe(first.id)
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('samma requestId med ändrat belopp avvisas utan effekt', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const input = application(f, credit)
    await runWithActor('SYSTEM', () => services(prisma).credit.applyToNextNotice(input))
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice({
          ...input,
          amount: new Decimal('24.00'),
        }),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('ändrad källbanksumma efter mottagning stoppar användning utan ny bokföring', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    await runWithActor('SYSTEM', () =>
      prisma.bankTransaction.update({
        where: { id: f.bankTransactionId },
        data: { amount: new Decimal('1050.00') },
      }),
    )
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit)),
      ),
    ).rejects.toThrow('Tillgodots källunderlag har ändrats')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('delbelopp under hela tillgängliga min-beloppet nekas, sedan fungerar hela beloppet', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit, '24.00')),
      ),
    ).rejects.toThrow('Använd hela det tillgodo som ryms på avin')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
    await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(application(f, credit)),
    )
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '975.00',
      [LIABILITY_NUMBER]: '0.00',
    })
  })

  it('två samtidiga transaktioner kan inte använda samma 25 kr två gånger', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const barrier = transactionBarrier()
    const clients = [new PrismaService(), new PrismaService()]
    extraClients.push(...clients)
    await Promise.all(clients.map((client) => client.$connect()))
    const results = await runWithActor('SYSTEM', () =>
      Promise.allSettled(
        clients.map((client) =>
          services(barrier.wrap(client)).credit.applyToNextNotice(application(f, credit)),
        ),
      ),
    )
    expect(barrier.entered()).toBe(2)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const applications = await prisma.customerCreditApplication.findMany({
      where: { creditId: credit.id },
    })
    expect(applications).toHaveLength(1)
    expect(applications[0]!.amount.toFixed(2)).toBe('25.00')
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '975.00',
      [LIABILITY_NUMBER]: '0.00',
    })
  })

  it('en annan organisation kan varken använda tillgodot eller få sin avi reglerad', async () => {
    const f = await fixture(prisma)
    const other = await fixture(prisma)
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    const otherBefore = await snapshot(prisma, other.organizationId)
    for (const input of [
      { ...application(f, credit), rentNoticeId: other.target.id },
      { ...application(other, credit) },
    ]) {
      await expect(
        runWithActor('SYSTEM', () => services(prisma).credit.applyToNextNotice(input)),
      ).rejects.toThrow()
    }
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
    expect(await snapshot(prisma, other.organizationId)).toBe(otherBefore)
  })

  it('hyresgästens andra avtal får inte använda tillgodot', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const otherTarget = await runWithActor('SYSTEM', async () => {
      const unit = await prisma.unit.create({
        data: {
          propertyId: f.propertyId,
          name: 'Andra lägenheten',
          unitNumber: '2',
          type: 'APARTMENT',
          area: 40,
          monthlyRent: 1000,
          status: 'OCCUPIED',
        },
      })
      const lease = await prisma.lease.create({
        data: {
          organizationId: f.organizationId,
          tenantId: f.tenantId,
          unitId: unit.id,
          contractNumber: `TEST-${randomUUID()}`,
          monthlyRent: 1000,
          depositAmount: 0,
          startDate: new Date('2026-08-01T12:00:00Z'),
          tenancyStartDate: new Date('2026-08-01T12:00:00Z'),
          status: 'ACTIVE',
        },
      })
      return notice(
        prisma,
        { organizationId: f.organizationId, tenantId: f.tenantId, leaseId: lease.id },
        10,
      )
    })
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice({
          ...application(f, credit),
          rentNoticeId: otherTarget.id,
        }),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('avstängd policy rullar tillbaka mottagningens allokering och bokföring', async () => {
    const f = await fixture(prisma, { enabled: false })
    const before = await snapshot(prisma, f.organizationId)
    await expect(receive(prisma, f)).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('tillgodo kan inte användas när automatisk överföring är avstängd', async () => {
    const f = await fixture(prisma, { carry: false })
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit)),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('redan skickad avi ändras inte även om status råkar vara PENDING', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    await runWithActor('SYSTEM', () =>
      prisma.rentNotice.update({
        where: { id: f.target.id },
        data: { sentAt: APPLIED_AT },
      }),
    )
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit)),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it.each(['probableLossAt', 'writtenOffAt'] as const)(
    'avi med %s får inte regleras på 1510 även om status fortfarande är PENDING',
    async (field) => {
      const f = await fixture(prisma)
      const credit = await receive(prisma, f)
      const target = await runWithActor('SYSTEM', () =>
        prisma.rentNotice.update({
          where: { id: f.target.id },
          data: { [field]: APPLIED_AT },
        }),
      )
      expect(target.status).toBe('PENDING')
      const before = await snapshot(prisma, f.organizationId)
      await expect(
        runWithActor('SYSTEM', () =>
          services(prisma).credit.applyToNextNotice(application(f, credit)),
        ),
      ).rejects.toThrow('Tillgodot kan inte användas på denna avi')
      expect(await snapshot(prisma, f.organizationId)).toBe(before)
    },
  )

  it('stängd bokföringsperiod rullar tillbaka tillämpning, betalningsrad och verifikat', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    await runWithActor('SYSTEM', () =>
      prisma.$transaction(
        (tx) =>
          appendPeriodClosedEvent(tx, {
            organizationId: f.organizationId,
            year: 2026,
            month: 10,
            summary: {},
            actorLabel: 'Syntetisk periodstängning',
          }),
        PAYMENT_TX_LIMITS,
      ),
    )
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit)),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
    expect(await balances(prisma, f.organizationId)).toMatchObject({ [LIABILITY_NUMBER]: '-25.00' })
  })

  it('databasens FK hindrar att källbetalningen tas bort under ett tillgodo', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        prisma.rentNoticePayment.delete({ where: { id: credit.sourcePaymentId } }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' })
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('databasens saldospärr stoppar direkt insättning på 26 kr och rullar tillbaka dess riktiga verifikat', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    let journalCreated = false
    await expect(
      runWithActor('SYSTEM', () =>
        prisma.$transaction(async (tx) => {
          const eventId = randomUUID()
          // Avsiktlig förbikoppling av CustomerCreditService: databasen ska själv
          // neka summan även efter att ordinarie bokföring verkligen har lyckats.
          const journal = await services(
            prisma,
          ).accounting.createJournalEntryForCustomerCreditApplication(
            {
              organizationId: f.organizationId,
              eventId,
              rentNoticeId: f.target.id,
              amount: new Decimal('26.00'),
              liabilityAccountId: f.liabilityAccountId,
              date: APPLIED_AT,
            },
            tx,
          )
          journalCreated = true
          return tx.customerCreditApplication.create({
            data: {
              id: eventId,
              organizationId: f.organizationId,
              creditId: credit.id,
              rentNoticeId: f.target.id,
              requestId: randomUUID(),
              requestHash: 'a'.repeat(64),
              journalEntryId: journal.id,
              amount: new Decimal('26.00'),
              appliedAt: APPLIED_AT,
            },
          })
        }, PAYMENT_TX_LIMITS),
      ),
    ).rejects.toThrow('CUSTOMER_CREDIT_INSUFFICIENT_BALANCE')
    expect(journalCreated).toBe(true)
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '1000.00',
      [LIABILITY_NUMBER]: '-25.00',
    })
  })

  it('databasen avvisar ändringar av både tillgodot och dess användningshistorik', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const applied = await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(application(f, credit)),
    )
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        prisma.customerCredit.update({
          where: { id: credit.id },
          data: { amount: new Decimal('26.00') },
        }),
      ),
    ).rejects.toThrow('append-only: CustomerCredit ')
    await expect(
      runWithActor('SYSTEM', () =>
        prisma.customerCreditApplication.update({
          where: { id: applied.id },
          data: { amount: new Decimal('24.00') },
        }),
      ),
    ).rejects.toThrow('append-only: CustomerCreditApplication ')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('databasen avvisar CUSTOMER_CREDIT-betalning utan länk till bokförd användning', async () => {
    const f = await fixture(prisma)
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        prisma.rentNoticePayment.create({
          data: {
            rentNoticeId: f.target.id,
            amount: new Decimal('25.00'),
            paidAt: APPLIED_AT,
            source: 'CUSTOMER_CREDIT',
          },
        }),
      ),
    ).rejects.toThrow('customer_credit_payment_source_check')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it.each([
    { label: 'avslutat', data: { status: 'TERMINATED' as const } },
    { label: 'utgånget', data: { status: 'EXPIRED' as const } },
    { label: 'aktivt men slutdatum passerat', data: { endDate: new Date('2026-09-30T00:00:00Z') } },
  ])('användning nekas när avtalet är $label', async ({ data }) => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    await runWithActor('SYSTEM', () => prisma.lease.update({ where: { id: f.leaseId }, data }))
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit)),
      ),
    ).rejects.toThrow('Tillgodot kan inte användas på denna avi')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('nästa aviperiod måste överlappa avtalet även när användningsdagen ligger före slutdatum', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    await runWithActor('SYSTEM', async () => {
      const lease = await prisma.lease.update({
        where: { id: f.leaseId },
        data: { endDate: new Date('2026-09-30T00:00:00Z') },
      })
      expect(lease.status).toBe('ACTIVE')
      await prisma.rentNotice.update({
        where: { id: f.target.id },
        data: { createdAt: new Date('2026-09-20T12:00:00Z') },
      })
    })
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice({
          ...application(f, credit),
          appliedAt: new Date('2026-09-29T12:00:00Z'),
        }),
      ),
    ).rejects.toThrow('Tillgodot kan inte användas på denna avi')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('resttillgodo får inte bakdateras före den första användningen', async () => {
    const f = await fixture(prisma, { targetAmount: '20.00' })
    const credit = await receive(prisma, f)
    await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice({
        ...application(f, credit, '20.00'),
        appliedAt: new Date('2026-11-03T12:00:00Z'),
      }),
    )
    const november = await runWithActor('SYSTEM', () =>
      notice(
        prisma,
        {
          organizationId: f.organizationId,
          tenantId: f.tenantId,
          leaseId: f.leaseId,
        },
        11,
      ),
    )
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice({
          ...application(f, credit, '5.00'),
          rentNoticeId: november.id,
          appliedAt: new Date('2026-11-02T12:00:00Z'),
        }),
      ),
    ).rejects.toThrow('Tillgodot kan inte användas på denna avi')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
    // Samma skuld och rest fungerar i kronologisk ordning.
    await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice({
        ...application(f, credit, '5.00'),
        rentNoticeId: november.id,
        appliedAt: new Date('2026-11-04T12:00:00Z'),
      }),
    )
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '995.00',
      [LIABILITY_NUMBER]: '0.00',
    })
  })

  it('framtidsdaterad betalning på målavi får inte göra tillgodot till en förtida slutreglering', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const futurePaymentAt = new Date('2026-10-02T12:00:00Z')
    await runWithActor('SYSTEM', () =>
      prisma.$transaction(async (tx) => {
        const payment = await tx.rentNoticePayment.create({
          data: {
            rentNoticeId: f.target.id,
            amount: new Decimal('990.00'),
            paidAt: futurePaymentAt,
            source: 'MANUAL',
          },
        })
        const journal = await services(
          prisma,
        ).accounting.createJournalEntryForRentNoticeManualPayment(
          f.target,
          990,
          futurePaymentAt,
          'BANK',
          f.organizationId,
          null,
          payment.id,
          tx,
        )
        if (!journal)
          throw new Error('Den framtidsdaterade betalningen måste vara verkligt bokförd')
        await tx.rentNotice.update({
          where: { id: f.target.id },
          data: { paidAmount: new Decimal('990.00') },
        })
      }, PAYMENT_TX_LIMITS),
    )
    const target = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: f.target.id },
      include: { payments: true, credits: true },
    })
    expect(target.status).toBe('PENDING')
    expect(
      computeRentDebt({
        ...target,
        allocations: target.payments.map((row) => row.amount),
        credits: target.credits.map((row) => row.amount),
      }).ocrOutstanding,
    ).toBe(10)
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit, '10.00')),
      ),
    ).rejects.toThrow('Tillgodot kan inte användas på denna avi')
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it.each(['0', '-1.00', '25.01', '0.001'])(
    'ogiltigt eller otäckt belopp %s skriver inget',
    async (amount) => {
      const f = await fixture(prisma)
      const credit = await receive(prisma, f)
      const before = await snapshot(prisma, f.organizationId)
      await expect(
        runWithActor('SYSTEM', () =>
          services(prisma).credit.applyToNextNotice(application(f, credit, amount)),
        ),
      ).rejects.toThrow()
      expect(await snapshot(prisma, f.organizationId)).toBe(before)
    },
  )

  it('tillgodo kan inte hoppa över nästa månad till en senare avi', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const later = await runWithActor('SYSTEM', () =>
      notice(
        prisma,
        {
          organizationId: f.organizationId,
          tenantId: f.tenantId,
          leaseId: f.leaseId,
        },
        11,
      ),
    )
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice({
          ...application(f, credit),
          rentNoticeId: later.id,
        }),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
  })

  it('användningen begränsas av avins aktuella skuld, inte bara tillgodots belopp', async () => {
    const f = await fixture(prisma, { targetAmount: '20.00' })
    const credit = await receive(prisma, f)
    const before = await snapshot(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice(application(f, credit)),
      ),
    ).rejects.toThrow()
    expect(await snapshot(prisma, f.organizationId)).toBe(before)
    await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice(application(f, credit, '20.00')),
    )
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '0.00',
      [LIABILITY_NUMBER]: '-5.00',
    })
    const november = await runWithActor('SYSTEM', () =>
      notice(
        prisma,
        {
          organizationId: f.organizationId,
          tenantId: f.tenantId,
          leaseId: f.leaseId,
        },
        11,
      ),
    )
    await runWithActor('SYSTEM', () =>
      services(prisma).credit.applyToNextNotice({
        ...application(f, credit, '5.00'),
        rentNoticeId: november.id,
        appliedAt: new Date('2026-11-01T12:00:00Z'),
      }),
    )
    expect(await balances(prisma, f.organizationId)).toMatchObject({
      1930: '1025.00',
      1510: '995.00',
      [LIABILITY_NUMBER]: '0.00',
    })
    const applications = await prisma.customerCreditApplication.findMany({
      where: { creditId: credit.id },
      orderBy: { appliedAt: 'asc' },
    })
    expect(applications.map((row) => row.amount.toFixed(2))).toEqual(['20.00', '5.00'])
  })
})
