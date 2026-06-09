import { Injectable } from '@nestjs/common'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { MailQueue } from './mail.queue'
import type {
  EnqueueMailOptions,
  MailCorrelation,
  MailPriority,
  TemplateName,
  TemplatePropsMap,
} from './mail.types'

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
  increasePercent: number
  effectiveDate: string
  reason: string
  organizationName: string
  // JB 12 kap 54 a § 2 st — tvingande uppgifter i hyreshöjningsmeddelande:
  // sista dag att motsätta sig (minst 2 mån från meddelandedag), hyresvärdens
  // formella postadress, och vägledning till hyresnämnden för prövning.
  objectionDeadline: string
  landlordAddress: string
  hyresnamndContact: string
  unitAddress?: string
  contactEmail?: string
  contactPhone?: string
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

export interface SendWeeklySummaryOptions {
  to: string
  firstName: string
  summary: string
  weekLabel: string
  organizationName: string
  accentColor?: string
  idempotencyKey?: string
}

export interface SendMonthlyReportOptions {
  to: string
  firstName: string
  monthLabel: string
  organizationName: string
  pdf: Buffer
  filename: string
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

export interface SendTenantWelcomeWithContractOptions {
  to: string
  tenantName: string
  organizationName: string
  activationUrl: string
  validForHours?: number
  idempotencyKey?: string
}

export interface SendTenantPortalInviteOptions {
  to: string
  tenantName: string
  organizationName: string
  activationUrl: string
  validForHours?: number
  idempotencyKey?: string
  /** Korrelation så workern kan skriva Resend-id:t till rätt hyresgäst. */
  correlation?: MailCorrelation
}

export interface SendTenantSignatureConfirmationOptions {
  to: string
  tenantName: string
  organizationName: string
  documentsUrl: string
  signedAt: string
  idempotencyKey?: string
}

export interface SendTenantActivationReminderOptions {
  to: string
  tenantName: string
  organizationName: string
  activationUrl: string
  validForHours?: number
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

export interface SendRentNoticeReminderOptions {
  to: string
  tenantName: string
  noticeNumber: string
  ocrNumber: string
  originalAmount: number
  feeAmount: number
  payableTotal: number
  dueDate: Date | string
  daysOverdue: number
  organizationName: string
  pdfBuffer: Buffer
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

