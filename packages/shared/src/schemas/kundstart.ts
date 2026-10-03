import { z } from 'zod'

/**
 * KUNDSTART-001 — DELADE nyttolaster webb ↔ API (check-request-contract). Servern prövar
 * allt på nytt; formen här och DTO:n hålls lika av SammaNycklar + paritetsprovet.
 */
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum anges som ÅÅÅÅ-MM-DD')
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 i hex')
const kontolista = z.array(z.number().int().min(1000).max(9999)).max(50)

/** PUT /kundstart/cutover — den 1:a i en månad prövas av servern (mitt i perioden avvisas). */
export const setCutoverInputSchema = z.object({ cutoverDate: datum.nullable() })
export type SetCutoverInput = z.infer<typeof setCutoverInputSchema>

/** POST /kundstart/opening-packages och PUT …/:id/source. */
export const uploadOpeningPackageInputSchema = z.object({
  sourceName: z.string().min(1).max(200),
  innehall: z.string().max(900_000),
  nollOppning: z.boolean().optional(),
})
export type UploadOpeningPackageInput = z.infer<typeof uploadOpeningPackageInputSchema>

/** POST /kundstart/opening-packages/:id/fortnox-read */
export const bindOpeningReadInputSchema = z.object({ readRunId: z.string().uuid() })
export type BindOpeningReadInput = z.infer<typeof bindOpeningReadInputSchema>

/** PUT /kundstart/opening-packages/:id/separate-ledger (S5-1: identitet per post i filen). */
export const separateLedgerInputSchema = z.object({
  konto: z.enum(['1510', '2890']),
  beskrivning: z.string().max(2000),
  filnamn: z.string().max(200),
  innehall: z.string().max(900_000).nullable(),
  system: z.string().max(200).optional(),
  ansvarig: z.string().max(200).optional(),
})
export type SeparateLedgerInput = z.infer<typeof separateLedgerInputSchema>

/** PUT /kundstart/opening-packages/:id/first-period-register (KUNDSTART-009). */
export const firstPeriodRegisterInputSchema = z.object({
  filnamn: z.string().min(1).max(200),
  innehall: z.string().max(900_000),
  system: z.string().max(200),
  ansvarig: z.string().max(200),
  tackningFran: datum,
  tackningTill: datum,
  intaktskonton: kontolista,
  forskottskonton: kontolista,
})
export type FirstPeriodRegisterInput = z.infer<typeof firstPeriodRegisterInputSchema>

/** POST /kundstart/opening-packages/:id/approve — bundet till granskad version och fil. */
export const approveOpeningPackageInputSchema = z.object({
  version: z.number().int().min(1),
  sourceSha256: sha256,
})
export type ApproveOpeningPackageInput = z.infer<typeof approveOpeningPackageInputSchema>

/** POST /integrations/fortnox/customer-activation/approve — bundet till konsekvenstextens sha. */
export const approveCustomerActivationInputSchema = z.object({
  financialYearId: z.number().int().min(1),
  consequencesSha256: sha256,
})
export type ApproveCustomerActivationInput = z.infer<typeof approveCustomerActivationInputSchema>
