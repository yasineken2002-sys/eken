import { get, post, patch } from '@/lib/api'

export type CollectionBucket = 'in-progress' | 'ready' | 'sent'

export interface ReminderEntry {
  type: 'REMINDER_FRIENDLY' | 'REMINDER_FORMAL' | 'READY_FOR_COLLECTION'
  sentAt: string
  feeAmount: number
}

export interface OverdueInvoice {
  id: string
  invoiceNumber: string
  status: 'OVERDUE' | 'SENT_TO_COLLECTION' | 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'VOID'
  total: number
  dueDate: string
  daysOverdue: number
  remindersPaused: boolean
  sentToCollectionAt: string | null
  tenantName: string
  tenantEmail: string | null
  reminderCount: number
  reminders: ReminderEntry[]
  lastReminderType: ReminderEntry['type'] | null
  lastReminderAt: string | null
}

export const fetchOverdueStatus = (bucket?: CollectionBucket) =>
  get<OverdueInvoice[]>(`/collections/overdue-status${bucket ? `?bucket=${bucket}` : ''}`)

export const exportSingleCollection = (invoiceId: string) =>
  post<{
    invoiceId: string
    invoiceNumber: string
    pdfUrl: string
    csvUrl: string
  }>(`/collections/export/${invoiceId}`)

export const exportBulkCollections = (invoiceIds: string[]) =>
  post<{ zipUrl: string; count: number }>('/collections/bulk-export', { invoiceIds })

export const markSentToCollection = (invoiceId: string, note?: string) =>
  post<{ id: string; status: 'SENT_TO_COLLECTION' }>(
    `/collections/mark-sent/${invoiceId}`,
    note ? { note } : {},
  )

export const pauseReminders = (invoiceId: string, reason?: string) =>
  patch<unknown>(`/collections/reminders/${invoiceId}/pause`, reason ? { reason } : {})

export const resumeReminders = (invoiceId: string) =>
  patch<unknown>(`/collections/reminders/${invoiceId}/resume`, {})