  async sendTenantWelcomeWithContract(opts: SendTenantWelcomeWithContractOptions): Promise<string> {
    return this.enqueueTyped(
      'tenant-welcome-with-contract',
      'high',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        activationUrl: opts.activationUrl,
        ...(opts.validForHours !== undefined ? { validForHours: opts.validForHours } : {}),
      },
      {
        to: opts.to,
        subject: `Välkommen till ${opts.organizationName} — signera ditt kontrakt`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  /**
   * Neutral portal-inbjudan (massutskick) — ingen kontraktssignerings-text,
   * eftersom importerade hyresgäster ofta saknar kontrakts-PDF. Använder samma
   * aktiveringstoken-mekanik som välkomstmejlet (länk → välj lösenord).
   */
  async sendTenantPortalInvite(opts: SendTenantPortalInviteOptions): Promise<string> {
    return this.enqueueTyped(
      'tenant-portal-invite',
      'high',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        activationUrl: opts.activationUrl,
        ...(opts.validForHours !== undefined ? { validForHours: opts.validForHours } : {}),
      },
      {
        to: opts.to,
        subject: `${opts.organizationName} — aktivera ditt portalkonto`,
        idempotencyKey: opts.idempotencyKey,
        ...(opts.correlation ? { correlation: opts.correlation } : {}),
      },
    )
  }

  async sendTenantSignatureConfirmation(
    opts: SendTenantSignatureConfirmationOptions,
  ): Promise<string> {
    return this.enqueueTyped(
      'tenant-signature-confirmation',
      'high',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        documentsUrl: opts.documentsUrl,
        signedAt: opts.signedAt,
      },
      {
        to: opts.to,
        subject: `Kvittens — ditt hyreskontrakt hos ${opts.organizationName} är signerat`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendTenantActivationReminder(opts: SendTenantActivationReminderOptions): Promise<string> {
    return this.enqueueTyped(
      'tenant-activation-reminder',
      'high',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        activationUrl: opts.activationUrl,
        ...(opts.validForHours !== undefined ? { validForHours: opts.validForHours } : {}),
      },
      {
        to: opts.to,
        subject: `Påminnelse: aktivera ditt hyreskonto hos ${opts.organizationName}`,
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

  async sendReminderFriendly(opts: {
    to: string
    tenantName: string
    invoiceNumber: string
    total: number
    dueDate: Date | string
    daysOverdue: number
    organizationName: string
    ocrNumber?: string | null
    bankgiro?: string | null
    idempotencyKey?: string
  }): Promise<string> {
    return this.enqueueTyped(
      'reminder-friendly',
      'normal',
      {
        tenantName: opts.tenantName,
        invoiceNumber: opts.invoiceNumber,
        total: opts.total,
        dueDate: opts.dueDate,
        daysOverdue: opts.daysOverdue,
        organizationName: opts.organizationName,
        ocrNumber: opts.ocrNumber ?? null,
        bankgiro: opts.bankgiro ?? null,
      },
      {
        to: opts.to,
        subject: `Påminnelse — faktura ${opts.invoiceNumber}`,
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    )
  }

  async sendReminderFormal(opts: {
    to: string
    tenantName: string
    invoiceNumber: string
    originalTotal: number
    feeAmount: number
    newTotal: number
    dueDate: Date | string
    daysOverdue: number
    organizationName: string
    ocrNumber?: string | null
    bankgiro?: string | null
    collectionDay: number
    idempotencyKey?: string
  }): Promise<string> {
    return this.enqueueTyped(
      'reminder-formal',
      'normal',
      {
        tenantName: opts.tenantName,
        invoiceNumber: opts.invoiceNumber,
        originalTotal: opts.originalTotal,
        feeAmount: opts.feeAmount,
        newTotal: opts.newTotal,
        dueDate: opts.dueDate,
        daysOverdue: opts.daysOverdue,
        organizationName: opts.organizationName,
        ocrNumber: opts.ocrNumber ?? null,
        bankgiro: opts.bankgiro ?? null,
        collectionDay: opts.collectionDay,
      },
      {
        to: opts.to,
        subject: `Påminnelse — faktura ${opts.invoiceNumber} (avgift tillkommer)`,
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    )
  }

  async sendRentNoticeReminder(opts: SendRentNoticeReminderOptions): Promise<string> {
    const accent = opts.accentColor ?? DEFAULT_BRAND_COLOR
    const feeRow =
      opts.feeAmount > 0
        ? `<tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Påminnelseavgift</td>
              <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;text-align:right">${formatSek(opts.feeAmount)}</td></tr>`
        : ''
    const bodyHtml = `
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">
        Vi har inte registrerat någon betalning för hyresavi <strong>${opts.noticeNumber}</strong>
        som förföll ${formatDateSv(opts.dueDate)}. Vänligen betala snarast — bifogad
        påminnelse visar beloppet. En påminnelseavgift enligt lag (1981:739) har tillkommit.
      </p>
      <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px;margin:24px 0">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Ursprungligt belopp</td>
              <td style="padding:8px 0;color:#111827;font-size:14px;text-align:right">${formatSek(opts.originalAmount)}</td></tr>
          ${feeRow}
          <tr><td style="padding:8px 0;color:#111827;font-size:14px;font-weight:700;border-top:1px solid #E5E7EB">Att betala nu</td>
              <td style="padding:8px 0;color:#111827;font-size:15px;font-weight:700;text-align:right;border-top:1px solid #E5E7EB">${formatSek(opts.payableTotal)}</td></tr>
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
        preview: `Påminnelse: hyresavi ${opts.noticeNumber} — ${formatSek(opts.payableTotal)} att betala`,
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        bodyHtml,
        whyReceived: 'Du får detta mail eftersom en hyresavi hos oss är obetald och förfallen.',
      },
      {
        to: opts.to,
        subject: `Betalningspåminnelse — hyresavi ${opts.noticeNumber}`,
        attachments: [{ filename: `paminnelse-${opts.noticeNumber}.pdf`, content: opts.pdfBuffer }],
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
    )
  }

  async sendRentNotice(opts: SendRentNoticeOptions): Promise<string> {
    const accent = opts.accentColor ?? DEFAULT_BRAND_COLOR
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
    return this.enqueueTyped(
      'rent-increase-notice',
      'normal',
      {
        tenantName: opts.tenantName,
        organizationName: opts.organizationName,
        currentRent: opts.currentRent,
        newRent: opts.newRent,
        increasePercent: opts.increasePercent,
        effectiveDate: opts.effectiveDate,
        reason: opts.reason,
        objectionDeadline: opts.objectionDeadline,
        landlordAddress: opts.landlordAddress,
        hyresnamndContact: opts.hyresnamndContact,
        ...(opts.unitAddress ? { unitAddress: opts.unitAddress } : {}),
        ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
        ...(opts.contactPhone ? { contactPhone: opts.contactPhone } : {}),
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
          'Du får detta mail eftersom du har morgonrapporten aktiverad i Eveno-inställningarna.',
      },
      {
        to: opts.to,
        subject: `Eveno — Din morgonrapport ${opts.today}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendWeeklySummary(opts: SendWeeklySummaryOptions): Promise<string> {
    const bullets = opts.summary
      .split('\n')
      .filter((l) => l.trim())
      .map(
        (l) =>
          `<li style="margin-bottom:8px;font-size:14px;color:#374151">${l.replace(/^[-•*]\s*/, '')}</li>`,
      )
      .join('')

    const bodyHtml = `
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 8px">Hej ${opts.firstName}!</h2>
      <p style="color:#9CA3AF;font-size:12px;margin:0 0 16px">Veckosammanfattning — ${opts.weekLabel}</p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Här är vad som väntar under kommande vecka:
      </p>
      <ul style="padding-left:20px;margin:16px 0">${bullets}</ul>`
    return this.enqueueTyped(
      'custom',
      'low',
      {
        preview: `Veckosammanfattning ${opts.weekLabel}`,
        tenantName: opts.firstName,
        organizationName: opts.organizationName,
        bodyHtml,
        whyReceived:
          'Du får detta mail eftersom du har veckosammanfattningen aktiverad i Eveno-inställningarna.',
      },
      {
        to: opts.to,
        subject: `Eveno — Din veckosammanfattning ${opts.weekLabel}`,
        idempotencyKey: opts.idempotencyKey,
      },
    )
  }

  async sendMonthlyReport(opts: SendMonthlyReportOptions): Promise<string> {
    const bodyHtml = `
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 8px">Hej ${opts.firstName}!</h2>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Din månadsrapport för ${opts.monthLabel} är klar.
      </p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Rapporten innehåller omsättning med jämförelser, detaljerade nyckeltal,
        en genomgång per fastighet samt AI-genererade insikter och rekommendationer.
        Du hittar den som PDF-bilaga i detta mejl.
      </p>`
    return this.enqueueTyped(
      'custom',
      'low',
      {
        preview: `Månadsrapport ${opts.monthLabel}`,
        tenantName: opts.firstName,
        organizationName: opts.organizationName,
        bodyHtml,
        whyReceived:
          'Du får detta mail eftersom du har månadsrapporten aktiverad i Eveno-inställningarna.',
      },
      {
        to: opts.to,
        subject: `Eveno — Månadsrapport för ${opts.monthLabel}`,
        attachments: [{ filename: opts.filename, content: opts.pdf }],
        idempotencyKey: opts.idempotencyKey,
      },
    )
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
      correlation?: MailCorrelation | undefined
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
    if (extras.correlation) opts.correlation = extras.correlation
    return this.queue.enqueue(opts)
  }
}
