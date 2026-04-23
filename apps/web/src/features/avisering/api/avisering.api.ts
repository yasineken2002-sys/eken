import { get, post, patch, del, api } from '@/lib/api'

export type RentNoticeStatus = 'PENDING' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED'

export interface RentNotice {
  id: string
  organizationId: string
  tenantId: string
  leaseId: string
  noticeNumber: string
  ocrNumber: string
  month: number
  year: number
  amount: number
  vatAmount: number
  totalAmount: number
  dueDate: string
  paidAt: string | null
  paidAmount: number | null
  status: RentNoticeStatus
  sentAt: string | null
  sentTo: string | null
  createdAt: string
  updatedAt: string
  tenant: {
    id: string
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName?: string | null
    lastName?: string | null
    companyName?: string | null
    email: string
    phone?: string | null
  }
  lease: {
    id: string
    unit: {
      id: string
      name: string
      property: {
        id: string
        name: string
      }
    }
  }
}

export interface GenerateResult {
  created: number
  skipped: number
  notices: RentNotice[]
}

export interface SendResult {
  sent: number
  failed: number
}

export interface AviseringStats {
  total: number
  pending: number
  sent: number
  paid: number
  overdue: number
  cancelled: number
  totalAmount: number
  paidAmount: number
  outstandingAmount: number
}

export type NoticeFilter = {
  month?: number
  year?: number
  status?: RentNoticeStatus | ''
}

export function fetchNotices(filters?: NoticeFilter) {
  const params = new URLSearchParams()
  if (filters?.month) params.set('month', String(filters.month))
  if (filters?.year) params.set('year', String(filters.year))
  if (filters?.status) params.set('status', filters.status)
  const q = params.toString()
  return get<RentNotice[]>(`/avisering${q ? `?${q}` : ''}`)
}

export function fetchStats(month: number, year: number) {
  return get<AviseringStats>(`/avisering/stats/${month}/${year}`)
}

export function fetchNotice(id: string) {
  return get<RentNotice>(`/avisering/${id}`)
}

export function generateNotices(month: number, year: number) {
  return post<GenerateResult>('/avisering/generate', { month, year })
}

export function sendNotices(noticeIds: string[]) {
  return post<SendResult>('/avisering/send', { noticeIds })
}

export function sendAllNotices(month: number, year: number) {
  return post<SendResult>(`/avisering/send-all/${month}/${year}`, {})
}

export function markAsPaid(id: string, paidAmount: number, paidAt?: string) {
  return patch<RentNotice>(`/avisering/${id}/paid`, { paidAmount, ...(paidAt ? { paidAt } : {}) })
}

export function cancelNotice(id: string) {
  return del(`/avisering/${id}`)
}

export async function downloadNoticePdf(id: string, noticeNumber: string) {
  const res = await api.get(`/avisering/${id}/pdf`, { responseType: 'blob' })
  const url = window.URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hyresavi-${noticeNumber}.pdf`
  a.click()
  window.URL.revokeObjectURL(url)
}
