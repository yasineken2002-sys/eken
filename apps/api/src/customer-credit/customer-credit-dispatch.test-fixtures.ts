/** Gemensamma syntetiska Postgres-fixturer för tillgodo och aviutskick. Inga testsviter körs vid import. */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { CustomerCredit, RentNotice } from '@prisma/client'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { runWithActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import type { MailService } from '../mail/mail.service'
import { CustomerCreditService } from './customer-credit.service'

export function isIsolatedDatabase(): boolean {
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

const Decimal = Prisma.Decimal
export const NOW = new Date()
export const SOURCE_PERIOD = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1))
export const RECEIVED_AT = new Date(
  Date.UTC(SOURCE_PERIOD.getUTCFullYear(), SOURCE_PERIOD.getUTCMonth(), 25, 12),
)
export const LIABILITY_NUMBER = 2998 // Explicit testkonto, inget beslutat BAS-standardval.

export function services(prisma: PrismaService) {
  const accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
  const mail: Pick<MailService, 'sendCustomEmail'> = {
    sendCustomEmail: async () => {
      throw new Error('Testet får inte skicka e-post')
    },
  }
  const freshness = new PaymentFreshnessService(prisma, mail as MailService)
  return {
    accounting,
    credit: new CustomerCreditService(prisma, accounting, freshness),
  }
}

export interface Fixture {
  organizationId: string
  tenantId: string
  propertyId: string
  leaseId: string
  bankAccountId: string
  bankTransactionId: string
  liabilityAccountId: string
  receivedAt?: Date
  source: RentNotice
  target: RentNotice
}

export async function notice(
  prisma: PrismaService,
  input: Pick<Fixture, 'organizationId' | 'tenantId' | 'leaseId'>,
  month: number,
  amount = '1000.00',
  sourcePeriod = SOURCE_PERIOD,
) {
  const period = new Date(
    Date.UTC(sourcePeriod.getUTCFullYear(), sourcePeriod.getUTCMonth() + month - 9, 1),
  )
  return prisma.$transaction(async (tx) => {
    const row = await tx.rentNotice.create({
      data: {
        ...input,
        noticeNumber: `TEST-${randomUUID()}`,
        ocrNumber: '1234567890',
        year: period.getUTCFullYear(),
        month: period.getUTCMonth() + 1,
        amount: new Decimal(amount),
        totalAmount: new Decimal(amount),
        // Historiskt scenario: avin fanns före den syntetiska betalningsdagen.
        createdAt: period,
        dueDate: new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 2, 0, 12)),
        status: month === 9 ? 'SENT' : 'PENDING',
        ...(month === 9 ? { sentAt: sourcePeriod } : {}),
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

export async function fixture(
  prisma: PrismaService,
  options: { enabled?: boolean; carry?: boolean; targetAmount?: string; sourcePeriod?: Date } = {},
): Promise<Fixture> {
  return runWithActor('SYSTEM', async () => {
    const suffix = randomUUID()
    const sourcePeriod = options.sourcePeriod ?? SOURCE_PERIOD
    const receivedAt = new Date(
      Date.UTC(sourcePeriod.getUTCFullYear(), sourcePeriod.getUTCMonth(), 25, 12),
    )
    const org = await prisma.organization.create({
      data: {
        name: `SYNTETISKT kundtillgodo ${suffix}`,
        email: `${suffix}@example.invalid`,
        street: 'Testgatan 1',
        postalCode: '11111',
        city: 'Teststad',
        fiscalYearStartMonth: 1,
        paymentDataThrough: NOW,
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
        startDate: new Date(
          Date.UTC(sourcePeriod.getUTCFullYear(), sourcePeriod.getUTCMonth() - 1, 1),
        ),
        tenancyStartDate: new Date(
          Date.UTC(sourcePeriod.getUTCFullYear(), sourcePeriod.getUTCMonth() - 1, 1),
        ),
        status: 'ACTIVE',
      },
    })
    const scope = { organizationId: org.id, tenantId: tenant.id, leaseId: lease.id }
    const source = await notice(prisma, scope, 9, '1000.00', sourcePeriod)
    const target = await notice(prisma, scope, 10, options.targetAmount, sourcePeriod)
    const bank = await prisma.bankTransaction.create({
      data: {
        organizationId: org.id,
        bankAccountId: bankAccount.id,
        date: receivedAt,
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
      receivedAt,
      source,
      target,
    }
  })
}

/** Bygger verkligt bokförd tillgodokälla; bankimportens inkoppling provas separat. */
export async function receive(
  prisma: PrismaService,
  f: Fixture,
  options: { omitPaymentJournal?: boolean } = {},
): Promise<CustomerCredit> {
  const receivedAt = f.receivedAt ?? RECEIVED_AT
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
          paidAt: receivedAt,
          source: 'BANK_RECONCILIATION',
        },
      })
      await tx.rentNotice.update({
        where: { id: f.source.id },
        data: { status: 'PAID', paidAmount: 1000, paidAt: receivedAt },
      })
      await tx.bankTransaction.update({
        where: { id: f.bankTransactionId },
        data: { status: 'MATCHED', matchedRentNoticeId: f.source.id, matchedAt: receivedAt },
      })
      if (!options.omitPaymentJournal) {
        const entry = await s.accounting.createJournalEntryForRentNoticePayment(
          f.source,
          { id: f.bankTransactionId, date: receivedAt, amount: new Decimal('1000.00') },
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
