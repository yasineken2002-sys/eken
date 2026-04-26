import { Injectable } from '@nestjs/common'
import { MailQueue } from './mail.queue'
import type { EnqueueMailOptions, MailPriority, TemplateName, TemplatePropsMap } from './mail.types'

// ── Public option-types — bevaras för bakåtkompabilitet med befintliga callers ─

export interface SendInvoiceOptions {
  to: string
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  pdfBuffer: Buffer
  organizationName: string
  accentColor?: string
  idempotencyKey?: string
}

export interface SendOverdueReminderOptions {
  to: string
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  organizationName: string
  accentColor?: string
  idempotencyKey?: string
}

export interface SendRentIncreaseNoticeOptions {
  to: string
  tenantName: string
  currentRent: number
  newRent: number
  effectiveDate: string
  organizationName: string
  accentColor?: string
  idempotencyKey?: string
}

export interface SendMorningInsightsOptions {
  to: string
  firstName: string
  insights: string
  today: string
  organizationName: string
  accentColor?: string
  idempotencyKey?: string
}

export interface SendCustomEmailOptions {
  to: string
  subject: string
  bodyHtml: string
  tenantName: string
  organizationName: string
  accentColor?: string
  idempotencyKey?: string
}

export interface SendMagicLinkOptions {
  to: string
  tenantName: string
  magicUrl: string
  organizationName: string
  validForHours?: number
  idempotencyKey?: string
}

export interface SendTenantInviteOptions {
  to: string
  tenantName: string
  magicUrl: string
  organizationName: string
  idempotencyKey?: string
}

export interface SendPasswordResetOptions {
  to: string
  recipientName: string
  resetUrl: string
  organizationName: string
  validForHours?: number
  idempotencyKey?: string
}

export interface SendUserInviteOptions {
  to: string
  recipientName: string
  roleLabel: string
  invitedBy: string
  acceptUrl: string
  organizationName: string
  validForDays?: number
  idempotencyKey?: string
}

export interface SendTenantWelcomeOptions {
  to: string
  tenantName: string
  organizationName: string
  unitAddress?: string
  moveInDate?: Date | string
  idempotencyKey?: string
}

export interface SendInvoiceReminderOptions {
  to: string
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  organizationName: string
  idempotencyKey?: string
}

export interface SendMaintenanceUpdateOptions {
  to: string
  tenantName: string
  organizationName: string
  ticketNumber: string
  ticketTitle: string
  newStatus: 'Mottagen' | 'Pågående' | 'Schemalagd' | 'Avslutad' | 'Stängd' | 'Avbruten'
  comment?: string
  portalUrl?: string
  idempotencyKey?: string
}

