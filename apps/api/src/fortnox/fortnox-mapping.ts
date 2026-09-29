import { createHash } from 'crypto'

import {
  FORTNOX_SUPPORTED_VERSION,
  type FortnoxBookkeepIntent,
  type FortnoxCreditIntent,
  type FortnoxEventType,
  type FortnoxIntent,
  type FortnoxInvoiceIntent,
  type FortnoxOperation,
  type FortnoxPaymentIntent,
  type FortnoxTrustedContext,
} from './fortnox.types'

/**
 * Fortnox skiva 01 — REN mapping från Eveno-underlag till neutrala avsikter.
 *
 * Ingen Prisma, ingen HTTP, ingen `AccountingService`. Indata är ögonblicksbilder
 * som en FRAMTIDA inläsare ska bygga; i 01 matas de bara av prov.
 *
 * ── VAD SOM STÖDS ───────────────────────────────────────────────────────────
 *
 *   ren momsfri bostadshyra (exakt en hyresrad)     → faktura + separat bokföring
 *   betalning per ALLOKERING (beständigt id)        → betalning + separat bokföring
 *   hel kredit av obetald, okrediterad bostadsavi   → kredit + separat bokföring
 *
 * Allt annat svarar UNSUPPORTED med skäl — HELA underlaget nekas, inga rader
 * filtreras bort. Skälet är mätt i kontraktet: IMD och övriga rader bokförs
 * redan som egna verifikat internt, så en avi som exporterades "utan dem" vore
 * en annan fordran än den hyresgästen fått.
 *
 * ── VAD EN FRAMTIDA INLÄSARE MÅSTE GÖRA ─────────────────────────────────────
 *
 * `RentNoticeLine` har ingen radtyp. Komponenten ska härledas ur
 * `consumptionChargeId`/`miscChargeId` och avgifts-/räntekällan, aldrig ur
 * beskrivningstexten. Kontona kommer ur betrodd konfiguration, aldrig ur fri text.
 */

export type NoticeComponent =
  | 'RENT'
  | 'CONSUMPTION'
  | 'MISC'
  | 'REMINDER_FEE'
  | 'INTEREST'
  | 'DEPOSIT'
  | 'OTHER'

export interface NoticeLineSnapshot {
  component: NoticeComponent
  description: string
  vatRatePercent: number
  amountOre: number
}

export interface AccountMapping {
  receivableAccount: number
  revenueAccount: number
}

export interface RentNoticeSnapshot {
  organizationId: string
  noticeId: string
  immutableVersion: number
  noticeNumber: string
  /** Förkonfigurerat kundnummer i Fortnox. Inga kunder skapas i 01. */
  customerRef: string
  currency: string
  totalOre: number
  invoiceDate: string
  dueDate: string
  bookkeepingDate: string
  propertyUse: 'RESIDENTIAL' | 'COMMERCIAL'
  lines: NoticeLineSnapshot[]
  accountMapping: AccountMapping
}

export interface PaymentAllocationSnapshot {
  organizationId: string
  /** Det Fortnox-företag originalfakturan exporterades till. */
  fortnoxTenantId: string
  /** `RentNoticePayment.id` — beständigt, aldrig belopp+datum eller bankrad. */
  paymentAllocationId: string
  noticeId: string
  immutableVersion: number
  currency: string
  originalAmountOre: number
  /** Tidigare BEKRÄFTADE betalningar på fordran, exklusive denna. */
  confirmedPaidOre: number
  confirmedCreditedOre: number
  amountOre: number
  paidAt: string
  bookkeepingDate: string
}

export interface FullCreditSnapshot {
  organizationId: string
  fortnoxTenantId: string
  creditId: string
  originalNoticeId: string
  immutableVersion: number
  /** Originalets avinummer — referensen krediten kopplas till. */
  originalReference: string
  currency: string
  originalAmountOre: number
  creditAmountOre: number
  paidOre: number
  previousCreditsOre: number
  collectionHandover: boolean
  badDebt: boolean
  propertyUse: 'RESIDENTIAL' | 'COMMERCIAL'
  originalLines: NoticeLineSnapshot[]
  bookkeepingDate: string
}

export type MappingResult<T> =
  | { ok: true; intent: T }
  | { ok: false; code: 'UNSUPPORTED' | 'INVALID'; reason: string }

// ── Grundkontroller ──────────────────────────────────────────────────────────

