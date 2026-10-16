import { createHash } from 'node:crypto'
import type { BankTransaction, RentNotice, RentNoticePayment } from '@prisma/client'

/** Oförändrat källbevis, gemensamt för domänåtgärder och senare bokföringsexport. */
export function customerCreditSourceProof(
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
