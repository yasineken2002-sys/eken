import { ServiceUnavailableException } from '@nestjs/common'
import {
  CustomerCreditRefundBankObservationSchema,
  CustomerCreditRefundDestinationSchema,
  CustomerCreditRefundInstructionSchema,
  UnavailableCustomerCreditRefundBankAdapter,
} from './customer-credit-refund-bank.port'

const instruction = {
  refundId: 'refund-1',
  instructionId: 'refund-1',
  idempotencyKey: 'refund-1',
  organizationId: 'org-1',
  tenantId: 'tenant-1',
  bankAccountId: 'bank-1',
  provider: 'synthetic',
  providerAccountRef: 'synthetic-account',
  recipientRef: 'synthetic-recipient',
  recipientProofHash: 'a'.repeat(64),
  amount: '25.00',
  currency: 'SEK' as const,
  instructionHash: 'b'.repeat(64),
}

describe('återbetalningens produktionsport är stängd och skiljer fakta från osäkerhet', () => {
  it('produktionsadaptern kan varken verifiera mottagare, skicka eller hitta på bankbekräftelse', async () => {
    const bank = new UnavailableCustomerCreditRefundBankAdapter()
    await expect(
      bank.prepareDestination({
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        bankAccountId: 'bank-1',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(bank.submit(instruction)).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(bank.lookup(instruction)).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it.each(['PENDING', 'UNKNOWN', 'NOT_FOUND'])(
    '%s får inte bära ett inbäddat påstående om bankbokning',
    (kind) => {
      expect(
        CustomerCreditRefundBankObservationSchema.safeParse({ kind, instructionId: 'refund-1' })
          .success,
      ).toBe(true)
      expect(
        CustomerCreditRefundBankObservationSchema.safeParse({
          kind,
          instructionId: 'refund-1',
          bankBookedAt: new Date(),
        }).success,
      ).toBe(false)
    },
  )

  it('godtar inte lokala verified-flaggor, godtyckliga bankmeddelanden eller ny retryidentitet', () => {
    expect(
      CustomerCreditRefundBankObservationSchema.safeParse({ verified: true, kind: 'BOOKED_DEBIT' })
        .success,
    ).toBe(false)
    expect(
      CustomerCreditRefundBankObservationSchema.safeParse({
        kind: 'VERIFIED_NOT_EXECUTED',
        reasonCode: 'HTTP_TIMEOUT',
      }).success,
    ).toBe(false)
    expect(
      CustomerCreditRefundInstructionSchema.safeParse({
        ...instruction,
        idempotencyKey: 'new-attempt',
      }).success,
    ).toBe(false)
  })

  it.each(['0.00', '-1.00', '25', '25.001', '1e2'])(
    'beloppet %s får inte bli en bankinstruktion',
    (amount) => {
      expect(
        CustomerCreditRefundInstructionSchema.safeParse({ ...instruction, amount }).success,
      ).toBe(false)
    },
  )

  it('kräver en tidsavgränsad mottagarbindning och håller råa kontofält utanför kontraktet', () => {
    const destination = {
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      bankAccountId: 'bank-1',
      provider: 'synthetic',
      providerAccountRef: 'synthetic-account',
      recipientRef: 'synthetic-recipient',
      recipientProofHash: 'a'.repeat(64),
      recipientVerifiedAt: new Date('2026-10-16T10:00:00Z'),
      recipientValidUntil: new Date('2026-10-17T10:00:00Z'),
    }
    expect(CustomerCreditRefundDestinationSchema.safeParse(destination).success).toBe(true)
    expect(
      CustomerCreditRefundDestinationSchema.safeParse({
        ...destination,
        recipientValidUntil: destination.recipientVerifiedAt,
      }).success,
    ).toBe(false)
    expect(
      CustomerCreditRefundDestinationSchema.safeParse({
        ...destination,
        bankAccountNumber: 'SYNTHETIC-RAW-ACCOUNT',
      }).success,
    ).toBe(false)
  })
})
