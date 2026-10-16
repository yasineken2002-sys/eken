import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { CustomerCreditRefund } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { AccountingService } from '../accounting/accounting.service'
import { currentActor } from '../common/actor/actor.context'
import { AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES } from '../common/org/automation-org-statuses'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { stockholmCivilDate } from '../common/time/stockholm-period'
import {
  PaymentFreshnessService,
  paymentFreshnessTransactionOptions,
} from '../payment-freshness/payment-freshness.service'
import {
  CUSTOMER_CREDIT_REFUND_BANK_PORT,
  CustomerCreditRefundBankObservationSchema,
  CustomerCreditRefundBankPort,
  CustomerCreditRefundDestinationSchema,
  CustomerCreditRefundInstructionSchema,
  customerCreditRefundBankProofHash,
  customerCreditRefundRejectionProofHash,
} from './customer-credit-refund-bank.port'
import type {
  CustomerCreditRefundBankObservation,
  CustomerCreditRefundDestination,
  CustomerCreditRefundInstruction,
} from './customer-credit-refund-bank.port'
import { CustomerCreditService, customerCreditAvailableAmount } from './customer-credit.service'

export interface ReserveCustomerCreditRefundInput {
  organizationId: string
  creditId: string
  requestId: string
  amount: Prisma.Decimal
}

export interface CustomerCreditRefundIdentity {
  organizationId: string
  refundId: string
}

