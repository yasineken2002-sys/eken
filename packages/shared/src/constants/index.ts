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

// BAS account ranges
export const ACCOUNT_RANGES = {
  ASSET: { min: 1000, max: 1999 },
  LIABILITY: { min: 2000, max: 2999 },
  EQUITY: { min: 3000, max: 3999 },
  REVENUE: { min: 3000, max: 3999 },
  EXPENSE: { min: 4000, max: 8999 },
} as const

// Standard BAS accounts for real estate
export const STANDARD_ACCOUNTS = {
  RENT_REVENUE: 3010,
  VAT_OUTPUT: 2610,
  ACCOUNTS_RECEIVABLE: 1510,
  BANK: 1930,
  DEPOSIT_LIABILITY: 2350,
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
  OVERDUE: ['PARTIAL', 'PAID', 'VOID'],
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
