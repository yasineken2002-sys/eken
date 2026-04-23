import { get, patch } from '@/lib/api'

export type NotificationType =
  | 'INVOICE_OVERDUE'
  | 'INVOICE_PAID'
  | 'LEASE_EXPIRING'
  | 'LEASE_EXPIRED'
  | 'MAINTENANCE_NEW'
  | 'MAINTENANCE_UPDATED'
  | 'RENT_NOTICE_SENT'
  | 'RENT_NOTICE_OVERDUE'
  | 'INSPECTION_SCHEDULED'
  | 'SYSTEM'

export interface Notification {
  id: string
  organizationId: string
  userId: string
  type: NotificationType
  title: string
  message: string
  link?: string | null
  read: boolean
  readAt?: string | null
  createdAt: string
}

export const fetchNotifications = (onlyUnread?: boolean) =>
  get<Notification[]>('/notifications', onlyUnread ? { unread: true } : undefined)

export const fetchUnreadCount = () => get<{ unread: number }>('/notifications/count')

export const markNotificationRead = (id: string) =>
  patch<{ count: number }>(`/notifications/${id}/read`)

export const markAllNotificationsRead = () => patch<{ count: number }>('/notifications/read-all')