type LockedCredit = Awaited<ReturnType<CustomerCreditService['lockRefundCreditInTransaction']>>
type EventType =
  | 'RESERVED'
  | 'SUBMITTING'
  | 'UNKNOWN'
  | 'BANK_PENDING'
  | 'BANK_NOT_FOUND'
  | 'BANK_CONFIRMED'
  | 'SETTLED'
  | 'REJECTED'
  | 'CANCELLED'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function storedJson(value: unknown): Prisma.InputJsonValue {
  // Endast redan Zod-validerade, begränsade portobjekt når denna serialisering.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

type InstructionFields = Pick<
  CustomerCreditRefund,
  | 'id'
  | 'organizationId'
  | 'creditId'
  | 'tenantId'
  | 'leaseId'
  | 'amount'
  | 'currency'
  | 'liabilityAccountId'
  | 'bankAccountId'
  | 'bankLedgerAccountId'
  | 'provider'
  | 'providerAccountRef'
  | 'recipientRef'
  | 'recipientProofHash'
  | 'recipientVerifiedAt'
  | 'recipientValidUntil'
>

function instructionHash(row: InstructionFields): string {
  return hash([
    row.id,
    row.organizationId,
    row.creditId,
    row.tenantId,
    row.leaseId,
    row.amount.toFixed(2),
    row.currency,
    row.liabilityAccountId,
    row.bankAccountId,
    row.bankLedgerAccountId,
    row.provider,
    row.providerAccountRef,
    row.recipientRef,
    row.recipientProofHash,
    row.recipientVerifiedAt.toISOString(),
    row.recipientValidUntil.toISOString(),
  ])
}

/**
 * En beständig reservation är saldosanningen även efter en processkrasch.
 * Bankporten körs UTANFÖR transaktionen. Efter första SUBMITTING får bara
 * lookup köras: frånvaro/timeout är inget tillstånd att betala en gång till.
 * BANK_CONFIRMED sparar bankens faktum; en senare transaktion bokför det och
 * sätter SETTLED. Stängd period/konto får inte rulla tillbaka bankfaktumet.
 */
@Injectable()
export class CustomerCreditRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CustomerCreditService,
    private readonly accounting: AccountingService,
    private readonly freshness: PaymentFreshnessService,
    @Inject(CUSTOMER_CREDIT_REFUND_BANK_PORT)
    private readonly bank: CustomerCreditRefundBankPort,
  ) {}

  private assertActor(): void {
    if (!currentActor() || currentActor() === 'AGENT') {
      throw new ConflictException(
        'Återbetalning kräver känd aktör; agentdelegation är inte aktiverad',
      )
    }
  }

  private validateReservation(input: ReserveCustomerCreditRefundInput): string {
    if (
      !input.organizationId.trim() ||
      !input.creditId.trim() ||
      !input.requestId.trim() ||
      input.requestId.length > 200 ||
      !input.amount.isFinite() ||
      input.amount.lte(0) ||
      input.amount.gt('99999999.99') ||
      input.amount.decimalPlaces() > 2
    ) {
      throw new BadRequestException(
        'Återbetalning kräver identitet, anropsnyckel och positivt belopp i hela ören',
      )
    }
    return hash([input.organizationId, input.creditId, input.amount.toFixed(2)])
  }

  private replay(row: CustomerCreditRefund, requestHash: string): CustomerCreditRefund {
    if (row.requestHash !== requestHash)
      throw new ConflictException('Anropsnyckeln har redan använts med annat innehåll')
    return row
  }

  private find(input: CustomerCreditRefundIdentity): Promise<CustomerCreditRefund> {
    return this.prisma.customerCreditRefund
      .findFirst({ where: { id: input.refundId, organizationId: input.organizationId } })
      .then((row) => {
        if (!row) throw new NotFoundException('Återbetalningen finns inte')
        return row
      })
  }

  private async lockOrder(
    input: CustomerCreditRefundIdentity,
    creditId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ row: CustomerCreditRefund; credit: LockedCredit }> {
    const credit = await this.credits.lockRefundCreditInTransaction(
      { organizationId: input.organizationId, creditId },
      tx,
    )
    await tx.$queryRaw`SELECT id FROM "CustomerCreditRefund" WHERE id = ${input.refundId} AND "organizationId" = ${input.organizationId} FOR UPDATE`
    const row = await tx.customerCreditRefund.findFirst({
      where: { id: input.refundId, organizationId: input.organizationId },
    })
    if (!row || row.creditId !== credit.id)
      throw new ConflictException('Återbetalningens tillgodobindning stämmer inte')
    return { row, credit }
  }

  private async configuration(
    tx: Prisma.TransactionClient,
    credit: Pick<
      LockedCredit,
      | 'organizationId'
      | 'tenantId'
      | 'leaseId'
      | 'liabilityAccountId'
      | 'sourceBankTransaction'
      | 'tenant'
      | 'lease'
    >,
  ) {
    const policy = await tx.customerCreditPolicy.findUnique({
      where: { organizationId: credit.organizationId },
      include: { liabilityAccount: true, bankAccount: true, refundBankLedgerAccount: true },
    })
    const organization = await tx.organization.findUnique({
      where: { id: credit.organizationId },
      select: { status: true },
    })
    if (
      !policy?.enabled ||
      !policy.refundEnabled ||
      !organization ||
      !AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES.some((status) => status === organization.status) ||
      credit.tenant.anonymizedAt !== null ||
      credit.tenant.organizationId !== credit.organizationId ||
      credit.lease.organizationId !== credit.organizationId ||
      credit.lease.tenantId !== credit.tenantId ||
      policy.liabilityAccountId !== credit.liabilityAccountId ||
      policy.liabilityAccount.organizationId !== credit.organizationId ||
      policy.liabilityAccount.type !== 'LIABILITY' ||
      !policy.liabilityAccount.isActive ||
      policy.bankAccountId !== credit.sourceBankTransaction.bankAccountId ||
      policy.bankAccount.organizationId !== credit.organizationId ||
      !policy.bankAccount.isActive ||
      policy.refundBankLedgerAccount?.organizationId !== credit.organizationId ||
      policy.refundBankLedgerAccount.type !== 'ASSET' ||
      !policy.refundBankLedgerAccount.isActive ||
      credit.sourceBankTransaction.identityReviewAt !== null ||
      credit.sourceBankTransaction.autoMatchExcludedAt !== null
    ) {
      throw new ConflictException(
        'Återbetalning saknar aktiv och granskad kund- och kontokonfiguration',
      )
    }
    return { policy, bankLedgerAccountId: policy.refundBankLedgerAccount.id }
  }

  private async event(
    tx: Prisma.TransactionClient,
    row: CustomerCreditRefund,
    type: EventType,
    at: Date,
    observationHash?: string,
    reasonCode?: string,
  ): Promise<void> {
    await tx.customerCreditRefundEvent.create({
      data: {
        organizationId: row.organizationId,
        refundId: row.id,
        type,
        occurredAt: at,
        ...(observationHash ? { observationHash } : {}),
        ...(reasonCode ? { reasonCode } : {}),
      },
    })
  }

  /** Endast porten kan lämna mottagarunderlag; caller anger aldrig bankkonto/verified:true. */
  async reserveRefund(input: ReserveCustomerCreditRefundInput): Promise<CustomerCreditRefund> {
    this.assertActor()
    const requestHash = this.validateReservation(input)
    const requestWhere = {
      organizationId_requestId: {
        organizationId: input.organizationId,
        requestId: input.requestId,
      },
    }
    const existing = await this.prisma.customerCreditRefund.findUnique({
      where: { ...requestWhere, organizationId: input.organizationId },
    })
    if (existing) return this.replay(existing, requestHash)

    const before = await this.prisma.customerCredit.findFirst({
      where: { id: input.creditId, organizationId: input.organizationId },
      include: { sourceBankTransaction: true, tenant: true, lease: true },
    })
    if (!before) throw new NotFoundException('Tillgodot finns inte')
    const preparedConfig = await this.configuration(this.prisma, before)
    let destination: CustomerCreditRefundDestination
    try {
      destination = CustomerCreditRefundDestinationSchema.parse(
        await this.bank.prepareDestination({
          organizationId: input.organizationId,
          tenantId: before.tenantId,
          bankAccountId: preparedConfig.policy.bankAccountId,
        }),
      )
    } catch {
      // Bankfel kan bära konton/PII i message/cause. Ingen sådan text passerar portgränsen.
      throw new ServiceUnavailableException('CUSTOMER_CREDIT_REFUND_DESTINATION_UNAVAILABLE')
    }

    return this.prisma.$transaction(async (tx) => {
      await this.freshness.assertAutomaticEffectAllowed(tx, input.organizationId)
      // Samma anropsnyckel mot OLIKA tillgodoposter får aldrig misstolkas som
      // ett ofarligt P2002-race. Serialisera nyckeln före något kreditlås.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-credit-refund-request:${input.organizationId}:${input.requestId}`}, 0))`
      const replay = await tx.customerCreditRefund.findUnique({
        where: { ...requestWhere, organizationId: input.organizationId },
      })
      if (replay) return this.replay(replay, requestHash)
      const credit = await this.credits.lockRefundCreditInTransaction(input, tx)
      const config = await this.configuration(tx, credit)
      const source = await this.credits.assertRefundSourceInTransaction(input, tx)
      if (source.bankLedgerAccountId !== config.bankLedgerAccountId)
        throw new ConflictException(
          'Återbetalningens bokföringskonto avviker från källbetalningens bankkonto',
        )
      if (input.amount.gt(customerCreditAvailableAmount(credit)))
        throw new ConflictException('Beloppet överstiger disponibelt kundtillgodo')
      const now = new Date()
      if (
        destination.organizationId !== input.organizationId ||
        destination.tenantId !== credit.tenantId ||
        destination.bankAccountId !== config.policy.bankAccountId ||
        destination.recipientVerifiedAt > now ||
        destination.recipientValidUntil <= now
      ) {
        throw new ConflictException('Mottagarunderlaget gäller inte denna återbetalning')
      }
      const fields: InstructionFields = {
        id: randomUUID(),
        organizationId: input.organizationId,
        creditId: credit.id,
        tenantId: credit.tenantId,
        leaseId: credit.leaseId,
        amount: input.amount,
        currency: 'SEK',
        liabilityAccountId: credit.liabilityAccountId,
        bankAccountId: config.policy.bankAccountId,
        bankLedgerAccountId: config.bankLedgerAccountId,
        provider: destination.provider,
        providerAccountRef: destination.providerAccountRef,
        recipientRef: destination.recipientRef,
        recipientProofHash: destination.recipientProofHash,
        recipientVerifiedAt: destination.recipientVerifiedAt,
        recipientValidUntil: destination.recipientValidUntil,
      }
      const row = await tx.customerCreditRefund.create({
        data: {
          ...fields,
          requestId: input.requestId,
          requestHash,
          instructionHash: instructionHash(fields),
          preparedAt: now,
        },
      })
      await this.event(tx, row, 'RESERVED', now)
      return row
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }

  private instruction(row: CustomerCreditRefund): CustomerCreditRefundInstruction {
    if (instructionHash(row) !== row.instructionHash)
      throw new ConflictException('Återbetalningens sparade instruktion har ändrats')
    return CustomerCreditRefundInstructionSchema.parse({
      refundId: row.id,
      instructionId: row.id,
      idempotencyKey: row.id,
      organizationId: row.organizationId,
      tenantId: row.tenantId,
      bankAccountId: row.bankAccountId,
      provider: row.provider,
      providerAccountRef: row.providerAccountRef,
      recipientRef: row.recipientRef,
      recipientProofHash: row.recipientProofHash,
      amount: row.amount.toFixed(2),
      currency: row.currency,
      instructionHash: row.instructionHash,
    })
  }

  async cancelRefund(input: CustomerCreditRefundIdentity): Promise<CustomerCreditRefund> {
    this.assertActor()
    const before = await this.find(input)
    return this.prisma.$transaction(async (tx) => {
      const { row } = await this.lockOrder(input, before.creditId, tx)
      if (row.state === 'CANCELLED') return row
      if (row.state !== 'RESERVED' || row.submissionStartedAt)
        throw new ConflictException('En påbörjad banköverföring kan inte annulleras lokalt')
      const now = new Date()
      const cancelled = await tx.customerCreditRefund.update({
        where: { id: row.id },
        data: { state: 'CANCELLED', cancelledAt: now },
      })
      await this.event(tx, cancelled, 'CANCELLED', now)
      return cancelled
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }

  async submitRefund(input: CustomerCreditRefundIdentity): Promise<CustomerCreditRefund> {
    this.assertActor()
    const before = await this.find(input)
    if (before.state !== 'RESERVED') return this.recoverRefund(input)
    const claim = await this.prisma.$transaction(async (tx) => {
      await this.freshness.assertAutomaticEffectAllowed(tx, input.organizationId)
      const { row, credit } = await this.lockOrder(input, before.creditId, tx)
      if (row.state !== 'RESERVED') return { row, maySubmit: false }
      const config = await this.configuration(tx, credit)
      const source = await this.credits.assertRefundSourceInTransaction(
        { organizationId: input.organizationId, creditId: row.creditId },
        tx,
      )
      const now = new Date()
      if (
        row.bankAccountId !== config.policy.bankAccountId ||
        row.bankLedgerAccountId !== config.bankLedgerAccountId ||
        row.bankLedgerAccountId !== source.bankLedgerAccountId ||
        row.liabilityAccountId !== config.policy.liabilityAccountId ||
        row.recipientVerifiedAt > now ||
        row.recipientValidUntil <= now ||
        customerCreditAvailableAmount(credit).lt(0)
      )
        throw new ConflictException(
          'Återbetalningens frysta konto- eller mottagarunderlag gäller inte längre',
        )
      this.instruction(row)
      const started = await tx.customerCreditRefund.update({
        where: { id: row.id },
        data: { state: 'SUBMITTING', submissionStartedAt: now },
      })
      await this.event(tx, started, 'SUBMITTING', now)
      return { row: started, maySubmit: true }
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
    if (!claim.maySubmit) return this.recoverRefund(input)
    return this.observePort(input, claim.row, 'submit')
  }

  private async markUnknown(
    input: CustomerCreditRefundIdentity,
    reasonCode: string,
  ): Promise<void> {
    const before = await this.find(input)
    await this.prisma.$transaction(async (tx) => {
      const { row } = await this.lockOrder(input, before.creditId, tx)
      if (row.state !== 'SUBMITTING' && row.state !== 'UNKNOWN') return
      const updated = await tx.customerCreditRefund.update({
        where: { id: row.id },
        data: { state: 'UNKNOWN' },
      })
      await this.event(tx, updated, 'UNKNOWN', new Date(), undefined, reasonCode)
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }

  private async observePort(
    input: CustomerCreditRefundIdentity,
    row: CustomerCreditRefund,
    operation: 'submit' | 'lookup',
  ): Promise<CustomerCreditRefund> {
    const instruction = this.instruction(row)
    let raw: unknown
    try {
      raw =
        operation === 'submit'
          ? await this.bank.submit(instruction)
          : await this.bank.lookup(instruction)
    } catch {
      await this.markUnknown(input, 'BANK_PORT_UNAVAILABLE')
      throw new ServiceUnavailableException('CUSTOMER_CREDIT_REFUND_BANK_UNAVAILABLE')
    }
    const parsed = CustomerCreditRefundBankObservationSchema.safeParse(raw)
    if (!parsed.success || !this.observationMatches(row, parsed.data)) {
      await this.markUnknown(input, 'BANK_INVALID_OBSERVATION')
      throw new ConflictException('CUSTOMER_CREDIT_REFUND_INVALID_BANK_OBSERVATION')
    }
    return this.recordBankObservation(input, row.creditId, parsed.data)
  }

  private observationMatches(
    row: CustomerCreditRefund,
    observation: CustomerCreditRefundBankObservation,
  ): boolean {
    if (
      observation.instructionId !== row.id ||
      (row.providerTransferId &&
        observation.providerTransferId &&
        row.providerTransferId !== observation.providerTransferId)
    )
      return false
    if (observation.kind !== 'BOOKED_DEBIT' && observation.kind !== 'VERIFIED_NOT_EXECUTED')
      return true
    const now = new Date()
    if (
      observation.instructionHash !== row.instructionHash ||
      observation.organizationId !== row.organizationId ||
      observation.tenantId !== row.tenantId ||
      observation.bankAccountId !== row.bankAccountId ||
      observation.provider !== row.provider ||
      observation.providerAccountRef !== row.providerAccountRef ||
      observation.recipientRef !== row.recipientRef ||
      observation.amount !== row.amount.toFixed(2) ||
      observation.currency !== row.currency ||
      !row.submissionStartedAt ||
      observation.verifiedAt < row.submissionStartedAt ||
      observation.verifiedAt > now
    )
      return false
    if (observation.kind === 'BOOKED_DEBIT') {
      const startedDay = stockholmCivilDate(row.submissionStartedAt)
      const bookedDay = stockholmCivilDate(observation.bankBookedAt)
      const period = (day: { year: number; month: number; day: number }) =>
        day.year * 10000 + day.month * 100 + day.day
      if (
        period(bookedDay) < period(startedDay) ||
        observation.bankBookedAt > observation.verifiedAt
      )
        return false
    }
    return true
  }

  /** Privat: bankfakta får endast komma från en validerad server-side portobservation. */
  private async recordBankObservation(
    input: CustomerCreditRefundIdentity,
    creditId: string,
    observation: CustomerCreditRefundBankObservation,
  ): Promise<CustomerCreditRefund> {
    return this.prisma.$transaction(async (tx) => {
      const { row } = await this.lockOrder(input, creditId, tx)
      if (!this.observationMatches(row, observation))
        throw new ConflictException('CUSTOMER_CREDIT_REFUND_BANK_OBSERVATION_CONFLICT')
      if (row.state === 'BANK_CONFIRMED' || row.state === 'SETTLED') {
        if (
          observation.kind === 'BOOKED_DEBIT' &&
          (row.bankTransactionId !== observation.bankTransactionId ||
            row.providerTransferId !== observation.providerTransferId ||
            row.bankBookedAt?.getTime() !== observation.bankBookedAt.getTime() ||
            row.bankProofHash !== customerCreditRefundBankProofHash(observation))
        )
          throw new ConflictException('CUSTOMER_CREDIT_REFUND_BANK_EVIDENCE_CONFLICT')
        if (observation.kind === 'VERIFIED_NOT_EXECUTED')
          throw new ConflictException('CUSTOMER_CREDIT_REFUND_BANK_EVIDENCE_CONFLICT')
        return row
      }
      if (row.state === 'REJECTED') {
        if (
          observation.kind === 'VERIFIED_NOT_EXECUTED' &&
          row.providerTransferId === observation.providerTransferId &&
          row.rejectionProofHash === customerCreditRefundRejectionProofHash(observation)
        )
          return row
        throw new ConflictException('CUSTOMER_CREDIT_REFUND_BANK_EVIDENCE_CONFLICT')
      }
      if (row.state !== 'SUBMITTING' && row.state !== 'UNKNOWN')
        throw new ConflictException('Bankobservationen saknar påbörjad återbetalning')
      const now = new Date()
      if (observation.kind === 'BOOKED_DEBIT') {
        const bankProofHash = customerCreditRefundBankProofHash(observation)
        const confirmed = await tx.customerCreditRefund.update({
          where: { id: row.id },
          data: {
            state: 'BANK_CONFIRMED',
            providerTransferId: observation.providerTransferId,
            bankTransactionId: observation.bankTransactionId,
            bankProofKey: JSON.stringify([
              row.provider,
              row.providerAccountRef,
              observation.bankTransactionId,
            ]),
            bankProofHash,
            bankEvidence: storedJson(observation),
            bankConfirmedAt: now,
            bankBookedAt: observation.bankBookedAt,
          },
        })
        await this.event(tx, confirmed, 'BANK_CONFIRMED', now, bankProofHash)
        return confirmed
      }
      if (observation.kind === 'VERIFIED_NOT_EXECUTED') {
        const rejectionProofHash = customerCreditRefundRejectionProofHash(observation)
        const rejected = await tx.customerCreditRefund.update({
          where: { id: row.id },
          data: {
            state: 'REJECTED',
            providerTransferId: observation.providerTransferId,
            rejectionProofHash,
            rejectionEvidence: storedJson(observation),
            rejectedAt: now,
          },
        })
        await this.event(tx, rejected, 'REJECTED', now, rejectionProofHash, observation.reasonCode)
        return rejected
      }
      const updated = await tx.customerCreditRefund.update({
        where: { id: row.id },
        data: {
          state: observation.kind === 'PENDING' ? row.state : 'UNKNOWN',
          ...(observation.providerTransferId
            ? { providerTransferId: observation.providerTransferId }
            : {}),
        },
      })
      const eventType: EventType =
        observation.kind === 'PENDING'
          ? 'BANK_PENDING'
          : observation.kind === 'NOT_FOUND'
            ? 'BANK_NOT_FOUND'
            : 'UNKNOWN'
      await this.event(tx, updated, eventType, now, hash(observation))
      return updated
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }

  /** Ingen policy/färskhetsgrind: banken kan redan ha utfört den frysta ordern. */
  async recoverRefund(input: CustomerCreditRefundIdentity): Promise<CustomerCreditRefund> {
    this.assertActor()
    const before = await this.find(input)
    if (before.state === 'BANK_CONFIRMED' || before.state === 'SETTLED')
      return this.postConfirmedRefund(input)
    if (before.state !== 'SUBMITTING' && before.state !== 'UNKNOWN') return before
    const observed = await this.observePort(input, before, 'lookup')
    return observed.state === 'BANK_CONFIRMED' ? this.postConfirmedRefund(input) : observed
  }

  async postConfirmedRefund(input: CustomerCreditRefundIdentity): Promise<CustomerCreditRefund> {
    this.assertActor()
    const before = await this.find(input)
    return this.prisma.$transaction(async (tx) => {
      const { row, credit } = await this.lockOrder(input, before.creditId, tx)
      if (
        (row.state !== 'BANK_CONFIRMED' && row.state !== 'SETTLED') ||
        !row.bankBookedAt ||
        !row.bankTransactionId
      )
        throw new ConflictException('Återbetalningen saknar beständigt bankbekräftat underlag')
      const day = stockholmCivilDate(row.bankBookedAt)
      const journal = await this.accounting.createJournalEntryForCustomerCreditRefund(
        {
          organizationId: row.organizationId,
          eventId: row.id,
          rentNoticeId: credit.sourceRentNoticeId,
          amount: row.amount,
          liabilityAccountId: row.liabilityAccountId,
          bankLedgerAccountId: row.bankLedgerAccountId,
          bankTransactionId: row.bankTransactionId,
          date: new Date(Date.UTC(day.year, day.month - 1, day.day)),
        },
        tx,
      )
      if (row.state === 'SETTLED') return row
      const now = new Date()
      const settled = await tx.customerCreditRefund.update({
        where: { id: row.id },
        data: { state: 'SETTLED', journalEntryId: journal.id, settledAt: now },
      })
      await this.event(tx, settled, 'SETTLED', now)
      return settled
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS))
  }
}
