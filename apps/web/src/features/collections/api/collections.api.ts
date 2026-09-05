import { get, post, patch } from '@/lib/api'
import type { BulkExportInput, MarkSentInput, PauseRemindersInput } from '@eken/shared'

export type CollectionBucket = 'in-progress' | 'ready' | 'sent'

export interface ReminderEntry {
  // REMINDER_AI_MANUAL = AI-verktyget `send_overdue_reminders` (mallen
  // `invoice-overdue`). Eget värde eftersom det är ett ANNAT brev än cronens
  // vänliga/formella påminnelse, och för att det inte ska räknas som ett steg i
  // kravtrappan — se PaymentReminderType i schema.prisma.
  type: 'REMINDER_FRIENDLY' | 'REMINDER_FORMAL' | 'READY_FOR_COLLECTION' | 'REMINDER_AI_MANUAL'
  sentAt: string
  feeAmount: number
}

export interface OverdueInvoice {
  id: string
  invoiceNumber: string
  status: 'OVERDUE' | 'SENT_TO_COLLECTION' | 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'VOID'
  // #352 — fakturatypen avgör om posten får bulk-exporteras. En deposition
  // syns i inkassovyn (den enskilda export-vägen finns kvar) men sveps aldrig
  // med i en batch — se `bulkSelectable` i CollectionsPage.
  type: 'RENT' | 'DEPOSIT' | 'SERVICE' | 'UTILITY' | 'OTHER'
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

// NYTTOLASTERNA ÄR ANNOTERADE med de delade typerna. Utan annotering är
// literalen en inferrerad const, och då körs ingen överskottskontroll — ett fält
// som finns här men inte i kontraktet hade passerat tyst.
export const exportBulkCollections = (invoiceIds: string[]) => {
  const kropp: BulkExportInput = { invoiceIds }
  return post<{ zipUrl: string; count: number }>('/collections/bulk-export', kropp)
}

export const markSentToCollection = (invoiceId: string, note?: string) => {
  const kropp: MarkSentInput = { ...(note ? { note } : {}) }
  return post<{ id: string; status: 'SENT_TO_COLLECTION' }>(
    `/collections/mark-sent/${invoiceId}`,
    kropp,
  )
}

export const pauseReminders = (invoiceId: string, reason?: string) => {
  const kropp: PauseRemindersInput = { ...(reason ? { reason } : {}) }
  return patch<unknown>(`/collections/reminders/${invoiceId}/pause`, kropp)
}

export const resumeReminders = (invoiceId: string) =>
  // Ingen kropp: rutten tar inget @Body().
  patch<unknown>(`/collections/reminders/${invoiceId}/resume`)
