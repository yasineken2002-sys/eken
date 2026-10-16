import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BankTransaction, RentNotice, RentNoticePayment, RentNoticeSend } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { AccountingService, bankPaymentSourceId } from '../accounting/accounting.service'
import { rentNoticeOcrComponents } from '../avisering/rent-debt.service'
import { NoticeDispatchSnapshotSchema, noticeRecipientHash } from '../avisering/notice-dispatch'
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

/** En återbetalning förbrukar saldo en gång, även medan bankbesked/bokföring väntar. */
export function customerCreditAvailableAmount(credit: {
  amount: Prisma.Decimal
  applications: ReadonlyArray<{ amount: Prisma.Decimal }>
  refunds: ReadonlyArray<{ amount: Prisma.Decimal; state: string }>
}): Prisma.Decimal {
  const afterApplications = credit.applications.reduce(
    (available, application) => available.minus(application.amount),
    credit.amount,
  )
  return credit.refunds.reduce(
    (available, refund) =>
      refund.state === 'CANCELLED' || refund.state === 'REJECTED'
        ? available
        : available.minus(refund.amount),
    afterApplications,
  )
}

export interface PrepareCustomerCreditNoticeInput {
  organizationId: string
  rentNoticeId: string
  /** DB-läsningar och minnesarbete enbart. Inga filer, PDF:er eller nätverksanrop i transaktionen. */
  buildSnapshot: (tx: Prisma.TransactionClient) => Promise<{
    snapshot: Prisma.InputJsonValue
    toHash: string
  }>
}

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
        bank.rawOcr,
        bank.reference,
        bank.description,
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
 * Bankimporten kan ta emot ett entydigt överbelopp bakom en avstängd policy.
 * Automatisk användning och en beständig utskicksreservation bokförs i samma
 * transaktion. Tillgodo är redan mottagna pengar, inte ny intäkt.
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

  /** Bara kandidatur. Konton och policy kontrolleras igen inne i betalningens transaktion. */
  async isReceiptEnabled(organizationId: string): Promise<boolean> {
    const policy = await this.prisma.customerCreditPolicy.findUnique({
      where: { organizationId },
      select: { enabled: true },
    })
    return policy?.enabled === true
  }

  /** Callern håller bankradens lås; en vanlig avmatchning kan inte rätta en tillgodoskuld. */
  async assertBankCanBeUnmatchedInTransaction(
    input: { organizationId: string; bankTransactionId: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if ('$transaction' in tx)
      throw new ConflictException('Avmatchning kräver en betalningstransaktion')
    const credit = await tx.customerCredit.findFirst({
      where: {
        organizationId: input.organizationId,
        sourceBankTransactionId: input.bankTransactionId,
      },
      select: { id: true },
    })
    if (credit) {
      throw new ConflictException(
        'Bankbetalningen har skapat kundtillgodo och måste rättas tillsammans med tillgodot',
      )
    }
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

  /**
   * Gemensam låsordning för återbetalning och aviavräkning. Nya effekter ska
   * redan ha passerat färskhetsgrinden; återläsning av ett bankfaktum ska inte
   * tappas bara för att den grinden senare stängts. Callern äger transaktionen.
   */
  async lockRefundCreditInTransaction(
    input: { organizationId: string; creditId: string },
    tx: Prisma.TransactionClient,
  ) {
    this.assertActor()
    if ('$transaction' in tx)
      throw new ConflictException('Återbetalning kräver en betalningstransaktion')
    const [settings] = await tx.$queryRaw<
      Array<{ isolation: string }>
    >`SELECT current_setting('transaction_isolation') AS isolation`
    if (settings?.isolation !== 'read committed')
      throw new ConflictException('Återbetalning kräver transaktionsisoleringen Read Committed')
    const before = await tx.customerCredit.findFirst({
      where: { id: input.creditId, organizationId: input.organizationId },
      select: { leaseId: true, sourceBankTransactionId: true, sourceRentNoticeId: true },
    })
    if (!before) throw new NotFoundException('Tillgodot finns inte')
    await this.lockLease(tx, input.organizationId, before.leaseId)
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${before.sourceBankTransactionId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
    await this.lockNotices(tx, input.organizationId, [before.sourceRentNoticeId])
    await tx.$queryRaw`SELECT id FROM "CustomerCredit" WHERE id = ${input.creditId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
    return tx.customerCredit.findFirstOrThrow({
      where: { id: input.creditId, organizationId: input.organizationId },
      include: {
        applications: true,
        refunds: true,
        sourceRentNotice: true,
        sourceBankTransaction: true,
        sourcePayment: true,
        lease: true,
        tenant: true,
      },
    })
  }

  /** Callern håller kreditens källås. Ingen ny kontopolicy antas av en gammal bankhändelse. */
  async assertRefundSourceInTransaction(
    input: { organizationId: string; creditId: string },
    tx: Prisma.TransactionClient,
  ): Promise<{ bankLedgerAccountId: string }> {
    if ('$transaction' in tx)
      throw new ConflictException('Återbetalning kräver en betalningstransaktion')
    const credit = await tx.customerCredit.findFirstOrThrow({
      where: { id: input.creditId, organizationId: input.organizationId },
      include: { sourceRentNotice: true, sourceBankTransaction: true, sourcePayment: true },
    })
    if (
      credit.sourceBankTransaction.organizationId !== input.organizationId ||
      credit.sourceBankTransaction.status !== 'MATCHED' ||
      credit.sourcePayment.rentNoticeId !== credit.sourceRentNoticeId ||
      credit.sourcePayment.bankTransactionId !== credit.sourceBankTransactionId ||
      sourceProof(credit.sourceBankTransaction, credit.sourceRentNotice, credit.sourcePayment) !==
        credit.sourceProofHash
    )
      throw new ConflictException('Tillgodots källunderlag har ändrats')
    await this.assertSourcePayment(tx, input.organizationId, credit.sourcePayment)
    const journal = await this.assertLiveJournal(
      tx,
      input.organizationId,
      `customer-credit-receipt:${credit.id}`,
    )
    const bankLine = journal.lines.find((line) => line.account.number === 1930)
    const liabilityLine = journal.lines.find((line) => line.accountId === credit.liabilityAccountId)
    if (
      journal.id !== credit.journalEntryId ||
      journal.lines.length !== 2 ||
      !bankLine ||
      !liabilityLine ||
      bankLine.account.organizationId !== input.organizationId ||
      liabilityLine.account.organizationId !== input.organizationId ||
      !bankLine.debit?.eq(credit.amount) ||
      !new Prisma.Decimal(bankLine.credit ?? 0).isZero() ||
      !liabilityLine.credit?.eq(credit.amount) ||
      !new Prisma.Decimal(liabilityLine.debit ?? 0).isZero()
    )
      throw new ConflictException('Tillgodots bokförda skuld stämmer inte med källunderlaget')
    return { bankLedgerAccountId: bankLine.accountId }
  }

  /** Bankhooken måste anropa detta före allokering och verifikationsnummer. */
  async lockReceiptInTransaction(
    input: { organizationId: string; bankTransactionId: string; rentNoticeId: string },
    tx: Prisma.TransactionClient,
  ) {
    this.assertActor()
    if ('$transaction' in tx)
      throw new ConflictException('Tillgodo kräver en betalningstransaktion')
    const [settings] = await tx.$queryRaw<
      Array<{ isolation: string }>
    >`SELECT current_setting('transaction_isolation') AS isolation`
    if (settings?.isolation !== 'read committed') {
      throw new ConflictException('Kundtillgodo kräver transaktionsisoleringen Read Committed')
    }
    // Importen kan vara den som återställer färskheten. Mottagningen skyddas av
    // samma orglås och gransknings-/importstopp, utan att skriva falsk färskhet.
    // Användning av tillgodot på en annan avi behåller hela färskhetsgrinden.
    await this.freshness.assertIngenOlostIdentitetsgranskning(tx, input.organizationId)
    const notice = await tx.rentNotice.findFirst({
      where: { id: input.rentNoticeId, organizationId: input.organizationId },
      select: { leaseId: true },
    })
    if (!notice) throw new NotFoundException('Hyresavin finns inte')
    await this.lockLease(tx, input.organizationId, notice.leaseId)
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${input.bankTransactionId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
    await this.lockNotices(tx, input.organizationId, [input.rentNoticeId])
    const policy = await this.policy(tx, input.organizationId)
    return { ...notice, policy }
  }

  /**
   * Anropas EFTER matchningens vanliga allokering och betalningsverifikat,
   * men INUTI samma transaktion. Callern måste först ha anropat
   * lockReceiptInTransaction, FÖRE sina allokeringar/verifikationsnummer.
   * Ett fristående efterjobb får inte reparera halva betalningar.
   * Bankimportens snäva avinummerväg är den enda produktionsanroparen.
   */
  async recordReceiptInTransaction(
    input: { organizationId: string; bankTransactionId: string; rentNoticeId: string },
    tx: Prisma.TransactionClient,
  ) {
    const before = await this.lockReceiptInTransaction(input, tx)
    const policy = before.policy
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

  findPreparedNotice(organizationId: string, rentNoticeId: string): Promise<RentNoticeSend | null> {
    return this.prisma.rentNoticeSend.findFirst({
      where: {
        dispatchKey: `customer-credit-notice:${rentNoticeId}`,
        rentNotice: { organizationId },
      },
    })
  }

  /**
   * Fryser betalningsunderlaget i samma commit som tillgodot används. PDF och
   * mejlkö körs efter commit och måste återanvända den sparade reservationen.
   * En tidigare reservation återlämnas även när avin sedan blivit PAID eller
   * policyn stängts av: ett omförsök får aldrig skapa en andra avräkning.
   */
  async prepareNoticeForSend(
    input: PrepareCustomerCreditNoticeInput,
  ): Promise<RentNoticeSend | null> {
    const dispatchKey = `customer-credit-notice:${input.rentNoticeId}`
    const existing = await this.findPreparedNotice(input.organizationId, input.rentNoticeId)
    if (existing) return existing

    const enabled = await this.prisma.customerCreditPolicy.findUnique({
      where: { organizationId: input.organizationId },
      select: { enabled: true, carryForwardEnabled: true },
    })
    if (!enabled?.enabled || !enabled.carryForwardEnabled) return null

    const before = await this.prisma.rentNotice.findFirst({
      where: { id: input.rentNoticeId, organizationId: input.organizationId },
      select: { leaseId: true, year: true, month: true, type: true, origin: true },
    })
    if (!before) throw new NotFoundException('Avi hittades inte')
    // Tillgodo kan aldrig användas mot en deposition eller importerad fordran.
    // De dokumenten fortsätter genom sitt befintliga utskicksflöde.
    if (before.type !== 'RENT' || before.origin !== 'EVENO') return null

    this.assertActor()
    return this.prisma.$transaction(async (tx) => {
      await this.freshness.assertAutomaticEffectAllowed(tx, input.organizationId)
      await this.lockLease(tx, input.organizationId, before.leaseId)
      const reserved = await tx.rentNoticeSend.findFirst({
        where: { dispatchKey, rentNotice: { organizationId: input.organizationId } },
      })
      if (reserved) return reserved

      const policy = await this.policy(tx, input.organizationId)
      if (!policy.carryForwardEnabled) {
        throw new ConflictException('Automatisk användning av kundtillgodo har stängts av')
      }
      // Avtalslåset serialiserar nya tillgodoposter. Läs om kandidaterna efter
      // låset, och lås hela mängden innan första bokföringsposten skapas.
      const candidates = await tx.customerCredit.findMany({
        where: {
          organizationId: input.organizationId,
          leaseId: before.leaseId,
          sourceRentNotice: {
            OR: [{ year: { lt: before.year } }, { year: before.year, month: { lt: before.month } }],
          },
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      })

      for (const bankId of [
        ...new Set(candidates.map((credit) => credit.sourceBankTransactionId)),
      ].sort()) {
        await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${bankId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
      }
      const earlier = await tx.rentNotice.findMany({
        where: {
          organizationId: input.organizationId,
          leaseId: before.leaseId,
          type: 'RENT',
          OR: [{ year: { lt: before.year } }, { year: before.year, month: { lt: before.month } }],
        },
        select: { id: true },
      })
      await this.lockNotices(tx, input.organizationId, [
        input.rentNoticeId,
        ...earlier.map((notice) => notice.id),
        ...candidates.map((credit) => credit.sourceRentNoticeId),
      ])
      for (const creditId of candidates.map((credit) => credit.id).sort()) {
        await tx.$queryRaw`SELECT id FROM "CustomerCredit" WHERE id = ${creditId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
      }
      // Även direkt SQL-reservation tar kreditlåset, men inte avtalslåset.
      // Räkna därför först efter samtliga kreditlås, aldrig på förläsningen.
      const credits = await tx.customerCredit.findMany({
        where: {
          organizationId: input.organizationId,
          id: { in: candidates.map((credit) => credit.id) },
        },
        include: {
          applications: { select: { amount: true } },
          refunds: { select: { amount: true, state: true } },
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      })
      const availableCredits = credits
        .map((credit) => ({ credit, available: customerCreditAvailableAmount(credit) }))
        .filter(({ available }) => available.gt(0))

      const target = await tx.rentNotice.findFirst({
        where: { id: input.rentNoticeId, organizationId: input.organizationId },
        include: debtInclude,
      })
      const earlierSend = await tx.rentNoticeSend.findFirst({
        where: {
          rentNoticeId: input.rentNoticeId,
          kind: 'NOTICE',
          rentNotice: { organizationId: input.organizationId },
        },
        select: { id: true },
      })
      if (earlierSend) {
        throw new ConflictException('Avins tidigare betalningsunderlag har redan börjat skickas')
      }
      const appliedAt = new Date()
      const civil = stockholmCivilDate(appliedAt)
      const appliedDay = new Date(Date.UTC(civil.year, civil.month - 1, civil.day))
      const hasAvailableCredit = availableCredits.length > 0
      // Ett nytt avdrag kräver fortfarande en avi före förfall. Utan saldo
      // fastställer vi bara det oförändrade beloppet, även efter förfall.
      const allowedStatuses = hasAvailableCredit
        ? ['PENDING', 'FAILED']
        : ['PENDING', 'FAILED', 'OVERDUE']
      if (
        !target ||
        target.leaseId !== before.leaseId ||
        target.year !== before.year ||
        target.month !== before.month ||
        target.type !== 'RENT' ||
        target.origin !== 'EVENO' ||
        target.isBackfill ||
        target.sentAt ||
        !allowedStatuses.includes(target.status) ||
        (hasAvailableCredit && appliedDay >= target.dueDate) ||
        target.payments.length !== 0 ||
        target.credits.length !== 0 ||
        target.paidAmount?.gt(0) ||
        target.reminderFeeAmount.gt(0) ||
        target.interestAccruedAmount.gt(0) ||
        target.interestAccruedThrough ||
        target.collectionStage !== 'NONE' ||
        target.remindedAt ||
        target.collectionReadyAt ||
        target.probableLossAt ||
        target.writtenOffAt
      ) {
        throw new ConflictException(
          'Avin är inte ett oförändrat betalningsunderlag för automatiskt tillgodo',
        )
      }
      let outstanding = debt(target)
      if (!outstanding.gt(0)) {
        throw new ConflictException('Avin saknar positiv skuld att använda tillgodot mot')
      }
      const sendId = randomUUID()
      let customerCreditAmount = new Prisma.Decimal(0)
      for (const { credit, available } of availableCredits) {
        if (!outstanding.gt(0)) break
        const amount = Prisma.Decimal.min(available, outstanding)
        await this.applyToNextNoticeInTransaction(
          {
            organizationId: input.organizationId,
            creditId: credit.id,
            rentNoticeId: input.rentNoticeId,
            requestId: `customer-credit-send:${sendId}:${credit.id}`,
            appliedAt,
            amount,
          },
          tx,
        )
        customerCreditAmount = customerCreditAmount.plus(amount)
        outstanding = outstanding.minus(amount)
      }
      const { snapshot, toHash } = await input.buildSnapshot(tx)
      const parsed = NoticeDispatchSnapshotSchema.safeParse(snapshot)
      if (
        !parsed.success ||
        toHash !== noticeRecipientHash(parsed.data.to) ||
        !customerCreditAmount.equals(parsed.data.customerCreditAmount) ||
        !outstanding.equals(parsed.data.payableAmount)
      ) {
        throw new ConflictException('Utskicket saknar ett giltigt sparat underlag')
      }
      return tx.rentNoticeSend.create({
        data: {
          id: sendId,
          rentNoticeId: target.id,
          kind: 'NOTICE',
          dispatchKey,
          snapshotVersion: 1,
          snapshot: parsed.data,
          customerCreditAmount,
          payableAmount: outstanding,
          preparedAt: appliedAt,
          toHash,
        },
      })
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }

  async applyToNextNotice(input: ApplyCustomerCreditInput) {
    this.assertActor()
    return this.prisma.$transaction(async (tx) => {
      await this.freshness.assertAutomaticEffectAllowed(tx, input.organizationId)
      const before = await tx.customerCredit.findFirst({
        where: { id: input.creditId, organizationId: input.organizationId },
      })
      if (!before) throw new NotFoundException('Tillgodot finns inte')
      await this.lockLease(tx, input.organizationId, before.leaseId)
      await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${before.sourceBankTransactionId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
      const target = await tx.rentNotice.findFirst({
        where: { id: input.rentNoticeId, organizationId: input.organizationId },
        select: { year: true, month: true },
      })
      if (!target) throw new NotFoundException('Avi hittades inte')
      const earlier = await tx.rentNotice.findMany({
        where: {
          organizationId: input.organizationId,
          leaseId: before.leaseId,
          type: 'RENT',
          OR: [{ year: { lt: target.year } }, { year: target.year, month: { lt: target.month } }],
        },
        select: { id: true },
      })
      await this.lockNotices(tx, input.organizationId, [
        before.sourceRentNoticeId,
        input.rentNoticeId,
        ...earlier.map((notice) => notice.id),
      ])
      await tx.$queryRaw`SELECT id FROM "CustomerCredit" WHERE id = ${before.id} FOR UPDATE`
      return this.applyToNextNoticeInTransaction(input, tx)
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }

  /** Callern har redan tagit samtliga lås i gemensam ordning, före första verifikatet. */
  private async applyToNextNoticeInTransaction(
    input: ApplyCustomerCreditInput,
    tx: Prisma.TransactionClient,
  ) {
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
    const reserved = await tx.rentNoticeSend.findFirst({
      where: {
        rentNoticeId: input.rentNoticeId,
        kind: 'NOTICE',
        rentNotice: { organizationId: input.organizationId },
      },
      select: { id: true },
    })
    if (reserved) {
      throw new ConflictException('Avins betalningsunderlag är redan förberett för utskick')
    }
    const policy = await this.policy(tx, input.organizationId)
    const credit = await tx.customerCredit.findUniqueOrThrow({
      where: { id: input.creditId },
      include: {
        applications: { include: { rentNotice: true } },
        refunds: { select: { amount: true, state: true, cancelledAt: true, rejectedAt: true } },
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
      target.year * 12 + target.month <= latestPeriod ||
      input.appliedAt < credit.receivedAt ||
      input.appliedAt < target.createdAt ||
      target.payments.some((payment) => payment.paidAt > input.appliedAt) ||
      target.credits.some((creditNote) => creditNote.creditedAt > input.appliedAt) ||
      credit.applications.some((application) => application.appliedAt > input.appliedAt) ||
      credit.refunds.some(
        (refund) =>
          (refund.cancelledAt && refund.cancelledAt > input.appliedAt) ||
          (refund.rejectedAt && refund.rejectedAt > input.appliedAt),
      )
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
    const targetPeriod = target.year * 12 + target.month
    if (targetPeriod !== latestPeriod + 1) {
      // Ett reserverat belopp kan ha varit otillgängligt när mellanavierna
      // skickades. Efter definitivt avslag/annullering får resten användas
      // igen, men aldrig genom att hoppa över en saknad eller obetald månad.
      const intervening = earlier.filter((notice) => {
        const period = notice.year * 12 + notice.month
        return period > latestPeriod && period < targetPeriod
      })
      const releasedRefund = credit.refunds.some(
        (refund) =>
          (refund.state === 'CANCELLED' &&
            refund.cancelledAt &&
            refund.cancelledAt <= input.appliedAt) ||
          (refund.state === 'REJECTED' &&
            refund.rejectedAt &&
            refund.rejectedAt <= input.appliedAt),
      )
      if (
        !releasedRefund ||
        new Set(intervening.map((notice) => notice.year * 12 + notice.month)).size !==
          targetPeriod - latestPeriod - 1 ||
        intervening.some(
          (notice) =>
            notice.origin !== 'EVENO' ||
            notice.tenantId !== credit.tenantId ||
            notice.status !== 'PAID' ||
            notice.createdAt > input.appliedAt ||
            notice.probableLossAt !== null ||
            notice.writtenOffAt !== null ||
            !debt(notice).eq(0),
        )
      ) {
        throw new ConflictException(
          'Frigivet tillgodo kräver slutbetalda avier för varje mellanliggande månad',
        )
      }
    }
    const available = customerCreditAvailableAmount(credit)
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
  }
}
