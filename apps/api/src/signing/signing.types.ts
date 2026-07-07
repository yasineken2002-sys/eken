/**
 * DocumentSigningProvider — provider-agnostisk port för dokument-signering
 * (dedikerad e-signering: Scrive/Assently). EGEN port, skild från en framtida
 * BankIdProvider (inloggning) — de delar bara en intern broker-transport, inte
 * detta interface. Modellerad på den RIKARE envelope/flerpart/förseglad-PDF-
 * abstraktionen så att både en broker-BankID-sign-adapter (gör mer internt) och en
 * Scrive-envelope-adapter kan implementera den utan att kärnan rörs.
 *
 * S1: bara Stub (inert) + Mock (test). Skarp Scrive-adapter i S3 (kräver avtal/nycklar).
 */

/** DI-token för den valda providern (Stub/Mock/Scrive via useFactory). */
export const SIGNING_PROVIDER = Symbol('SIGNING_PROVIDER')

export type SignerRoleT = 'LANDLORD' | 'TENANT'

export interface SigningPartyInput {
  role: SignerRoleT
  name: string
  email?: string
  // Blind-index (HMAC) — endast personen med detta personnr får signera sloten.
  // Undefined = ingen förhandsbindning (t.ex. okänt personnr på tenant-raden).
  expectedPersonalNumberHash?: string
}

export interface CreateSigningRequestInput {
  documentId: string
  contentHash: string // FRYST — det parterna signerar
  storageKey: string // R2-nyckel till den frusna PDF:en (för providers som laddar upp)
  parties: SigningPartyInput[]
  visibleText: string // "Jag signerar hyreskontrakt {ref} ({adress})"
  idempotencyKey: string // = sha256(documentId + contentHash)
}

/** Rå bevis-payload som providern returnerar per signerad part. */
export interface ProviderPartyEvidence {
  role: SignerRoleT
  signerName: string
  personalNumber: string // rått — servicen krypterar/blind-indexerar OMEDELBART
  orderRef: string
  signedContentHash: string // MÅSTE matcha request.contentHash (verifieras i servicen)
  signaturePayload?: string
  certificate?: string
  signedAt: Date
  ip?: string
  userAgent?: string
}

export type ProviderPartyStatus = 'pending' | 'signed' | 'declined'

export type ProviderOverallStatus =
  | 'pending'
  | 'in_progress'
  | 'partially_signed'
  | 'completed'
  | 'declined'
  | 'expired'
  | 'error'

export interface ProviderStatusResult {
  overall: ProviderOverallStatus
  parties: Array<{
    role: SignerRoleT
    status: ProviderPartyStatus
    evidence?: ProviderPartyEvidence
  }>
}

export interface SealedDocument {
  bytes: Buffer
  hasEvidencePage: boolean
}

export interface WebhookVerification {
  valid: boolean
  providerRequestId?: string
}

export interface DocumentSigningProvider {
  /** Namn som lagras på SigningRequest.provider ('STUB' | 'MOCK' | 'SCRIVE' | …). */
  readonly name: string

  /** Skapar en signerings-envelope hos leverantören. Returnerar dess request-id. */
  createRequest(
    input: CreateSigningRequestInput,
  ): Promise<{ providerRequestId: string; invites: Array<{ role: SignerRoleT; url?: string }> }>

  /** Aktuell status + per-part-bevis (för färdiga parter). */
  getStatus(providerRequestId: string): Promise<ProviderStatusResult>

  /** Förseglad PDF som bytes (core lagrar i R2 — adaptern skriver ALDRIG R2 själv). */
  fetchSealed(providerRequestId: string): Promise<SealedDocument | null>

  cancel(providerRequestId: string): Promise<void>

  /** Verifierar en inkommande webhook-signatur (leverantörens callback). */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer): WebhookVerification
}
