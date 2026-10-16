import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { z } from 'zod'

const opaqueReference = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim())
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const money = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})\.\d{2}$/)
  .refine((value) => value !== '0.00')
// Samma validering gäller bankadapterns Date och det sparade JSON-bevisets ISO-datum.
const instant = z.union([
  z.date(),
  z
    .string()
    .datetime({ offset: true })
    .transform((s) => new Date(s)),
])

export const CustomerCreditRefundDestinationRequestSchema = z
  .object({
    organizationId: opaqueReference,
    tenantId: opaqueReference,
    bankAccountId: opaqueReference,
  })
  .strict()

export const CustomerCreditRefundDestinationSchema =
  CustomerCreditRefundDestinationRequestSchema.extend({
    provider: opaqueReference,
    providerAccountRef: opaqueReference,
    recipientRef: opaqueReference,
    recipientProofHash: sha256,
    recipientVerifiedAt: instant,
    recipientValidUntil: instant,
  }).refine((value) => value.recipientValidUntil > value.recipientVerifiedAt, {
    message: 'Mottagarbindningens giltighet måste sluta efter verifieringen',
  })

export const CustomerCreditRefundInstructionSchema = z
  .object({
    refundId: opaqueReference,
    instructionId: opaqueReference,
    idempotencyKey: opaqueReference,
    organizationId: opaqueReference,
    tenantId: opaqueReference,
    bankAccountId: opaqueReference,
    provider: opaqueReference,
    providerAccountRef: opaqueReference,
    recipientRef: opaqueReference,
    recipientProofHash: sha256,
    amount: money,
    currency: z.literal('SEK'),
    instructionHash: sha256,
  })
  .strict()
  .refine(
    (value) => value.instructionId === value.refundId && value.idempotencyKey === value.refundId,
    {
      message: 'Återbetalningen måste behålla samma instruktions- och idempotensidentitet',
    },
  )

const uncertainObservation = z.object({
  instructionId: opaqueReference,
  providerTransferId: opaqueReference.optional(),
})

// Adaptern måste hämta detta eko från bankens auktoritativa uppgift och verifierade
// org-/kontobindning. Att kopiera förväntade värden från instruktionen är inget bevis.
const verifiedObservation = z.object({
  instructionId: opaqueReference,
  instructionHash: sha256,
  organizationId: opaqueReference,
  tenantId: opaqueReference,
  bankAccountId: opaqueReference,
  provider: opaqueReference,
  providerAccountRef: opaqueReference,
  recipientRef: opaqueReference,
  amount: money,
  currency: z.literal('SEK'),
  providerTransferId: opaqueReference,
  verifiedAt: instant,
  evidenceHash: sha256,
})

export const CustomerCreditRefundBookedDebitSchema = verifiedObservation
  .extend({
    kind: z.literal('BOOKED_DEBIT'),
    bankTransactionId: opaqueReference,
    bankBookedAt: instant,
  })
  .strict()

export const CustomerCreditRefundVerifiedNotExecutedSchema = verifiedObservation
  .extend({
    kind: z.literal('VERIFIED_NOT_EXECUTED'),
    reasonCode: z.enum(['BANK_REJECTED', 'BANK_CANCELLED']),
  })
  .strict()

export const CustomerCreditRefundBankObservationSchema = z.discriminatedUnion('kind', [
  uncertainObservation.extend({ kind: z.literal('PENDING') }).strict(),
  uncertainObservation.extend({ kind: z.literal('UNKNOWN') }).strict(),
  uncertainObservation.extend({ kind: z.literal('NOT_FOUND') }).strict(),
  CustomerCreditRefundVerifiedNotExecutedSchema,
  CustomerCreditRefundBookedDebitSchema,
])

export type CustomerCreditRefundDestinationRequest = z.infer<
  typeof CustomerCreditRefundDestinationRequestSchema
