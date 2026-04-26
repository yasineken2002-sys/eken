import type { CustomProps } from './templates/base/Custom'
import type { MagicLinkProps } from './templates/auth/MagicLink'
import type { InvoiceCreatedProps } from './templates/invoices/InvoiceCreated'
import type { InvoiceReminderProps } from './templates/invoices/InvoiceReminder'
import type { InvoiceOverdueProps } from './templates/invoices/InvoiceOverdue'
import type { TenantWelcomeProps } from './templates/tenants/TenantWelcome'
import type { TenantInviteProps } from './templates/tenants/TenantInvite'
import type { MaintenanceUpdateProps } from './templates/notifications/MaintenanceUpdate'
import type { PasswordResetProps } from './templates/users/PasswordReset'
import type { UserInviteProps } from './templates/users/UserInvite'

export const TEMPLATE_NAMES = [
  'magic-link',
  'invoice-created',
  'invoice-reminder',
  'invoice-overdue',
  'tenant-welcome',
  'tenant-invite',
  'maintenance-update',
  'password-reset',
  'user-invite',
  'custom',
] as const

export type TemplateName = (typeof TEMPLATE_NAMES)[number]

export interface TemplatePropsMap {
  'magic-link': MagicLinkProps
  'invoice-created': InvoiceCreatedProps
  'invoice-reminder': InvoiceReminderProps
  'invoice-overdue': InvoiceOverdueProps
  'tenant-welcome': TenantWelcomeProps
  'tenant-invite': TenantInviteProps
  'maintenance-update': MaintenanceUpdateProps
  'password-reset': PasswordResetProps
  'user-invite': UserInviteProps
  custom: CustomProps
}

export type MailPriority = 'high' | 'normal' | 'low'

export interface MailAttachment {
  filename: string
  content: Buffer
}

export interface EnqueueMailOptions<T extends TemplateName = TemplateName> {
  template: T
  props: TemplatePropsMap[T]
  to: string
  subject: string
  priority?: MailPriority
  scheduledAt?: Date
  attachments?: MailAttachment[]
  idempotencyKey?: string
}

/**
 * Den serialiserade payload som faktiskt landar i BullMQ-jobbet.
 * Buffer-bilagor måste base64-kodas för att överleva JSON-serialiseringen.
 */
export interface MailJobPayload {
  template: TemplateName
  props: unknown
  to: string
  subject: string
  attachments?: Array<{ filename: string; contentBase64: string }>
}

export const QUEUE_HIGH = 'mail:high'
export const QUEUE_NORMAL = 'mail:normal'
export const QUEUE_LOW = 'mail:low'

export const QUEUE_BY_PRIORITY: Record<MailPriority, string> = {
  high: QUEUE_HIGH,
  normal: QUEUE_NORMAL,
  low: QUEUE_LOW,
}
