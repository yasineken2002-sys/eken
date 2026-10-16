/** Syntetisk bankport + ordinarie Postgres/bokföring. Ingen nätverkskod eller testsvit vid import. */
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { runWithActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import type { MailService } from '../mail/mail.service'
import {
  PaymentFreshnessService,
  paymentFreshnessTransactionOptions,
} from '../payment-freshness/payment-freshness.service'
import { fixture, receive, services, type Fixture } from './customer-credit-dispatch.test-fixtures'
import {
  CustomerCreditRefundBankPort,
  CustomerCreditRefundVerifiedNotExecutedSchema,
  type CustomerCreditRefundBankObservation,
  type CustomerCreditRefundBookedDebit,
  type CustomerCreditRefundDestination,
  type CustomerCreditRefundDestinationRequest,
  type CustomerCreditRefundInstruction,
} from './customer-credit-refund-bank.port'
import { CustomerCreditRefundService } from './customer-credit-refund.service'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function syntheticDestination(
  input: CustomerCreditRefundDestinationRequest,
): CustomerCreditRefundDestination {
  return {
    ...input,
    provider: 'synthetic-test-bank',
    providerAccountRef: `synthetic-account:${input.bankAccountId}`,
    recipientRef: `synthetic-recipient:${input.tenantId}`,
    recipientProofHash: digest(`synthetic-recipient:${input.tenantId}`),
    recipientVerifiedAt: new Date(Date.now() - 60_000),
    recipientValidUntil: new Date(Date.now() + 24 * 60 * 60_000),
  }
}

/** Ekon här är påhittade testfakta, inte en implementation av bankverifiering. */
export function booked(
  i: CustomerCreditRefundInstruction,
  changes: Partial<CustomerCreditRefundBookedDebit> = {},
): CustomerCreditRefundBookedDebit {
  const now = new Date()
  return {
    kind: 'BOOKED_DEBIT',
    instructionId: i.instructionId,
    instructionHash: i.instructionHash,
    organizationId: i.organizationId,
    tenantId: i.tenantId,
    bankAccountId: i.bankAccountId,
    provider: i.provider,
    providerAccountRef: i.providerAccountRef,
    recipientRef: i.recipientRef,
    amount: i.amount,
    currency: i.currency,
    providerTransferId: `synthetic-transfer:${i.refundId}`,
    verifiedAt: now,
    evidenceHash: digest(`synthetic-booking:${i.refundId}`),
    bankTransactionId: `synthetic-debit:${i.refundId}`,
    bankBookedAt: now,
    ...changes,
  }
}

export function rejected(i: CustomerCreditRefundInstruction): CustomerCreditRefundBankObservation {
  return CustomerCreditRefundVerifiedNotExecutedSchema.strip().parse({
    ...booked(i),
    kind: 'VERIFIED_NOT_EXECUTED',
    reasonCode: 'BANK_REJECTED',
  })
}

export class SyntheticRefundBank extends CustomerCreditRefundBankPort {
  destination = jest.fn(async (input: CustomerCreditRefundDestinationRequest) =>
    syntheticDestination(input),
  )
  send = jest.fn(
    async (i: CustomerCreditRefundInstruction): Promise<CustomerCreditRefundBankObservation> => ({
      kind: 'UNKNOWN',
      instructionId: i.instructionId,
    }),
  )
  read = jest.fn(
    async (i: CustomerCreditRefundInstruction): Promise<CustomerCreditRefundBankObservation> => ({
      kind: 'UNKNOWN',
      instructionId: i.instructionId,
    }),
  )

  prepareDestination(input: CustomerCreditRefundDestinationRequest) {
    return this.destination(input)
  }
  submit(input: CustomerCreditRefundInstruction) {
    return this.send(input)
  }
  lookup(input: CustomerCreditRefundInstruction) {
    return this.read(input)
  }
}

export function refundServices(prisma: PrismaService, bank: CustomerCreditRefundBankPort) {
  const s = services(prisma)
  const mail: Pick<MailService, 'sendCustomEmail'> = {
    sendCustomEmail: async () => {
      throw new Error('Återbetalningsprovet får inte skicka mejl')
    },
  }
  const freshness = new PaymentFreshnessService(prisma, mail as MailService)
  return {
    ...s,
    refund: new CustomerCreditRefundService(prisma, s.credit, s.accounting, freshness, bank),
  }
}

export async function refundFixture(
  prisma: PrismaService,
  options: { creditAmount?: string; targetAmount?: string; enabled?: boolean } = {},
) {
  const f = await fixture(prisma, { targetAmount: options.targetAmount ?? '1000.00' })
  const ledger = await prisma.account.findFirstOrThrow({
    where: { organizationId: f.organizationId, number: 1930 },
  })
  await prisma.customerCreditPolicy.update({
    where: { organizationId: f.organizationId },
    data: { refundEnabled: options.enabled ?? true, refundBankLedgerAccountId: ledger.id },
  })
  if (options.creditAmount) {
    await prisma.bankTransaction.update({
      where: { id: f.bankTransactionId },
      data: { amount: new Prisma.Decimal(1000).plus(options.creditAmount) },
    })
  }
  const credit = await receive(prisma, f)
  const bank = new SyntheticRefundBank()
  const s = refundServices(prisma, bank)
  const reserve = (amount = '25.00', requestId = randomUUID()) =>
    runWithActor('HUMAN', () =>
      s.refund.reserveRefund({
        organizationId: f.organizationId,
        creditId: credit.id,
        requestId,
        amount: new Prisma.Decimal(amount),
      }),
    )
  const scope = (refundId: string) => ({ organizationId: f.organizationId, refundId })
  return { ...s, credits: s.credit, f, credit, bank, ledger, reserve, scope }
}

export function prepareNotice(f: Fixture) {
  return {
    organizationId: f.organizationId,
    rentNoticeId: f.target.id,
    buildSnapshot: async (tx: Prisma.TransactionClient) => {
      const target = await tx.rentNotice.findUniqueOrThrow({
        where: { id: f.target.id },
        include: { payments: true },
      })
      const used = target.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0))
      return {
        snapshot: {
          version: 1,
          html: '<html><body>Syntetiskt återbetalningsprov</body></html>',
          to: 'syntetisk@example.invalid',
          tenantName: 'Syntetisk hyresgäst',
          organizationName: 'Syntetiskt bolag',
          noticeNumber: target.noticeNumber,
          ocrNumber: target.ocrNumber,
          dueDate: target.dueDate.toISOString(),
          accentColor: null,
          payableAmount: target.totalAmount.minus(used).toNumber(),
          customerCreditAmount: used.toNumber(),
        },
        toHash: digest('syntetisk@example.invalid'),
      }
    },
  }
}

