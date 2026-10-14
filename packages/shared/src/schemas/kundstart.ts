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
  // KUNDSTART-205: den granskade kundavstämningens version (servern prövar mot sin egen).
  evidenceSha256: sha256,
})
export type ApproveOpeningPackageInput = z.infer<typeof approveOpeningPackageInputSchema>

/** POST /integrations/fortnox/customer-activation/approve — bundet till konsekvenstextens sha. */
export const approveCustomerActivationInputSchema = z.object({
  financialYearId: z.number().int().min(1),
  consequencesSha256: sha256,
})
export type ApproveCustomerActivationInput = z.infer<typeof approveCustomerActivationInputSchema>

/**
 * POST /integrations/fortnox/customer-activation/ledger-owner — HUVUDBOK-STEG1 (154): OWNER väljer
 * Fortnox som huvudbok, bundet till organisationens AKTIVA kundaktivering.
 */
export const chooseLedgerOwnerInputSchema = z.object({
  activationId: z.string().uuid(),
})
export type ChooseLedgerOwnerInput = z.infer<typeof chooseLedgerOwnerInputSchema>

// ── KUNDSTART-205 (R165-3): kundavstämning mot tidigare reskontra ────────────────────

/**
 * POST /kundstart/opening-packages/:id/evidence (OWNER/ADMIN). Källa och mappning skickas
 * som TEXT i formaten EVENO-RESKONTRA-1 och EVENO-MAPPNING-1 (apps/api/src/kundstart/
 * EVIDENSFORMAT.md). Inga URL- eller referensfält: bevis är bytes som servern lagrar och
 * hashar själv. `scopeDeclaration` är en deklaration om omfattning, inte ett bevis.
 */
export const createOpeningEvidenceInputSchema = z.object({
  sourceSystemProduct: z.string().min(1).max(100),
  sourceCompanyKey: z.string().min(1).max(100),
  scopeDeclaration: z.string().min(1).max(2000),
  sourceName: z.string().min(1).max(200),
  sourceContent: z.string().min(1).max(900_000),
  mappingName: z.string().min(1).max(200),
  mappingContent: z.string().min(1).max(900_000),
})
export type CreateOpeningEvidenceInput = z.infer<typeof createOpeningEvidenceInputSchema>

/** POST /kundstart/opening-packages/:id/evidence/:evidenceId/review (ACCOUNTANT). */
export const reviewOpeningEvidenceInputSchema = z.object({ evidenceSha256: sha256 })
export type ReviewOpeningEvidenceInput = z.infer<typeof reviewOpeningEvidenceInputSchema>

/** Beräknas av servern; skickas aldrig in. */
export type OpeningEvidenceStatus = 'OK' | 'AVVIKELSE' | 'STOPP'

/** Ett stopp före summering (tolkning, dubblett, saknat/extra, mappning, organisation …). */
export interface OpeningEvidenceStop {
  kod: string
  fil: 'KALLA' | 'MAPPNING' | 'IMPORT' | null
  rad: number | null
  nyckel: string | null
  skal: string
}

/** En konkret differens per dokument eller per kund/avtal. Belopp i öre; null = saknas. */
export interface OpeningEvidenceDifference {
  niva: 'DOKUMENT' | 'KUND_AVTAL'
  typ: 'RECEIVABLE' | 'DEPOSIT'
  nyckel: string
  kund: string | null
  avtal: string | null
  falt: string
  kalla: string | number | null
  import: string | number | null
  skal: string
}

export interface OpeningEvidenceView {
  id: string
  evidenceVersion: number
  packageVersion: number
  formatVersion: string
  mappingFormatVersion: string
  sourceSystemProduct: string
  sourceCompanyKey: string
  sourceAsOfDate: string
  scopeDeclaration: string
  sourceName: string
  mappingName: string
  comparisonStatus: OpeningEvidenceStatus
  counts: {
    dokumentKalla: number
    dokumentImport: number
    matchade: number
    avvikelser: number
    stopp: number
  }
  stopp: OpeningEvidenceStop[]
  avvikelser: OpeningEvidenceDifference[]
  createdById: string
  createdAt: string
  evidenceSha256: string
  granskning: { reviewerUserId: string; reviewerRole: string; reviewedAt: string } | null
  /** Serverns omhashning av lagrade bytes mot sparade sha256. */
  artefaktKontroll: { kallaOk: boolean; mappningOk: boolean }
  /** Om versionen fortfarande gäller aktuellt paket, brytdatum och kopplingar. */
  giltighet: { forGranskning: boolean; forGodkannande: boolean; skal: string[] }
}

export interface OpeningEvidenceListView {
  packageId: string
  packageVersion: number
  aktuell: OpeningEvidenceView | null
  tidigare: OpeningEvidenceView[]
}
