import { get, post } from '@/lib/api'
import type { CreateCreditNoteInput, RegisterPaymentInput, Invoice } from '@eken/shared'

export function downloadInvoicePdf(id: string): void {
  window.open(`/api/v1/invoices/${id}/pdf`, '_blank')
}

// Bokför inbetalningen på servern (likvidkonto D / 1510 K). Ersätter den gamla
// vägen som satte status PAID utan verifikat.
export function registerInvoicePayment(id: string, dto: RegisterPaymentInput): Promise<Invoice> {
  return post<Invoice>(`/invoices/${id}/pay`, dto)
}

export function sendInvoiceEmail(id: string): Promise<{ message: string }> {
  return post<{ message: string }>(`/invoices/${id}/send-email`)
}

// ── KREDITNOTA (#517) ────────────────────────────────────────────────────────

export interface CreditNotePreviewLine {
  invoiceLineId: string
  description: string
  quantity: number
  unitPrice: number
  vatRate: number
  /** Radens bruttobelopp på ursprungsfakturan. */
  invoiced: number
  /** Vad som redan krediterats av just den raden, av tidigare kreditnotor. */
  credited: number
  /** Taket för en ny kreditering av raden. Aldrig negativt. */
  remaining: number
}

/**
 * Underlaget modalen förfyller sig från.
 *
 * `allowed`/`blockedReason` kommer från SAMMA bedömning som API:et spärrar på
 * (`assessCreditability`). Gränssnittet härleder alltså inga egna villkor —
 * hade det gjort det skulle knappen förr eller senare erbjuda något servern
 * nekar, eller gömma något som faktiskt går.
 */
export interface CreditNotePreview {
  invoiceId: string
  invoiceNumber: string
  total: number
  outstanding: number
  credited: number
  allowed: boolean
  blockedReason: string | null
  lines: CreditNotePreviewLine[]
}

export interface CreateCreditNoteResult {
  creditNote: Invoice
  creditedInvoice: { id: string; invoiceNumber: string; outstanding: number }
}

export function getCreditNotePreview(id: string): Promise<CreditNotePreview> {
  return get<CreditNotePreview>(`/invoices/${id}/credit-note/preview`)
}

export function createCreditNote(
  id: string,
  dto: CreateCreditNoteInput,
): Promise<CreateCreditNoteResult> {
  return post<CreateCreditNoteResult>(`/invoices/${id}/credit-note`, dto)
}
