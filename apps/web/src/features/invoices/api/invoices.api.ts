import { post } from '@/lib/api'
import type { Invoice } from '@eken/shared'

export function downloadInvoicePdf(id: string): void {
  window.open(`/api/v1/invoices/${id}/pdf`, '_blank')
}

export interface RegisterPaymentInput {
  amount: number
  paymentMethod?: string
  reference?: string
  paidAt?: string
}

// Bokför inbetalningen på servern (likvidkonto D / 1510 K). Ersätter den gamla
// vägen som satte status PAID utan verifikat.
export function registerInvoicePayment(id: string, dto: RegisterPaymentInput): Promise<Invoice> {
  return post<Invoice>(`/invoices/${id}/pay`, dto)
}

export function sendInvoiceEmail(id: string): Promise<{ message: string }> {
  return post<{ message: string }>(`/invoices/${id}/send-email`)
}