>
export type CustomerCreditRefundDestination = z.infer<typeof CustomerCreditRefundDestinationSchema>
export type CustomerCreditRefundInstruction = z.infer<typeof CustomerCreditRefundInstructionSchema>
export type CustomerCreditRefundBankObservation = z.infer<
  typeof CustomerCreditRefundBankObservationSchema
>
export type CustomerCreditRefundBookedDebit = z.infer<typeof CustomerCreditRefundBookedDebitSchema>
export type CustomerCreditRefundVerifiedNotExecuted = z.infer<
  typeof CustomerCreditRefundVerifiedNotExecutedSchema
>

/**
 * Hash av stabila bankfakta. En ny lookup får ha senare verifiedAt utan att
 * samma ekonomiska händelse blir ett nytt bevis. evidenceHash måste av samma
 * skäl identifiera bankens beständiga underlag, aldrig HTTP-svar/hämtningstid.
 */
export function customerCreditRefundBankProofHash(
  evidence: CustomerCreditRefundBookedDebit,
): string {
  const facts = { ...CustomerCreditRefundBookedDebitSchema.parse(evidence), verifiedAt: undefined }
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

/** Även ett slutligt avslag behåller sin faktaidentitet när banken läses igen. */
export function customerCreditRefundRejectionProofHash(
  evidence: CustomerCreditRefundVerifiedNotExecuted,
): string {
  const facts = {
    ...CustomerCreditRefundVerifiedNotExecutedSchema.parse(evidence),
    verifiedAt: undefined,
  }
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

export const CUSTOMER_CREDIT_REFUND_BANK_PORT = Symbol('CUSTOMER_CREDIT_REFUND_BANK_PORT')

/**
 * Endast servern bygger instruktionen från en beständig reservation. Inga klient-
 * DTO:er får lämna bankbevis eller mottagarkonton till denna port.
 *
 * prepareDestination verifierar hyresgästens mottagare samt organisationens
 * betalkonto server-side. Ref/hash är opaka; råa konton och banksvar får inte loggas.
 * submit måste vara idempotent hos banken för instructionId/idempotencyKey.
 * Efter timeout görs lookup på SAMMA instruktion, aldrig en ny utbetalning.
 *
 * UNKNOWN, PENDING och NOT_FOUND frigör aldrig saldo. VERIFIED_NOT_EXECUTED
 * betyder bankens slutgiltiga besked att just instruktionen inte har och inte
 * senare kan exekveras; transportfel och frånvaro i en sökning räcker inte.
 * BOOKED_DEBIT bevisar en bokad debitering, inte bara mottagen betalningsorder.
 * SETTLED är domänens senare, atomiska bokföringsstatus och inget bankutfall.
 */
export abstract class CustomerCreditRefundBankPort {
  abstract prepareDestination(
    input: CustomerCreditRefundDestinationRequest,
  ): Promise<CustomerCreditRefundDestination>
  abstract submit(
    instruction: CustomerCreditRefundInstruction,
  ): Promise<CustomerCreditRefundBankObservation>
  abstract lookup(
    instruction: CustomerCreditRefundInstruction,
  ): Promise<CustomerCreditRefundBankObservation>
}

/** Den enda produktionsadaptern tills en verklig, granskad bankintegration finns. */
@Injectable()
export class UnavailableCustomerCreditRefundBankAdapter extends CustomerCreditRefundBankPort {
  async prepareDestination(
    _input: CustomerCreditRefundDestinationRequest,
  ): Promise<CustomerCreditRefundDestination> {
    throw new ServiceUnavailableException('Bankverifierad återbetalning är inte tillgänglig')
  }

  async submit(
    _instruction: CustomerCreditRefundInstruction,
  ): Promise<CustomerCreditRefundBankObservation> {
    throw new ServiceUnavailableException('Bankverifierad återbetalning är inte tillgänglig')
  }

  async lookup(
    _instruction: CustomerCreditRefundInstruction,
  ): Promise<CustomerCreditRefundBankObservation> {
    throw new ServiceUnavailableException('Bankverifierad återbetalning är inte tillgänglig')
  }
}
