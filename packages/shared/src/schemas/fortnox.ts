import { z } from 'zod'

/**
 * Fortnox A — DELADE nyttolaster webb ↔ API (check-request-contract).
 * Servern validerar ändå allt på nytt och verifierar år/konton/dimensioner mot
 * Fortnox; klientens värden är aldrig bevis.
 */
const isCivilDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value

const civilDate = z.string().refine(isCivilDate, 'Ogiltigt datum')

/** POST /integrations/fortnox/reads */
export const fortnoxReadInputSchema = z
  .object({
    financialYearId: z.number().int().positive().safe(),
    financialYearStart: civilDate,
    financialYearEnd: civilDate,
    periodFrom: civilDate,
    periodTo: civilDate,
    costAccounts: z.array(z.number().int().positive().safe()).min(1),
  })
  .refine(
    (input) =>
      input.financialYearStart <= input.periodFrom &&
      input.periodFrom <= input.periodTo &&
      input.periodTo <= input.financialYearEnd,
    'Perioden måste ligga inom det valda räkenskapsåret',
  )
export type FortnoxReadInput = z.infer<typeof fortnoxReadInputSchema>

/** PUT /integrations/fortnox/mappings */
export const fortnoxMappingInputSchema = z.object({
  dimensionType: z.enum(['COST_CENTER', 'PROJECT']),
  code: z.string().min(1),
  propertyId: z.string().min(1),
})
export type FortnoxMappingInput = z.infer<typeof fortnoxMappingInputSchema>

/** PUT /integrations/fortnox/export-settings — uttryckliga kundval, inga standardvärden. */
export const fortnoxExportSettingsInputSchema = z
  .object({
    voucherSeries: z
      .string()
      .regex(/^[A-Za-z0-9]{1,10}$/)
      .optional(),
    omitDimensions: z.boolean().optional(),
  })
  .refine(
    (v) => v.voucherSeries !== undefined || v.omitDimensions !== undefined,
    'Inget val angivet',
  )
export type FortnoxExportSettingsInput = z.infer<typeof fortnoxExportSettingsInputSchema>

/** POST /integrations/fortnox/exports/dry-run — ett verifikat ur organisationens egen lista. */
export const fortnoxDryRunInputSchema = z.object({ journalEntryId: z.string().min(1) })
export type FortnoxDryRunInput = z.infer<typeof fortnoxDryRunInputSchema>

/** POST /integrations/fortnox/exports/:id/send — uttrycklig bekräftelse, bunden till utkastets hash. */
export const fortnoxSendInputSchema = z.object({
  draftHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirm: z.literal(true),
})
export type FortnoxSendInput = z.infer<typeof fortnoxSendInputSchema>

/** POST /integrations/fortnox/exports/:id/reconcile — exakt extern identitet i Fortnox. */
export const fortnoxReconcileInputSchema = z.object({
  year: z.number().int().positive().safe(),
  series: z.string().regex(/^[A-Za-z0-9]{1,10}$/),
  number: z.number().int().positive().safe(),
})
export type FortnoxReconcileInput = z.infer<typeof fortnoxReconcileInputSchema>