function nej<T>(code: 'UNSUPPORTED' | 'INVALID', reason: string): MappingResult<T> {
  return { ok: false, code, reason }
}

function ärPositivtÖre(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
}

function ärIckeNegativtÖre(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
}

/** `YYYY-MM-DD` som dessutom är ett riktigt kalenderdatum. */
export function ärKalenderdatum(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function ärKonto(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1000 && n <= 8999
}

function ickeTom(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

/** Gemensamt för alla tre: version, valuta, organisation. */
function grund(
  ctx: FortnoxTrustedContext,
  u: { organizationId: string; immutableVersion: number; currency: string },
): MappingResult<never> | null {
  if (u.organizationId !== ctx.organizationId) {
    return nej('INVALID', 'underlaget tillhör en annan organisation än anslutningen')
  }
  if (u.immutableVersion !== FORTNOX_SUPPORTED_VERSION) {
    return nej(
      'UNSUPPORTED',
      `version ${String(u.immutableVersion)} stöds inte i skiva 01 — rättelse kräver egen kredit-/rättelseidentitet`,
    )
  }
  if (u.currency !== 'SEK') return nej('UNSUPPORTED', `valuta ${String(u.currency)} stöds inte`)
  return null
}

/** Nekar varje avi som inte är EN ren momsfri bostadshyresrad. */
function renBostadshyra(
  propertyUse: string,
  lines: NoticeLineSnapshot[],
): MappingResult<never> | null {
  if (propertyUse !== 'RESIDENTIAL') {
    return nej('UNSUPPORTED', 'lokal/momspliktig hyra stöds inte i skiva 01')
  }
  if (!Array.isArray(lines) || lines.length === 0) return nej('INVALID', 'avin saknar rader')
  const främmande = lines.filter((l) => l.component !== 'RENT')
  if (främmande.length > 0) {
    const typer = [...new Set(främmande.map((l) => l.component))].sort().join(', ')
    return nej(
      'UNSUPPORTED',
      `avin innehåller komponenter utanför skiva 01 (${typer}) — hela avin nekas`,
    )
  }
  if (lines.some((l) => l.vatRatePercent !== 0)) {
    return nej('UNSUPPORTED', 'momsbelagd rad stöds inte i skiva 01')
  }
  if (lines.length !== 1) return nej('UNSUPPORTED', 'flera hyresrader stöds inte i skiva 01')
  if (!ärPositivtÖre(lines[0]!.amountOre)) return nej('INVALID', 'hyresraden har ogiltigt belopp')
  return null
}

// ── Faktura ──────────────────────────────────────────────────────────────────

export function mapRentNoticeToInvoice(
  ctx: FortnoxTrustedContext,
  u: RentNoticeSnapshot,
): MappingResult<FortnoxInvoiceIntent> {
  const g = grund(ctx, u)
  if (g) return g
  const r = renBostadshyra(u.propertyUse, u.lines)
  if (r) return r
  if (!ickeTom(u.noticeId) || !ickeTom(u.noticeNumber))
    return nej('INVALID', 'avi-id/nummer saknas')
  if (!ickeTom(u.customerRef)) return nej('INVALID', 'förkonfigurerat kundnummer saknas')
  if (!ärPositivtÖre(u.totalOre)) return nej('INVALID', 'totalbelopp måste vara positiva hela ören')
  if (![u.invoiceDate, u.dueDate, u.bookkeepingDate].every(ärKalenderdatum)) {
    return nej('INVALID', 'datum måste vara giltiga YYYY-MM-DD')
  }
  const { receivableAccount, revenueAccount } = u.accountMapping ?? ({} as AccountMapping)
  if (!ärKonto(receivableAccount) || !ärKonto(revenueAccount)) {
    return nej('INVALID', 'kontomappning saknas eller är ogiltig')
  }
  const rad = u.lines[0]!
  if (rad.amountOre !== u.totalOre) return nej('INVALID', 'radsumman avviker från avins total')

  return {
    ok: true,
    intent: {
      kind: 'INVOICE',
      noticeId: u.noticeId,
      noticeNumber: u.noticeNumber,
      customerRef: u.customerRef,
      currency: 'SEK',
      invoiceDate: u.invoiceDate,
      dueDate: u.dueDate,
      bookkeepingDate: u.bookkeepingDate,
      receivableAccount,
      totalOre: u.totalOre,
      rows: [
        {
          description: rad.description,
          accountNumber: revenueAccount,
          netOre: rad.amountOre,
          vatOre: 0,
          grossOre: rad.amountOre,
        },
      ],
    },
  }
}

// ── Betalning ────────────────────────────────────────────────────────────────

export function mapPaymentAllocation(
  ctx: FortnoxTrustedContext,
  u: PaymentAllocationSnapshot,
): MappingResult<FortnoxPaymentIntent> {
  const g = grund(ctx, u)
  if (g) return g
  if (u.fortnoxTenantId !== ctx.fortnoxTenantId) {
    return nej('INVALID', 'fordran exporterades till ett annat Fortnox-företag')
  }
  if (!ickeTom(u.paymentAllocationId) || !ickeTom(u.noticeId)) {
    return nej('INVALID', 'allokerings-id/avi-id saknas')
  }
  if (!ärPositivtÖre(u.amountOre)) return nej('INVALID', 'belopp måste vara positiva hela ören')
  if (
    !ärPositivtÖre(u.originalAmountOre) ||
    !ärIckeNegativtÖre(u.confirmedPaidOre) ||
    !ärIckeNegativtÖre(u.confirmedCreditedOre)
  ) {
    return nej('INVALID', 'fordringens saldouppgifter är ogiltiga')
  }
  const kvar = u.originalAmountOre - u.confirmedPaidOre - u.confirmedCreditedOre
  if (u.amountOre > kvar) {
    return nej(
      'INVALID',
      `betalningen (${u.amountOre} öre) överstiger kvarvarande fordran (${kvar} öre)`,
    )
  }
  if (!ärKalenderdatum(u.paidAt) || !ärKalenderdatum(u.bookkeepingDate)) {
    return nej('INVALID', 'datum måste vara giltiga YYYY-MM-DD')
  }
  return {
    ok: true,
    intent: {
      kind: 'PAYMENT',
      paymentAllocationId: u.paymentAllocationId,
      noticeId: u.noticeId,
      currency: 'SEK',
      amountOre: u.amountOre,
      paidAt: u.paidAt,
      bookkeepingDate: u.bookkeepingDate,
    },
  }
}

// ── Hel kredit ───────────────────────────────────────────────────────────────

export function mapFullCredit(
  ctx: FortnoxTrustedContext,
  u: FullCreditSnapshot,
): MappingResult<FortnoxCreditIntent> {
  const g = grund(ctx, u)
  if (g) return g
  if (u.fortnoxTenantId !== ctx.fortnoxTenantId) {
    return nej('INVALID', 'originalet exporterades till ett annat Fortnox-företag')
  }
  const r = renBostadshyra(u.propertyUse, u.originalLines)
  if (r) return r
  if (!ärPositivtÖre(u.originalAmountOre) || !ärPositivtÖre(u.creditAmountOre)) {
    return nej('INVALID', 'belopp måste vara positiva hela ören')
  }
  // F01: beloppsfälten ska stämma med originalets faktiska rad. Annars blir en
  // "helkredit" med båda fälten satta lägre än raden en delkredit i förklädnad,
  // och högre en kredit större än fordran. `renBostadshyra` har redan krävt
  // exakt en hyresrad med positivt belopp.
  if (u.originalLines[0]!.amountOre !== u.originalAmountOre) {
    return nej('INVALID', 'originalbeloppet stämmer inte med originalraden')
  }
  if (u.creditAmountOre !== u.originalAmountOre) {
    return nej('UNSUPPORTED', 'delkredit stöds inte i skiva 01 — skalas aldrig upp till hel kredit')
  }
  if (u.paidOre !== 0)
    return nej('UNSUPPORTED', 'kredit av betald eller delbetald avi stöds inte i skiva 01')
  if (u.previousCreditsOre !== 0) return nej('UNSUPPORTED', 'avin är redan krediterad')
  if (u.collectionHandover) return nej('UNSUPPORTED', 'avin är överlämnad till inkasso')
  if (u.badDebt) return nej('UNSUPPORTED', 'avin är bokförd som kundförlust')
  if (!ickeTom(u.creditId) || !ickeTom(u.originalNoticeId) || !ickeTom(u.originalReference)) {
    return nej('INVALID', 'kredit-id/originalreferens saknas')
  }
  if (!ärKalenderdatum(u.bookkeepingDate))
    return nej('INVALID', 'datum måste vara giltigt YYYY-MM-DD')
  return {
    ok: true,
    intent: {
      kind: 'CREDIT',
      creditId: u.creditId,
      originalNoticeId: u.originalNoticeId,
      originalReference: u.originalReference,
      currency: 'SEK',
      amountOre: u.originalAmountOre,
      bookkeepingDate: u.bookkeepingDate,
    },
  }
}

// ── Bokföringssteg ───────────────────────────────────────────────────────────

/** Bokföringen är ett EGET steg på samma externa objekt, aldrig en del av skapandet. */
export function mapBookkeep(
  intent: FortnoxInvoiceIntent | FortnoxPaymentIntent | FortnoxCreditIntent,
): FortnoxBookkeepIntent {
  switch (intent.kind) {
    case 'INVOICE':
      return {
        kind: 'BOOKKEEP',
        of: 'INVOICE',
        sourceId: intent.noticeId,
        amountOre: intent.totalOre,
        currency: 'SEK',
      }
    case 'PAYMENT':
      return {
        kind: 'BOOKKEEP',
        of: 'PAYMENT',
        sourceId: intent.paymentAllocationId,
        amountOre: intent.amountOre,
        currency: 'SEK',
      }
    case 'CREDIT':
      return {
        kind: 'BOOKKEEP',
        of: 'CREDIT',
        sourceId: intent.creditId,
        amountOre: intent.amountOre,
        currency: 'SEK',
      }
  }
}

// ── Identitet och hash ───────────────────────────────────────────────────────

export const EVENT_TYPE_OF: Readonly<Record<FortnoxOperation, FortnoxEventType>> = {
  INVOICE_CREATE: 'RENT_NOTICE',
  INVOICE_BOOKKEEP: 'RENT_NOTICE',
  PAYMENT_CREATE: 'RENT_PAYMENT',
  PAYMENT_BOOKKEEP: 'RENT_PAYMENT',
  CREDIT_CREATE: 'RENT_CREDIT',
  CREDIT_BOOKKEEP: 'RENT_CREDIT',
}

/** Vilken avsiktsform varje operation kräver — utkorgen nekar en felparad kombination. */
export const INTENT_KIND_OF: Readonly<Record<FortnoxOperation, FortnoxIntent['kind']>> = {
  INVOICE_CREATE: 'INVOICE',
  INVOICE_BOOKKEEP: 'BOOKKEEP',
  PAYMENT_CREATE: 'PAYMENT',
  PAYMENT_BOOKKEEP: 'BOOKKEEP',
  CREDIT_CREATE: 'CREDIT',
  CREDIT_BOOKKEEP: 'BOOKKEEP',
}

/** Källidentiteten ur avsikten — samma händelse ger alltid samma sourceId. */
export function sourceIdOf(intent: FortnoxIntent): string {
  switch (intent.kind) {
    case 'INVOICE':
      return intent.noticeId
    case 'PAYMENT':
      return intent.paymentAllocationId
    case 'CREDIT':
      return intent.creditId
    case 'BOOKKEEP':
      return intent.sourceId
  }
}

/** Belopp i öre som en återläsning ska matcha mot. */
export function amountOreOf(intent: FortnoxIntent): number {
  switch (intent.kind) {
    case 'INVOICE':
      return intent.totalOre
    default:
      return intent.amountOre
  }
}

/** Kanonisk JSON: objektnycklar sorterade rekursivt, arrayordning bevarad. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function fortnoxPayloadHash(intent: FortnoxIntent): string {
  return sha256(canonicalJson(intent))
}

/**
 * Server-side händelsenyckel. Anslutningen och Fortnox-företaget ingår, så samma
 * källhändelse mot två anslutningar blir två nycklar — det är isolering, INTE ett
 * bevis för att en fordran får exporteras till båda (se PRECISERING-01).
 */
export function fortnoxEventKey(
  ctx: FortnoxTrustedContext,
  eventType: FortnoxEventType,
  sourceId: string,
  immutableVersion: number,
  operation: FortnoxOperation,
): string {
  return `fnx1:${sha256(
    canonicalJson([
      ctx.organizationId,
      ctx.connectionId,
      ctx.fortnoxTenantId,
      eventType,
      sourceId,
      immutableVersion,
      operation,
    ]),
  )}`
}
