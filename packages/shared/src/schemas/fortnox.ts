import { z } from 'zod'
import { JOURNAL_SOURCES } from './journal'

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

/** Samma källor som journalen; det befintliga Fortnox-kontraktets exportnamn bevaras. */
export const FORTNOX_EXPORT_SOURCES = JOURNAL_SOURCES
export const FORTNOX_EXPORT_GROUPS = ['ALL', 'NEEDS_REVIEW', 'OTHER'] as const

const queryInteger = (value: unknown): unknown =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.exec(value)?.[0] === value ? Number(value) : value

/** GET /integrations/fortnox/exports-page — standardvärden väljs först av tjänsten. */
export const fortnoxExportsPageQuerySchema = z
  .object({
    offset: z.preprocess(queryInteger, z.number().int().min(0).max(2147483647)).optional(),
    limit: z.preprocess(queryInteger, z.number().int().min(1).max(200)).optional(),
    from: civilDate.optional(),
    to: civilDate.optional(),
    source: z.enum(FORTNOX_EXPORT_SOURCES).optional(),
    group: z.enum(FORTNOX_EXPORT_GROUPS).optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Från-datum får inte vara efter till-datum',
    path: ['to'],
  })
export type FortnoxExportsPageQuery = z.infer<typeof fortnoxExportsPageQuerySchema>

/** Samma svar som exportens befintliga webbkontrakt, även för dry-run och sändning. */
export const fortnoxExportRowSchema = z.object({
  id: z.string(),
  journalEntryId: z.string(),
  state: z.enum([
    'DRY_RUN_READY',
    'BLOCKED',
    'SENDING',
    'UNKNOWN',
    'REJECTED',
    'RECEIPT_IDENTIFIED',
    'RECEIPT_MISMATCH',
    'CONFIRMED',
  ]),
  blockReason: z.string().nullable(),
  draftHash: z.string().nullable().optional(),
  lastOutcome: z.string().nullable().optional(),
  externalYear: z.number().nullable().optional(),
  externalSeries: z.string().nullable().optional(),
  externalNumber: z.number().nullable().optional(),
  // TESTKUND-016: fält där exporttexten skiljer sig från Eveno-texten (originalet skrivs aldrig om).
  exportText: z
    .array(
      z.object({
        falt: z.string(),
        rad: z.number().nullable(),
        originaltext: z.string(),
        exporttext: z.string(),
      }),
    )
    .optional(),
  updatedAt: z.string(),
})
export type FortnoxExportRow = z.infer<typeof fortnoxExportRowSchema>

export const fortnoxExportsPageSchema = z.object({
  items: z.array(fortnoxExportRowSchema),
  total: z.number().int().nonnegative().safe(),
  offset: z.number().int().min(0).max(2147483647),
  limit: z.number().int().min(1).max(200),
})
export type FortnoxExportsPage = z.infer<typeof fortnoxExportsPageSchema>

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
 * TESTKUND-016/020 (KODPAR-BESKED-H4-020 K-KP-1): FRYST lista över (HTTP-status, Fortnox-kod) som är
 * BELAGD innehållsavvisning. Bara sådana avvisningar kan frisläppas till en ny förhandskontroll.
 *   (400, 2000359) «Värdet innehåller ej tillåtna tecken» — källa: Fortnox Errors
 *   (https://www.fortnox.se/developer/guides-and-good-to-know/errors); observerat: H3H4-REAL-002
 *   RAW/svar-0112-POST-vouchers.json (sha256 bdf57baa…), HTTP 400 + 2000359.
 * Källan anger ingen status per kod och ingen kategori; en numerisk kod eller en godtycklig 4xx
 * bevisar alltså inte ett innehållsfel. Fler par kräver primärkälla OCH observation (K-KP-3).
 */
export const FORTNOX_BELAGDA_INNEHALLSAVVISNINGAR: ReadonlyArray<readonly [number, number]> =
  Object.freeze([Object.freeze([400, 2000359] as const)])

/**
 * TESTKUND-027 S-021-1: kundtext per belagt kodpar — samma lista, så att webben aldrig beskriver
 * ett par som inte är belagt (och ett nytt par inte kan läggas till utan sin text).
 */
export const FORTNOX_INNEHALLSAVVISNING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  '400:2000359': 'värdet innehåller tecken som Fortnox inte tar emot',
})
export function innehallsavvisningText(http: number, code: number): string | null {
  return arBelagdInnehallsavvisning(http, code)
    ? (FORTNOX_INNEHALLSAVVISNING_TEXT[`${http}:${code}`] ?? null)
    : null
}

export function arBelagdInnehallsavvisning(http: unknown, code: unknown): boolean {
  return FORTNOX_BELAGDA_INNEHALLSAVVISNINGAR.some(([h, c]) => h === http && c === code)
}

/**
 * TESTKUND-016 K3.4: externt avvisningskvitto för en ÄLDRE avvisad export som saknar lagrad
 * Fortnox-kod. Anges uttryckligen av OWNER; produkten sparar det som «angivet i efterhand».
 */
export const fortnoxRejectionEvidenceSchema = z.object({
  http: z.number().int().min(400).max(499),
  code: z.number().int().positive().safe(),
  rakvittoSha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sentPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
})
export type FortnoxRejectionEvidence = z.infer<typeof fortnoxRejectionEvidenceSchema>

/** POST /integrations/fortnox/exports/:id/release-rejected — frisläpp en bevisat avvisad export. */
export const fortnoxReleaseRejectedInputSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  avvisningsbevis: fortnoxRejectionEvidenceSchema.optional(),
})
export type FortnoxReleaseRejectedInput = z.infer<typeof fortnoxReleaseRejectedInputSchema>

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