export interface SendRentNoticeOptions {
  to: string
  tenantName: string
  ocrNumber: string
  amount: number
  dueDate: Date | string
  pdfBuffer: Buffer
  organizationName: string
  noticeNumber: string
  accentColor?: string
  idempotencyKey?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDateSv(d: Date | string): string {
  return new Date(d).toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

@Injectable()
export class MailService {
  constructor(private readonly queue: MailQueue) {}

  /**
   * Generisk enqueue — exponeras för avancerad användning, t.ex. om man vill
   * sätta `scheduledAt` eller välja prioritet uttryckligen.
   */
  async enqueue<T extends TemplateName>(opts: EnqueueMailOptions<T>): Promise<string> {
    return this.queue.enqueue(opts)
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  async sendMagicLink(opts: SendMagicLinkOptions): Promise<string> {
    return this.enqueueTyped(
      'magic-link',
      'high',
      {
        tenantName: opts.tenantName,
        magicUrl: opts.magicUrl,
        organizationName: opts.organizationName,
        ...(opts.validForHours !== undefined ? { validForHours: opts.validForHours } : {}),
      },
      {
        to: opts.to,
        subject: `Din inloggningslänk till ${opts.organizationName}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendTenantInvite(opts: SendTenantInviteOptions): Promise<string> {
    return this.enqueueTyped(
      'tenant-invite',
      'high',
      {
        tenantName: opts.tenantName,
        magicUrl: opts.magicUrl,
        organizationName: opts.organizationName,
      },
      {
        to: opts.to,
        subject: `Du är inbjuden till hyresgästportalen — ${opts.organizationName}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendTenantWelcome(opts: SendTenantWelcomeOptions): Promise<string> {
    return this.enqueueTyped(
      'tenant-welcome',
      'normal',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        ...(opts.unitAddress !== undefined ? { unitAddress: opts.unitAddress } : {}),
        ...(opts.moveInDate !== undefined ? { moveInDate: opts.moveInDate } : {}),
      },
      {
        to: opts.to,
        subject: `Välkommen som hyresgäst hos ${opts.organizationName}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  // ── Användarhantering ────────────────────────────────────────────────────────

  async sendPasswordReset(opts: SendPasswordResetOptions): Promise<string> {
    return this.enqueueTyped(
      'password-reset',
      'high',
      {
        recipientName: opts.recipientName,
        resetUrl: opts.resetUrl,
        organizationName: opts.organizationName,
        ...(opts.validForHours !== undefined ? { validForHours: opts.validForHours } : {}),
      },
      {
        to: opts.to,
        subject: `Återställ ditt lösenord — ${opts.organizationName}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendUserInvite(opts: SendUserInviteOptions): Promise<string> {
    return this.enqueueTyped(
      'user-invite',
      'high',
      {
        recipientName: opts.recipientName,
        roleLabel: opts.roleLabel,
        invitedBy: opts.invitedBy,
        acceptUrl: opts.acceptUrl,
        organizationName: opts.organizationName,
        ...(opts.validForDays !== undefined ? { validForDays: opts.validForDays } : {}),
      },
      {
        to: opts.to,
        subject: `Du är inbjuden till ${opts.organizationName}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  // ── Fakturor & avier ─────────────────────────────────────────────────────────

  async sendInvoice(opts: SendInvoiceOptions): Promise<string> {
    return this.enqueueTyped(
      'invoice-created',
      'normal',
      {
        tenantName: opts.tenantName,
        invoiceNumber: opts.invoiceNumber,
        total: opts.total,
        dueDate: opts.dueDate,
        organizationName: opts.organizationName,
      },
      {
        to: opts.to,
        subject: `Faktura ${opts.invoiceNumber} från ${opts.organizationName}`,
        attachments: [{ filename: `faktura-${opts.invoiceNumber}.pdf`, content: opts.pdfBuffer }],
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendInvoiceReminder(opts: SendInvoiceReminderOptions): Promise<string> {
    return this.enqueueTyped(
      'invoice-reminder',
      'normal',
      {
        tenantName: opts.tenantName,
        invoiceNumber: opts.invoiceNumber,
        total: opts.total,
        dueDate: opts.dueDate,
        organizationName: opts.organizationName,
      },
      {
        to: opts.to,
        subject: `Påminnelse: Faktura ${opts.invoiceNumber} förfaller snart`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendOverdueReminder(opts: SendOverdueReminderOptions): Promise<string> {
    return this.enqueueTyped(
      'invoice-overdue',
      'normal',
      {
        tenantName: opts.tenantName,
        invoiceNumber: opts.invoiceNumber,
        total: opts.total,
        dueDate: opts.dueDate,
        organizationName: opts.organizationName,
      },
      {
        to: opts.to,
        subject: `Förfallen faktura ${opts.invoiceNumber}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendRentNotice(opts: SendRentNoticeOptions): Promise<string> {
    const accent = opts.accentColor ?? '#2563EB'
    const bodyHtml = `
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">
        Bifogat hittar du din hyresavi <strong>${opts.noticeNumber}</strong>. Ange OCR-numret vid betalning.
      </p>
      <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px;margin:24px 0">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Belopp</td>
              <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;text-align:right">${formatSek(opts.amount)}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Förfaller</td>
              <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;text-align:right">${formatDateSv(opts.dueDate)}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">OCR-nummer</td>
              <td style="padding:8px 0;text-align:right">
                <span style="font-family:monospace;font-weight:700;color:${accent};background:#EFF6FF;padding:6px 12px;border-radius:6px;letter-spacing:0.06em">${opts.ocrNumber}</span>
              </td></tr>
        </table>
      </div>`
    return this.enqueueTyped(
      'custom',
      'normal',
      {
        preview: `Hyresavi ${opts.noticeNumber} — ${formatSek(opts.amount)} förfaller ${formatDateSv(opts.dueDate)}`,
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        bodyHtml,
        whyReceived: 'Du får detta mail eftersom du har ett aktivt hyresavtal hos oss.',
      },
      {
        to: opts.to,
        subject: `Hyresavi ${opts.noticeNumber} — förfaller ${formatDateSv(opts.dueDate)}`,
        attachments: [{ filename: `hyresavi-${opts.noticeNumber}.pdf`, content: opts.pdfBuffer }],
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendRentIncreaseNotice(opts: SendRentIncreaseNoticeOptions): Promise<string> {
    const increase = opts.newRent - opts.currentRent
    const bodyHtml = `
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 16px">Meddelande om hyreshöjning</h2>
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">Hej ${opts.tenantName},</p>
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">
        Din hyra kommer att höjas från och med <strong>${opts.effectiveDate}</strong>
        i enlighet med KPI-indexklausulen i ditt hyresavtal.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:24px 0">
        <tr><td style="padding:10px;border-bottom:1px solid #E5E7EB;font-size:14px">Nuvarande hyra</td>
            <td style="padding:10px;border-bottom:1px solid #E5E7EB;font-size:14px;text-align:right;font-weight:600">${formatSek(opts.currentRent)}/mån</td></tr>
        <tr><td style="padding:10px;border-bottom:1px solid #E5E7EB;font-size:14px">Höjning</td>
            <td style="padding:10px;border-bottom:1px solid #E5E7EB;font-size:14px;text-align:right;font-weight:600">+${formatSek(increase)}/mån</td></tr>
        <tr><td style="padding:10px;font-size:14px"><strong>Ny hyra från ${opts.effectiveDate}</strong></td>
            <td style="padding:10px;font-size:14px;text-align:right;font-weight:700">${formatSek(opts.newRent)}/mån</td></tr>
      </table>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        En hyreshöjning kräver minst 3 månaders varsel. Hör av dig om du har frågor.
      </p>`
    return this.enqueueTyped(
      'custom',
      'normal',
      {
        preview: `Meddelande om hyreshöjning från ${opts.effectiveDate}`,
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        bodyHtml,
        whyReceived:
          'Du får detta mail eftersom du har ett aktivt hyresavtal med en KPI-indexklausul.',
      },
      {
        to: opts.to,
        subject: `Meddelande om hyreshöjning från ${opts.effectiveDate} — ${opts.organizationName}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  // ── Notiser & generisk e-post ────────────────────────────────────────────────

  async sendMaintenanceUpdate(opts: SendMaintenanceUpdateOptions): Promise<string> {
    return this.enqueueTyped(
      'maintenance-update',
      'normal',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        ticketNumber: opts.ticketNumber,
        ticketTitle: opts.ticketTitle,
        newStatus: opts.newStatus,
        ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
        ...(opts.portalUrl !== undefined ? { portalUrl: opts.portalUrl } : {}),
      },
      {
        to: opts.to,
        subject: `Uppdatering på ärende ${opts.ticketNumber}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendCustomEmail(opts: SendCustomEmailOptions): Promise<string> {
    return this.enqueueTyped(
      'custom',
      'low',
      {
        preview: opts.subject,
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        bodyHtml: opts.bodyHtml,
      },
      {
        to: opts.to,
        subject: opts.subject,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendMorningInsights(opts: SendMorningInsightsOptions): Promise<string> {
    const bullets = opts.insights
      .split('\n')
      .filter((l) => l.trim())
      .map(
        (l) =>
          `<li style="margin-bottom:8px;font-size:14px;color:#374151">${l.replace(/^[-•*]\s*/, '')}</li>`,
      )
      .join('')

    const bodyHtml = `
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 8px">God morgon, ${opts.firstName}!</h2>
      <p style="color:#9CA3AF;font-size:12px;margin:0 0 16px">${opts.today}</p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Här är vad som kräver din uppmärksamhet idag:
      </p>
      <ul style="padding-left:20px;margin:16px 0">${bullets}</ul>`
    return this.enqueueTyped(
      'custom',
      'low',
      {
        preview: `Morgonrapport ${opts.today}`,
        tenantName: opts.firstName,
        organizationName: opts.organizationName,
        bodyHtml,
        whyReceived:
          'Du får detta mail eftersom du har morgonrapporten aktiverad i Eken-inställningarna.',
      },
      {
        to: opts.to,
        subject: `Eken — Din morgonrapport ${opts.today}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  // ── Hälsokontroll ────────────────────────────────────────────────────────────

  async verifyConnection(): Promise<boolean> {
    return true
  }

  // ── Privat helper ────────────────────────────────────────────────────────────

  private async enqueueTyped<T extends TemplateName>(
    template: T,
    priority: MailPriority,
    props: TemplatePropsMap[T],
    extras: {
      to: string
      subject: string
      attachments?: { filename: string; content: Buffer }[]
      idempotencyKey?: string | undefined
    },
  ): Promise<string> {
    const opts: EnqueueMailOptions<T> = {
      template,
      props,
      to: extras.to,
      subject: extras.subject,
      priority,
    }
    if (extras.attachments) opts.attachments = extras.attachments
    if (extras.idempotencyKey) opts.idempotencyKey = extras.idempotencyKey
    return this.queue.enqueue(opts)
  }
}
