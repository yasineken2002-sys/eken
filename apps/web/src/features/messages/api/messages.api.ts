import { get, post } from '@/lib/api'

export interface SentMessage {
  id: string
  organizationId: string
  tenantId: string | null
  sentById: string
  subject: string
  content: string
  sentToAll: boolean
  recipientCount: number
  successCount: number
  failedCount: number
  status: 'SENT' | 'FAILED' | 'PARTIAL'
  errorLog: Array<{ email: string; error: string }> | null
  createdAt: string
  tenant: {
    firstName: string | null
    lastName: string | null
    companyName: string | null
    email: string
  } | null
  sentBy: { firstName: string; lastName: string }
}

export interface MessageStats {
  total: number
  sent: number
  failed: number
  partial: number
  totalRecipients: number
}

export interface SendMessagePayload {
  tenantId?: string
  sendToAll?: boolean
  subject: string
  content: string
}

export const sendMessage = (payload: SendMessagePayload) =>
  post<SentMessage>('/messages/send', payload)

export const retryMessage = (id: string) => post<SentMessage>(`/messages/${id}/retry`, {})

export const getMessages = () => get<SentMessage[]>('/messages')

export const getMessageStats = () => get<MessageStats>('/messages/stats')
