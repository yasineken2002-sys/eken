/**
 * Fortnox skiva 01 — leverantörsneutral port och delade typer.
 *
 * ── VAD SKIVAN ÄR ───────────────────────────────────────────────────────────
 *
 * OANSLUTEN. Ingenting i dagens drift importerar den här katalogen, modulen
 * registreras inte i AppModule, och det finns ingen skarp adapter, ingen HTTP,
 * ingen env, ingen OAuth och ingen kryptering. Dagens interna huvudbok är den
 * enda aktiva. Kontraktet: arbete/drift-och-fortnox-20260927/CODEX-FORTNOX/
 * KONTRAKT.md v1 + PRECISERING-01.md.
 *
 * ── VAD PORTEN INTE LOVAR ───────────────────────────────────────────────────
 *
 * Fortnox officiella API dokumenterar ingen klientsatt idempotensnyckel och
 * ingen read-after-write-garanti för referenssökning. Därför finns inget
 * "exactly once" här: ett okänt utfall (timeout, förlorat svar, krasch efter
 * sändning) blir UNKNOWN och sänds ALDRIG om automatiskt. Det enda som lyfter
 * en rad ur UNKNOWN är en verifierad återläsning — och den verifieringen görs
 * av utkorgen, inte av adaptern (se `FortnoxLookupResult`).
 */

/** Serverbunden kontext. Väljs aldrig ur en klientpayload. */
export interface FortnoxTrustedContext {
  /** Evenos organisation (JWT/@OrgId — aldrig ur query/body). */
  organizationId: string
  /** Stabil identitet för anslutningen org → Fortnox-företag. */
  connectionId: string
  /**
   * Det EXTERNA företaget (Fortnox-tenant). Heter inte `tenantId` för att inte
   * förväxlas med Evenos hyresgäst (`Tenant`).
   */
  fortnoxTenantId: string
}

export const FORTNOX_OPERATIONS = [
  'INVOICE_CREATE',
  'INVOICE_BOOKKEEP',
  'PAYMENT_CREATE',
  'PAYMENT_BOOKKEEP',
  'CREDIT_CREATE',
  'CREDIT_BOOKKEEP',
] as const
export type FortnoxOperation = (typeof FORTNOX_OPERATIONS)[number]

export const FORTNOX_EVENT_TYPES = ['RENT_NOTICE', 'RENT_PAYMENT', 'RENT_CREDIT'] as const
export type FortnoxEventType = (typeof FORTNOX_EVENT_TYPES)[number]

/** Skapande-steget och dess separata bokföringssteg. Samma externa objekt. */
export const BOOKKEEP_OF: Readonly<Record<FortnoxOperation, FortnoxOperation | null>> = {
  INVOICE_CREATE: null,
  INVOICE_BOOKKEEP: 'INVOICE_CREATE',
  PAYMENT_CREATE: null,
  PAYMENT_BOOKKEEP: 'PAYMENT_CREATE',
  CREDIT_CREATE: null,
  CREDIT_BOOKKEEP: 'CREDIT_CREATE',
}

export function isBookkeepOperation(op: FortnoxOperation): boolean {
  return BOOKKEEP_OF[op] !== null
}

/** Skiva 01 har exakt en version per händelse (PRECISERING-01). */
export const FORTNOX_SUPPORTED_VERSION = 1

// ── Neutrala avsikter (ingen Fortnox-serialisering) ──────────────────────────

export interface FortnoxInvoiceRowIntent {
  description: string
  accountNumber: number
  netOre: number
  vatOre: number
  grossOre: number
}

export interface FortnoxInvoiceIntent {
  kind: 'INVOICE'
  noticeId: string
  noticeNumber: string
  customerRef: string
  currency: 'SEK'
  invoiceDate: string
  dueDate: string
  bookkeepingDate: string
  receivableAccount: number
  totalOre: number
  rows: FortnoxInvoiceRowIntent[]
}

export interface FortnoxPaymentIntent {
  kind: 'PAYMENT'
  paymentAllocationId: string
  noticeId: string
  currency: 'SEK'
  amountOre: number
  paidAt: string
  bookkeepingDate: string
}

export interface FortnoxCreditIntent {
  kind: 'CREDIT'
  creditId: string
  originalNoticeId: string
  originalReference: string
  currency: 'SEK'
  amountOre: number
  bookkeepingDate: string
}

/** Bokföringssteget pekar på sitt skapande-steg; objektet identifieras av utkorgen. */
export interface FortnoxBookkeepIntent {
  kind: 'BOOKKEEP'
  of: 'INVOICE' | 'PAYMENT' | 'CREDIT'
  sourceId: string
  amountOre: number
  currency: 'SEK'
}

export type FortnoxIntent =
  | FortnoxInvoiceIntent
  | FortnoxPaymentIntent
  | FortnoxCreditIntent
  | FortnoxBookkeepIntent

// ── Port ─────────────────────────────────────────────────────────────────────

/** Det utkorgen lämnar till adaptern för ett försök. */
export interface FortnoxCommand {
  eventKey: string
  operation: FortnoxOperation
  payload: FortnoxIntent
  payloadHash: string
  /** Föregångarens verifierade externa id. Satt för BOOKKEEP och för betalning/kredit. */
  predecessorExternalId: string | null
}

export type FortnoxSendResult =
  /** Operationen lyckades och motparten gav ett id. `booked` bara för bokföringssteg. */
  | { kind: 'ACK'; externalId: string; booked?: boolean }
  /** Bevisat EJ utförd (t.ex. 429 före mottagning). Får försökas igen senare. */
  | { kind: 'SAFE_TO_RETRY'; reason: string }
  /** 401/403/återkallat samtycke. */
  | { kind: 'AUTH'; reason: string }
  /** Känt permanent avslag utan effekt (validering). */
  | { kind: 'REJECTED'; reason: string }
  /** Timeout, förlorat svar, oklar 5xx — effekten kan ha skett. */
  | { kind: 'UNKNOWN'; reason: string }

/** En extern post som en återläsning hittade. Utkorgen avgör om den matchar. */
export interface FortnoxExternalCandidate {
  externalId: string
  fortnoxTenantId: string
  /** Referensfältet där vi lade eventKey. */
  reference: string
  amountOre: number
  currency: string
  payloadHash: string
  booked: boolean
}

export type FortnoxLookupResult =
  | { kind: 'FOUND'; candidates: FortnoxExternalCandidate[] }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNAVAILABLE'; reason: string }
  /** Operationen går inte att återläsa säkert (t.ex. enskild delbetalning). */
  | { kind: 'UNSUPPORTED'; reason: string }

export interface FortnoxLedgerPort {
  readonly name: string
  send(ctx: FortnoxTrustedContext, cmd: FortnoxCommand): Promise<FortnoxSendResult>
  lookup(ctx: FortnoxTrustedContext, cmd: FortnoxCommand): Promise<FortnoxLookupResult>
}

export const FORTNOX_PROVIDER = Symbol('FORTNOX_PROVIDER')
