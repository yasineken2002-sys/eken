// Svenska momssatser. 0% och 25% är de två som faktiskt används för
// fastigheter (bostadshyra är momsbefriad, lokalhyra med frivillig
// skattskyldighet är 25%). 6% och 12% finns i listan eftersom de kan
// förekomma vid extern fakturering (t.ex. tidskrifter, livsmedel) men
// får ALDRIG användas för bostadshyra.
export const VAT_RATES = [0, 6, 12, 25] as const
export type VatRate = (typeof VAT_RATES)[number]

// Per Mervärdesskattelagen (1994:200): bostadshyra är momsbefriad. Lokalhyra
// kan vara momsbefriad eller 25% beroende på frivillig skattskyldighet.
export const VAT_RATE_RESIDENTIAL_RENT = 0
export const VAT_RATE_COMMERCIAL_RENT_TAXED = 25

/**
 * Returnerar tillåten momssats för en hyrestyp. Bostad får aldrig moms.
 * Lokal kan ha 0% (utan frivillig skattskyldighet) eller 25%.
 */
export function getVatRateForUnitType(unitType: string, taxedCommercial = false): VatRate {
  switch (unitType) {
    case 'APARTMENT':
      return 0
    case 'OFFICE':
    case 'RETAIL':
    case 'STORAGE':
      return taxedCommercial ? 25 : 0
    case 'PARKING':
      // Parkering till hyresgäst i samma fastighet följer bostaden (0%);
      // separat parkering till utomstående är 25%. Default till 0% här.
      return 0
    default:
      return 0
  }
}

export const DEFAULT_NOTICE_PERIOD_MONTHS = 3
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export const CURRENCY = 'SEK'
export const LOCALE = 'sv-SE'

// BAS 2024 — kontoklass-intervall (H5, verifierat av Auktoriserad
// Redovisningskonsult mot accounting.service.ts + bas-chart.ts).
// OBS: eget kapital är INTE ett eget intervall — det ligger inom klass 2
// (2000–2999) men vilken delmängd beror på företagsform (AB 2080–2099,
// enskild firma 2010–2019 osv). Se bas-chart.ts. Därför ingen EQUITY-nyckel:
// en konstant `EQUITY: 3000–3999` (intäkter) var ett BAS-fundamentalt fel.
export const ACCOUNT_CLASS_RANGES = {
  ASSET: { min: 1000, max: 1999 },
  LIABILITY: { min: 2000, max: 2999 }, // inkl. eget kapital
  REVENUE: { min: 3000, max: 3999 },
  EXPENSE: { min: 4000, max: 8999 },
} as const

// Hyresintäktskonton per upplåtelsetyp (ML 3 kap 2 §, BAS 2024). Det finns
// INGEN enskild "RENT_REVENUE" — bostad får aldrig moms, lokal/p-plats kan.
// Den auktoritativa mappningen är accounting.service.ts:revenueAccountForUnitType();
// dessa konstanter är referensvärden, bokför aldrig direkt mot ett enda konto.
export const RENT_REVENUE_ACCOUNTS = {
  APARTMENT: 3911, // Hyresintäkter, bostäder (0 % moms)
  PARKING: 3912, // Hyresintäkter, parkering (25 % moms)
  OFFICE: 3913, // Hyresintäkter, lokaler (0 % eller 25 % vid frivillig skattskyldighet)
  RETAIL: 3913, // Hyresintäkter, lokaler (samma konto som OFFICE)
  STORAGE: 3914, // Hyresintäkter, övrigt/förråd
  OTHER: 3914, // Hyresintäkter, övrigt (fallback)
} as const

// Övriga standardkonton för fastighetsförvaltning (BAS 2024). Speglar exakt
// de accountByNumber.get()-anrop som finns i accounting.service.ts efter FIX 9.
export const CORE_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: 1510, // Kundfordringar
  CASH: 1910, // Kassa (kontant)
  BANK: 1930, // Företagskonto / bank
  DEPOSIT_LIABILITY: 2890, // Mottagna depositioner (kortfristig skuld)
  VAT_OUTPUT_25: 2611, // Utgående moms 25 %
  VAT_OUTPUT_12: 2621, // Utgående moms 12 %
  VAT_OUTPUT_6: 2631, // Utgående moms 6 %
  DAMAGE_REVENUE: 3040, // Skadeersättningar (depositionsavdrag)
} as const

export const USER_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const

// ─── Invoice Event Types ──────────────────────────────────────────────────────

export const INVOICE_EVENT_TYPES = [
  'invoice.created',
  'invoice.updated',
  'invoice.sent',
  'invoice.send_failed',
  'invoice.email_queued',
  'invoice.email_delivered',
  'invoice.email_bounced',
  'invoice.email_spam',
  'invoice.email_opened',
  'invoice.pdf_viewed',
  'invoice.payment_received',
  'invoice.payment_partial',
  'invoice.payment_reversed',
  'invoice.overdue',
  'invoice.reminder_sent',
  'invoice.debt_collection',
  'invoice.voided',
  'invoice.credit_note_created',
  'invoice.note_added',
  'invoice.viewed_by_user',
] as const

// ─── Invoice State Machine ─────────────────────────────────────────────────
// Giltiga statusövergångar. Terminala statusar (PAID, VOID) har tomma arrayer.
// Samma approach som Stripe använder internt.

import type { InvoiceStatus, InvoiceEventType } from '../types'

export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ['SENT', 'VOID'],
  SENT: ['PARTIAL', 'PAID', 'OVERDUE', 'VOID'],
  PARTIAL: ['PAID', 'OVERDUE', 'VOID'],
  OVERDUE: ['PARTIAL', 'PAID', 'VOID', 'SENT_TO_COLLECTION'],
  SENT_TO_COLLECTION: ['PAID', 'VOID'],
  PAID: [],
  VOID: [],
}

export function isValidTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false
}

// Mappar statusövergång → händelsetyp som loggas
export const STATUS_TO_EVENT: Partial<Record<InvoiceStatus, InvoiceEventType>> = {
  SENT: 'invoice.sent',
  PARTIAL: 'invoice.payment_partial',
  PAID: 'invoice.payment_received',
  OVERDUE: 'invoice.overdue',
  VOID: 'invoice.voided',
}

// PDF-/dokumentvarumärke (default-färg, typsnittsval + font-stackar). Steg 3 PR 1.
export * from './branding'

// SaaS-plans & AI-anropstak. Definitionen ligger i plans.ts för läsbarhet.
export * from './plans'

// Plattformens juridiska identitet + versionsmärkta dokument
export * from './platform'

// Edit-lås på ACTIVE-hyresavtal (T1.1) — delad fält-lista backend↔frontend
export * from './lease-edit-lock'
