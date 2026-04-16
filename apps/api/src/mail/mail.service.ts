import { Injectable } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import * as nodemailer from 'nodemailer'

export interface SendInvoiceOptions {
  to: string
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  pdfBuffer: Buffer
  organizationName: string
  accentColor?: string
}

export interface SendOverdueReminderOptions {
  to: string
  tenantName: string
  invoiceNumber: string
  total: number
  dueDate: Date | string
  organizationName: string
  accentColor?: string
}

export interface SendRentIncreaseNoticeOptions {
  to: string
  tenantName: string
  currentRent: number
  newRent: number
  effectiveDate: string
  organizationName: string
  accentColor?: string
}

export interface SendMorningInsightsOptions {
  to: string
  firstName: string
  insights: string
  today: string
  organizationName: string
  accentColor?: string
}

export interface SendCustomEmailOptions {
  to: string
  subject: string
  bodyHtml: string
  tenantName: string
  organizationName: string
  accentColor?: string
}

function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function buildHtml(opts: SendInvoiceOptions): string {
  const accent = opts.accentColor ?? '#1a6b3c'
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Faktura ${opts.invoiceNumber}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; margin: 0; padding: 32px 16px; color: #1a1a1a; }
    .card { background: #ffffff; border-radius: 12px; max-width: 560px;
            margin: 0 auto; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { color: ${accent}; font-size: 20px; font-weight: 700; margin-bottom: 32px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { font-size: 15px; line-height: 1.6; color: #444; margin: 0 0 16px; }
    table { width: 100%; border-collapse: collapse; margin: 24px 0; }
    th { text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase;
         letter-spacing: 0.05em; color: #888; padding: 8px 0; border-bottom: 1px solid #eee; }
    td { padding: 12px 0; font-size: 15px; border-bottom: 1px solid #f0f0f0; }
    td.amount { font-weight: 700; font-size: 18px; color: ${accent}; }
    .footer { margin-top: 32px; font-size: 13px; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${opts.organizationName}</div>
    <h1>Faktura ${opts.invoiceNumber}</h1>
    <p>Hej ${opts.tenantName},</p>
    <p>
      Bifogat hittar du faktura <strong>${opts.invoiceNumber}</strong>
      på <strong>${formatSek(opts.total)}</strong>.
    </p>
    <table>
      <tr>
        <th>Fakturanummer</th>
        <th>Belopp</th>
        <th>Förfallodatum</th>
      </tr>
      <tr>
        <td>${opts.invoiceNumber}</td>
        <td class="amount">${formatSek(opts.total)}</td>
        <td>${formatDate(opts.dueDate)}</td>
      </tr>
    </table>
    <p>
      Vänligen betala senast <strong>${formatDate(opts.dueDate)}</strong>.
    </p>
    <p>Vänliga hälsningar,<br /><strong>${opts.organizationName}</strong></p>
    <div class="footer">
      Detta e-postmeddelande skickades automatiskt. Svara inte på detta meddelande.
    </div>
  </div>
</body>
</html>`
}

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST', 'smtp.gmail.com'),
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: false,
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASS'),
      },
    })
  }

  async sendInvoice(opts: SendInvoiceOptions): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM', '"Eken Fastigheter" <no-reply@eken.se>')

    await this.transporter.sendMail({
      from,
      to: opts.to,
      subject: `Faktura ${opts.invoiceNumber} från ${opts.organizationName}`,
      html: buildHtml(opts),
      attachments: [
        {
          filename: `faktura-${opts.invoiceNumber}.pdf`,
          content: opts.pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    })
  }

  async sendOverdueReminder(opts: SendOverdueReminderOptions): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM', '"Eken Fastigheter" <no-reply@eken.se>')
    const accent = opts.accentColor ?? '#1a6b3c'
    const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Påminnelse: Faktura ${opts.invoiceNumber}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; margin: 0; padding: 32px 16px; color: #1a1a1a; }
    .card { background: #ffffff; border-radius: 12px; max-width: 560px;
            margin: 0 auto; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { color: ${accent}; font-size: 20px; font-weight: 700; margin-bottom: 32px; }
    .badge { display: inline-block; background: #fef2f2; color: #b91c1c;
             font-size: 12px; font-weight: 600; padding: 4px 12px;
             border-radius: 9999px; margin-bottom: 20px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { font-size: 15px; line-height: 1.6; color: #444; margin: 0 0 16px; }
    .amount { font-size: 28px; font-weight: 700; color: #b91c1c; margin: 24px 0; }
    .footer { margin-top: 32px; font-size: 13px; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${opts.organizationName}</div>
    <div class="badge">Förfallen faktura</div>
    <h1>Påminnelse om obetald faktura</h1>
    <p>Hej ${opts.tenantName},</p>
    <p>
      Vi vill påminna dig om att faktura <strong>${opts.invoiceNumber}</strong>
      förföll <strong>${formatDate(opts.dueDate)}</strong> och ännu inte är betald.
    </p>
    <div class="amount">${formatSek(opts.total)}</div>
    <p>Vänligen betala det utestående beloppet snarast möjligt.
    Kontakta oss om du har frågor eller behöver hjälp.</p>
    <p>Vänliga hälsningar,<br /><strong>${opts.organizationName}</strong></p>
    <div class="footer">
      Detta e-postmeddelande skickades automatiskt. Svara inte på detta meddelande.
    </div>
  </div>
</body>
</html>`

    await this.transporter.sendMail({
      from,
      to: opts.to,
      subject: `Påminnelse: Faktura ${opts.invoiceNumber} är förfallen`,
      html,
    })
  }

  async sendMorningInsights(opts: SendMorningInsightsOptions): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM', '"Eken Fastigheter" <no-reply@eken.se>')
    const accent = opts.accentColor ?? '#1a6b3c'
    const bulletPoints = opts.insights
      .split('\n')
      .filter((line) => line.trim())
      .map(
        (line) =>
          `<li style="margin-bottom:8px;font-size:14px;color:#374151;">${line.replace(/^[-•*]\s*/, '')}</li>`,
      )
      .join('\n')
    const appUrl = this.config.get<string>('APP_URL', 'https://app.eken.se')

    const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Eken — Morgonrapport ${opts.today}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; margin: 0; padding: 32px 16px; color: #1a1a1a; }
    .card { background: #ffffff; border-radius: 12px; max-width: 560px;
            margin: 0 auto; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { color: ${accent}; font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .date { font-size: 12px; color: #9ca3af; margin-bottom: 32px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; color: #111827; }
    p { font-size: 14px; line-height: 1.6; color: #4b5563; margin: 0 0 16px; }
    ul { padding-left: 20px; margin: 20px 0; }
    .cta { display: inline-block; margin-top: 24px; background: ${accent}; color: #fff;
           text-decoration: none; padding: 10px 20px; border-radius: 8px;
           font-size: 14px; font-weight: 600; }
    .footer { margin-top: 32px; font-size: 12px; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${opts.organizationName}</div>
    <div class="date">${opts.today}</div>
    <h1>God morgon, ${opts.firstName}!</h1>
    <p>Här är vad som kräver din uppmärksamhet idag:</p>
    <ul>${bulletPoints}</ul>
    <a href="${appUrl}" class="cta">Öppna Eken →</a>
    <div class="footer">
      Detta e-postmeddelande skickades automatiskt av Eken AI. Svara inte på detta meddelande.
    </div>
  </div>
</body>
</html>`

    await this.transporter.sendMail({
      from,
      to: opts.to,
      subject: `Eken — Din morgonrapport ${opts.today}`,
      html,
    })
  }

  async sendCustomEmail(opts: SendCustomEmailOptions): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM', '"Eken Fastigheter" <no-reply@eken.se>')
    const color = opts.accentColor ?? '#2563EB'
    const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${opts.subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; margin: 0; padding: 32px 16px; color: #1a1a1a; }
    .card { background: #ffffff; border-radius: 12px; max-width: 560px;
            margin: 0 auto; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { color: ${color}; font-size: 20px; font-weight: 700; margin-bottom: 32px; }
    p { font-size: 15px; line-height: 1.6; color: #444; margin: 0 0 16px; }
    .footer { margin-top: 32px; font-size: 13px; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${opts.organizationName}</div>
    ${opts.bodyHtml}
    <p style="margin-top: 30px; color: #666; font-size: 13px;">
      Med vänliga hälsningar,<br /><strong>${opts.organizationName}</strong>
    </p>
    <div class="footer">
      Detta e-postmeddelande skickades via Eken Fastigheter.
    </div>
  </div>
</body>
</html>`

    await this.transporter.sendMail({ from, to: opts.to, subject: opts.subject, html })
  }

  async sendRentIncreaseNotice(opts: SendRentIncreaseNoticeOptions): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM', '"Eken Fastigheter" <no-reply@eken.se>')
    const accent = opts.accentColor ?? '#1a6b3c'
    const increase = opts.newRent - opts.currentRent
    const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hyreshöjning från ${opts.effectiveDate}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; margin: 0; padding: 32px 16px; color: #1a1a1a; }
    .card { background: #ffffff; border-radius: 12px; max-width: 560px;
            margin: 0 auto; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .logo { color: ${accent}; font-size: 20px; font-weight: 700; margin-bottom: 32px; }
    .badge { display: inline-block; background: #eff6ff; color: #1d4ed8;
             font-size: 12px; font-weight: 600; padding: 4px 12px;
             border-radius: 9999px; margin-bottom: 20px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { font-size: 15px; line-height: 1.6; color: #444; margin: 0 0 16px; }
    .table { width: 100%; border-collapse: collapse; margin: 24px 0; }
    .table td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .table td:last-child { text-align: right; font-weight: 600; }
    .new-rent { color: ${accent}; font-size: 26px; font-weight: 700; margin: 24px 0 4px; }
    .footer { margin-top: 32px; font-size: 13px; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${opts.organizationName}</div>
    <div class="badge">Hyreshöjning</div>
    <h1>Meddelande om hyreshöjning</h1>
    <p>Hej ${opts.tenantName},</p>
    <p>
      Vi vill informera dig om att din hyra kommer att höjas från och med
      <strong>${opts.effectiveDate}</strong> i enlighet med KPI-indexklausulen i ditt hyresavtal.
    </p>
    <table class="table">
      <tr><td>Nuvarande hyra</td><td>${formatSek(opts.currentRent)}/mån</td></tr>
      <tr><td>Höjning</td><td>+${formatSek(increase)}/mån</td></tr>
      <tr><td><strong>Ny hyra från ${opts.effectiveDate}</strong></td><td><strong>${formatSek(opts.newRent)}/mån</strong></td></tr>
    </table>
    <p>
      Observera att en hyreshöjning kräver minst 3 månaders varsel.
      Om du har frågor är du välkommen att kontakta oss.
    </p>
    <p>Vänliga hälsningar,<br /><strong>${opts.organizationName}</strong></p>
    <div class="footer">
      Detta e-postmeddelande skickades automatiskt. Svara inte på detta meddelande.
    </div>
  </div>
</body>
</html>`

    await this.transporter.sendMail({
      from,
      to: opts.to,
      subject: `Meddelande om hyreshöjning från ${opts.effectiveDate} — ${opts.organizationName}`,
      html,
    })
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify()
      return true
    } catch {
      return false
    }
  }
}
