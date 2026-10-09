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

/**
 * TESTKUND-008: kontomappningens ROLLER och BEHANDLINGAR. Stängda listor — servern härleder
 * radens roll och behandling ur källan, och en mappningsrad gäller exakt (roll, källkonto,
 * behandling). Inga standardvärden; målkontot väljs uttryckligen av kunden.
 */
export const FORTNOX_ACCOUNT_ROLES = [
  'KUNDFORDRAN',
  'HYRESINTAKT',
  'LIKVID',
  'DEPOSITIONSSKULD',
  'KOSTNAD',
  'INGAENDE_MOMS',
  'LEVERANTORSSKULD',
] as const
export type FortnoxAccountRole = (typeof FORTNOX_ACCOUNT_ROLES)[number]

export const FORTNOX_VAT_TREATMENTS = ['EJ_TILLAMPLIG', 'MOMSFRI', 'AVDRAGSGILL'] as const
export type FortnoxVatTreatment = (typeof FORTNOX_VAT_TREATMENTS)[number]

/** Tillåtna (roll, behandling)-par i v1. Allt annat är ogiltigt indata. */
export const FORTNOX_ROLE_TREATMENT: Readonly<Record<FortnoxAccountRole, FortnoxVatTreatment>> = {
  KUNDFORDRAN: 'EJ_TILLAMPLIG',
  HYRESINTAKT: 'MOMSFRI',
  LIKVID: 'EJ_TILLAMPLIG',
  DEPOSITIONSSKULD: 'EJ_TILLAMPLIG',
  KOSTNAD: 'EJ_TILLAMPLIG',
  INGAENDE_MOMS: 'AVDRAGSGILL',
  LEVERANTORSSKULD: 'EJ_TILLAMPLIG',
}

const kontonummer = z.number().int().min(1000).max(9999)

/** POST /integrations/fortnox/account-mapping/revisions — ett nytt utkast (ny revision). */
export const fortnoxAccountMappingDraftInputSchema = z
  .object({
    financialYearId: z.number().int().positive().safe(),
    rows: z
      .array(
        z
          .object({
            role: z.enum(FORTNOX_ACCOUNT_ROLES),
            vatTreatment: z.enum(FORTNOX_VAT_TREATMENTS),
            sourceAccountNumber: kontonummer,
            targetAccountNumber: kontonummer,
          })
          .strict()
          .refine(
            (r) => FORTNOX_ROLE_TREATMENT[r.role] === r.vatTreatment,
            'Behandlingen gäller inte för rollen',
          ),
      )
      .min(1)
      .max(100)
      .refine(
        (rows) =>
          new Set(rows.map((r) => `${r.role}|${r.sourceAccountNumber}|${r.vatTreatment}`)).size ===
          rows.length,
        'Samma roll, källkonto och behandling förekommer två gånger',
      ),
  })
  .strict()
export type FortnoxAccountMappingDraftInput = z.infer<typeof fortnoxAccountMappingDraftInputSchema>
export type FortnoxAccountMappingRowInput = FortnoxAccountMappingDraftInput['rows'][number]

/** POST /integrations/fortnox/account-mapping/revisions/:id/approve — bunden till innehållet. */
export const fortnoxAccountMappingApproveInputSchema = z
  .object({ contentSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()
export type FortnoxAccountMappingApproveInput = z.infer<
  typeof fortnoxAccountMappingApproveInputSchema
>
