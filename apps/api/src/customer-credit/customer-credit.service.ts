import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BankTransaction, RentNotice, RentNoticePayment } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { AccountingService, bankPaymentSourceId } from '../accounting/accounting.service'
import { rentNoticeOcrComponents } from '../avisering/rent-debt.service'
import { currentActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { stockholmCivilDate } from '../common/time/stockholm-period'
import {
  PaymentFreshnessService,
  paymentFreshnessTransactionOptions,
} from '../payment-freshness/payment-freshness.service'

const debtInclude = { payments: true, credits: true } as const
type Notice = Prisma.RentNoticeGetPayload<{ include: typeof debtInclude }>

export interface ApplyCustomerCreditInput {
  organizationId: string
  creditId: string
  rentNoticeId: string
  requestId: string
  amount: Prisma.Decimal
  appliedAt: Date
}

function positiveMoney(amount: Prisma.Decimal): void {
  if (
    !amount.isFinite() ||
    amount.lte(0) ||
    amount.decimalPlaces() > 2 ||
    amount.gt('99999999.99')
  ) {
    throw new BadRequestException('Tillgodobeloppet måste vara positivt och anges i hela ören')
  }
}

function debt(notice: Notice): Prisma.Decimal {
  return rentNoticeOcrComponents({
    ...notice,
    credits: notice.credits.map((credit) => credit.amount),
  })
    .net.plus(notice.interestAccruedAmount)
    .minus(
      notice.payments.reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0)),
    )
}

function sourceProof(
  bank: BankTransaction,
  notice: RentNotice,
  payment: RentNoticePayment,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        bank.id,
        bank.organizationId,
        bank.amount.toFixed(2),
        bank.date.toISOString(),
        bank.bankAccountId,
        bank.matchedRentNoticeId,
        notice.id,
        notice.organizationId,
        notice.tenantId,
        notice.leaseId,
        notice.year,
        notice.month,
        notice.type,
        notice.origin,
        payment.id,
        payment.rentNoticeId,
        payment.bankTransactionId,
        payment.amount.toFixed(2),
        payment.paidAt.toISOString(),
        payment.source,
      ]),
    )
    .digest('hex')
}

/**
 * Förberedande kärna, ännu inte registrerad i en produktionsmodul eller route.
 * Bankimportens matchbeslut och atomisk utskicksreservation måste kopplas in
 * innan den får aktiveras. Tillgodo är redan mottagna pengar, inte ny intäkt.
 *
 * Låsordning: färskhets-/granskningslås → avtalets tillgodolås → bankrad →
 * avier i id-ordning → tillgodo → verifikationsnummer. Samma bank-/avilås
 * används av befintliga betalnings- och rättelsevägar.
 */