/** Stoppa exakt första transaktionen EFTER dess arbete men FÖRE commit. */
export function holdFirstCommit(prisma: PrismaService) {
  let first = true
  let ready!: () => void
  let resume!: () => void
  const reached = new Promise<void>((resolve) => {
    ready = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  const wrapped = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver)
      return <T>(
        run: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: typeof PAYMENT_TX_LIMITS,
      ) => {
        if (!first)
          return target.$transaction(run, {
            ...paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS),
            ...options,
          })
        first = false
        return target.$transaction(
          async (tx) => {
            const result = await run(tx)
            ready()
            let timer: NodeJS.Timeout | undefined
            try {
              await Promise.race([
                release,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('Provet släppte aldrig commitspärren')),
                    5000,
                  )
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
            return result
          },
          { ...paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS), ...options },
        )
      }
    },
  })
  return { prisma: wrapped, reached, release: resume }
}

export function observeTransactionStart(prisma: PrismaService) {
  let entered!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const wrapped = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver)
      return <T>(
        run: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: typeof PAYMENT_TX_LIMITS,
      ) =>
        target.$transaction(
          async (tx) => {
            entered()
            return run(tx)
          },
          { ...paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS), ...options },
        )
    },
  })
  return { prisma: wrapped, reached }
}
