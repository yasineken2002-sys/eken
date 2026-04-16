import { post } from '@/lib/api'

export function downloadInvoicePdf(id: string): void {
  window.open(`/api/v1/invoices/${id}/pdf`, '_blank')
}

export function sendInvoiceEmail(id: string): Promise<{ message: string }> {
  return post<{ message: string }>(`/invoices/${id}/send-email`)
}

export interface BulkInvoiceInput {
  issueDate: string
  dueDate: string
  description?: string
  vatRate?: number
  sendEmail?: boolean
  leaseIds?: string[]
}

export interface BulkInvoiceResult {
  created: number
  skipped: number
  errors: string[]
}

export function createBulkInvoices(dto: BulkInvoiceInput): Promise<BulkInvoiceResult> {
  return post<BulkInvoiceResult>('/invoices/bulk', dto)
}