@Injectable()
export class CustomerCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly freshness: PaymentFreshnessService,
  ) {}

  private assertActor(): void {
    if (!currentActor()) throw new ConflictException('Kundtillgodo kräver känd aktörskontext')
  }

  private async lockLease(tx: Prisma.TransactionClient, organizationId: string, leaseId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-credit:${organizationId}:${leaseId}`}, 0))`
    // Befintligt avtalsavslut använder radlåset, inte vårt advisory-lås.
    await tx.$queryRaw`SELECT id FROM "Lease" WHERE id = ${leaseId} AND "organizationId" = ${organizationId} FOR UPDATE`
  }

  private async lockNotices(tx: Prisma.TransactionClient, organizationId: string, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
    }
  }

  private async policy(tx: Prisma.TransactionClient, organizationId: string) {
    const policy = await tx.customerCreditPolicy.findUnique({
      where: { organizationId },
      include: { liabilityAccount: true, bankAccount: true },
    })
    if (
      !policy?.enabled ||
      policy.liabilityAccount.organizationId !== organizationId ||
      policy.liabilityAccount.type !== 'LIABILITY' ||
      !policy.liabilityAccount.isActive ||
      policy.bankAccount.organizationId !== organizationId ||
      !policy.bankAccount.isActive
    )
      throw new ConflictException('Kundtillgodo saknar aktiv, granskad kontokonfiguration')
    return policy
  }

  private async assertLiveJournal(
    tx: Prisma.TransactionClient,
    organizationId: string,
    sourceId: string,
  ) {
    const journal = await tx.journalEntry.findFirst({
      where: { organizationId, source: 'PAYMENT', sourceId },
      include: { reversedBy: { select: { id: true } }, lines: { include: { account: true } } },
    })
    if (!journal || journal.reversedBy) {
      throw new ConflictException('Tillgodots källbetalning saknar giltig bokföring')
    }
    return journal
  }

  private async assertSourcePayment(
    tx: Prisma.TransactionClient,
    organizationId: string,
    payment: RentNoticePayment,
  ) {
    const journal = await this.assertLiveJournal(
      tx,
      organizationId,
      bankPaymentSourceId('rent-notice', payment.id),
    )
    const bankLine = journal.lines.find((line) => line.account.number === 1930)
    const debtLine = journal.lines.find((line) => line.account.number === 1510)
    if (
      journal.lines.length !== 2 ||
      !bankLine ||
      !debtLine ||
      bankLine.account.organizationId !== organizationId ||
      debtLine.account.organizationId !== organizationId ||
      !bankLine.debit?.eq(payment.amount) ||
      !new Prisma.Decimal(bankLine.credit ?? 0).isZero() ||
      !debtLine.credit?.eq(payment.amount) ||
      !new Prisma.Decimal(debtLine.debit ?? 0).isZero()
    ) {
      throw new ConflictException(
        'Källbetalningens bokförda belopp stämmer inte med bankallokeringen',
      )
    }
  }

  /** Bankhooken måste anropa detta före allokering och verifikationsnummer. */
  async lockReceiptInTransaction(
    input: { organizationId: string; bankTransactionId: string; rentNoticeId: string },
    tx: Prisma.TransactionClient,
  ) {
    this.assertActor()
    if ('$transaction' in tx)
      throw new ConflictException('Tillgodo kräver en betalningstransaktion')
    await this.freshness.assertAutomaticEffectAllowed(tx, input.organizationId)
    const notice = await tx.rentNotice.findFirst({
      where: { id: input.rentNoticeId, organizationId: input.organizationId },
      select: { leaseId: true },
    })
    if (!notice) throw new NotFoundException('Hyresavin finns inte')
    await this.lockLease(tx, input.organizationId, notice.leaseId)
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${input.bankTransactionId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
    await this.lockNotices(tx, input.organizationId, [input.rentNoticeId])
    return notice
  }

  /**
   * Anropas EFTER matchningens vanliga allokering och betalningsverifikat,
   * men INUTI samma transaktion. Callern måste först ha anropat
   * lockReceiptInTransaction, FÖRE sina allokeringar/verifikationsnummer.
   * Ett fristående efterjobb får inte reparera halva betalningar.
   * Ingen caller finns i bankimporten i denna förberedande etapp.
   */
  async recordReceiptInTransaction(
    input: { organizationId: string; bankTransactionId: string; rentNoticeId: string },
    tx: Prisma.TransactionClient,
  ) {
    const before = await this.lockReceiptInTransaction(input, tx)
    const policy = await this.policy(tx, input.organizationId)
    const bank = await tx.bankTransaction.findFirst({
      where: { id: input.bankTransactionId, organizationId: input.organizationId },
      include: { rentNoticePayments: true, invoicePayment: true },
    })
    const notice = await tx.rentNotice.findFirst({
      where: { id: input.rentNoticeId, organizationId: input.organizationId },
      include: debtInclude,
    })
    if (
      !bank ||
      !notice ||
      notice.leaseId !== before.leaseId ||
      notice.type !== 'RENT' ||
      notice.origin !== 'EVENO' ||
      notice.probableLossAt ||
      notice.writtenOffAt ||
      notice.status !== 'PAID' ||
      !debt(notice).isZero() ||
      bank.status !== 'MATCHED' ||
      bank.matchedRentNoticeId !== notice.id ||
      bank.invoiceId ||
      bank.invoicePayment ||
      bank.identityReviewAt ||
      bank.autoMatchExcludedAt ||
      bank.bankAccountId !== policy.bankAccountId ||
      bank.rentNoticePayments.length !== 1
    )
      throw new ConflictException('Överbetalningen saknar entydig, reglerad källavi')
    const payment = bank.rentNoticePayments[0]!
    if (
      payment.rentNoticeId !== notice.id ||
      payment.source !== 'BANK_RECONCILIATION' ||
      payment.amount.lte(0)
    ) {
      throw new ConflictException('Tillgodot kräver en källbunden bankallokering')
    }
    await this.assertSourcePayment(tx, input.organizationId, payment)
    const amount = bank.amount.minus(payment.amount)
    positiveMoney(amount)
    const sourceProofHash = sourceProof(bank, notice, payment)
    const existing = await tx.customerCredit.findUnique({
      where: { sourceBankTransactionId: bank.id },
    })
    if (existing) {
      if (
        existing.sourceRentNoticeId !== notice.id ||
        existing.sourcePaymentId !== payment.id ||
        !existing.amount.eq(amount) ||
        existing.sourceProofHash !== sourceProofHash
      ) {
        throw new ConflictException('Tillgodots tidigare underlag skiljer sig från bankbetalningen')
      }
      await this.assertLiveJournal(
        tx,
        input.organizationId,
        `customer-credit-receipt:${existing.id}`,
      )
      return existing
    }
    const id = randomUUID()
    const journal = await this.accounting.createJournalEntryForCustomerCreditReceipt(
      {
        organizationId: input.organizationId,
        eventId: id,
        bankTransactionId: bank.id,
        rentNoticeId: notice.id,
        amount,
        liabilityAccountId: policy.liabilityAccountId,
        date: bank.date,
      },
      tx,
    )
    return tx.customerCredit.create({
      data: {
        id,
        organizationId: input.organizationId,
        tenantId: notice.tenantId,
        leaseId: notice.leaseId,
        sourceRentNoticeId: notice.id,
        sourceBankTransactionId: bank.id,
        sourcePaymentId: payment.id,
        liabilityAccountId: policy.liabilityAccountId,
        journalEntryId: journal.id,
        amount,
        sourceProofHash,
        receivedAt: bank.date,
      },
    })
  }

  async applyToNextNotice(input: ApplyCustomerCreditInput) {
    this.assertActor()
    positiveMoney(input.amount)
    if (
      !input.requestId.trim() ||
      input.requestId.length > 200 ||
      !Number.isFinite(input.appliedAt.getTime())
    ) {
      throw new BadRequestException('Tillgodo kräver en giltig anropsnyckel och tidpunkt')
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.organizationId,
          input.creditId,
          input.rentNoticeId,
          input.amount.toFixed(2),
          input.appliedAt.toISOString(),
        ]),
      )
      .digest('hex')
    return this.prisma.$transaction(async (tx) => {
      await this.freshness.assertAutomaticEffectAllowed(tx, input.organizationId)
      const before = await tx.customerCredit.findFirst({
        where: { id: input.creditId, organizationId: input.organizationId },
      })
      if (!before) throw new NotFoundException('Tillgodot finns inte')
      await this.lockLease(tx, input.organizationId, before.leaseId)
      await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${before.sourceBankTransactionId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
      await this.lockNotices(tx, input.organizationId, [
        before.sourceRentNoticeId,
        input.rentNoticeId,
      ])
      await tx.$queryRaw`SELECT id FROM "CustomerCredit" WHERE id = ${before.id} FOR UPDATE`
      const existing = await tx.customerCreditApplication.findUnique({
        where: {
          organizationId_requestId: {
            organizationId: input.organizationId,
            requestId: input.requestId,
          },
        },
      })
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictException('Anropsnyckeln har redan använts med annat innehåll')
        await this.assertLiveJournal(
          tx,
          input.organizationId,
          `customer-credit-application:${existing.id}`,
        )
        return existing
      }
      const policy = await this.policy(tx, input.organizationId)
      const credit = await tx.customerCredit.findUniqueOrThrow({
        where: { id: before.id },
        include: {
          applications: { include: { rentNotice: true } },
          sourceRentNotice: true,
          sourceBankTransaction: true,
          sourcePayment: true,
          lease: true,
        },
      })
      const target = await tx.rentNotice.findFirst({
        where: { id: input.rentNoticeId, organizationId: input.organizationId },
        include: debtInclude,
      })
      const latestPeriod = credit.applications.reduce(
        (period, application) =>
          Math.max(period, application.rentNotice.year * 12 + application.rentNotice.month),
        credit.sourceRentNotice.year * 12 + credit.sourceRentNotice.month,
      )
      const civil = stockholmCivilDate(input.appliedAt)
      const appliedDay = new Date(Date.UTC(civil.year, civil.month - 1, civil.day))
      if (
        !policy.carryForwardEnabled ||
        policy.liabilityAccountId !== credit.liabilityAccountId ||
        policy.bankAccountId !== credit.sourceBankTransaction.bankAccountId ||
        credit.sourceBankTransaction.status !== 'MATCHED' ||
        credit.sourceBankTransaction.identityReviewAt ||
        credit.sourceBankTransaction.autoMatchExcludedAt ||
        credit.lease.status !== 'ACTIVE' ||
        credit.lease.tenantId !== credit.tenantId ||
        credit.lease.organizationId !== input.organizationId ||
        (credit.lease.endDate && appliedDay > credit.lease.endDate) ||
        !target ||
        (credit.lease.endDate &&
          new Date(Date.UTC(target.year, target.month - 1, 1)) > credit.lease.endDate) ||
        new Date(Date.UTC(target.year, target.month, 0)) < credit.lease.startDate ||
        target.type !== 'RENT' ||
        target.origin !== 'EVENO' ||
        target.probableLossAt ||
        target.writtenOffAt ||
        target.leaseId !== credit.leaseId ||
        target.tenantId !== credit.tenantId ||
        target.sentAt ||
        !['PENDING', 'FAILED'].includes(target.status) ||
        target.year * 12 + target.month !== latestPeriod + 1 ||
        input.appliedAt < credit.receivedAt ||
        input.appliedAt < target.createdAt ||
        target.payments.some((payment) => payment.paidAt > input.appliedAt) ||
        target.credits.some((creditNote) => creditNote.creditedAt > input.appliedAt) ||
        credit.applications.some((application) => application.appliedAt > input.appliedAt)
      )
        throw new ConflictException('Tillgodot kan inte användas på denna avi')
      if (
        sourceProof(credit.sourceBankTransaction, credit.sourceRentNotice, credit.sourcePayment) !==
        credit.sourceProofHash
      ) {
        throw new ConflictException('Tillgodots källunderlag har ändrats')
      }
      await this.assertSourcePayment(tx, input.organizationId, credit.sourcePayment)
      await this.assertLiveJournal(tx, input.organizationId, `customer-credit-receipt:${credit.id}`)
      const earlier = await tx.rentNotice.findMany({
        where: {
          organizationId: input.organizationId,
          leaseId: credit.leaseId,
          type: 'RENT',
          status: { not: 'CANCELLED' },
          OR: [{ year: { lt: target.year } }, { year: target.year, month: { lt: target.month } }],
        },
        include: debtInclude,
      })
      if (
        earlier.some(
          (notice) =>
            debt(notice).gt(0) ||
            notice.payments.some((payment) => payment.paidAt > input.appliedAt) ||
            notice.credits.some((creditNote) => creditNote.creditedAt > input.appliedAt),
        )
      ) {
        throw new ConflictException('Tidigare skuld måste utredas före tillgodo på nästa avi')
      }
      const available = credit.applications.reduce(
        (sum, application) => sum.minus(application.amount),
        credit.amount,
      )
      const outstanding = debt(target)
      if (input.amount.gt(available) || input.amount.gt(outstanding)) {
        throw new ConflictException('Beloppet överstiger tillgängligt tillgodo eller avins skuld')
      }
      if (!input.amount.eq(Prisma.Decimal.min(available, outstanding))) {
        throw new ConflictException('Använd hela det tillgodo som ryms på avin')
      }
      const id = randomUUID()
      const journal = await this.accounting.createJournalEntryForCustomerCreditApplication(
        {
          organizationId: input.organizationId,
          eventId: id,
          rentNoticeId: target.id,
          amount: input.amount,
          liabilityAccountId: credit.liabilityAccountId,
          date: input.appliedAt,
        },
        tx,
      )
      const application = await tx.customerCreditApplication.create({
        data: {
          id,
          organizationId: input.organizationId,
          creditId: credit.id,
          rentNoticeId: target.id,
          requestId: input.requestId,
          requestHash,
          amount: input.amount,
          appliedAt: input.appliedAt,
          journalEntryId: journal.id,
        },
      })
      await tx.rentNoticePayment.create({
        data: {
          rentNoticeId: target.id,
          amount: input.amount,
          paidAt: input.appliedAt,
          source: 'CUSTOMER_CREDIT',
          customerCreditApplicationId: application.id,
        },
      })
      const paidAmount = target.payments.reduce(
        (sum, payment) => sum.plus(payment.amount),
        input.amount,
      )
      await tx.rentNotice.update({
        where: { id: target.id },
        data: {
          paidAmount,
          ...(outstanding.eq(input.amount) ? { status: 'PAID', paidAt: input.appliedAt } : {}),
        },
      })
      return application
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }
}
