import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import type { SentMessage } from '@prisma/client'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { safeColor } from '../common/branding'
import { MailService } from '../mail/mail.service'
import { renderUserParagraphs } from '../mail/user-html'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
  return result
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildEmailHtml(
  subject: string,
  content: string,
  orgName: string,
  accentColor: string,
  tenantName?: string,
): string {
  const safeSubject = escapeHtml(subject)
  const safeOrgName = escapeHtml(orgName)
  const safeAccent = safeColor(accentColor, DEFAULT_BRAND_COLOR)
  const safeTenantName = tenantName ? escapeHtml(tenantName) : ''
  const greeting = safeTenantName ? `<p>Hej ${safeTenantName},</p>` : ''
  // Saneringen bor i mail/user-html.ts och delas med AI-vägen. Samma allowlist,
  // samma renderare — se filens docblock för varför det inte får bli två.
  const paragraphs = renderUserParagraphs(content)

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${safeSubject}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;color:#1a1a1a}
    .card{background:#fff;border-radius:12px;max-width:560px;margin:0 auto;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .logo{color:${safeAccent};font-size:20px;font-weight:700;margin-bottom:32px}
    p{font-size:15px;line-height:1.6;color:#444;margin:0 0 16px}
    .footer{margin-top:32px;font-size:13px;color:#aaa;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${safeOrgName}</div>
    ${greeting}
    ${paragraphs}
    <p style="margin-top:30px;color:#666;font-size:13px">Med vänliga hälsningar,<br><strong>${safeOrgName}</strong></p>
    <div class="footer">Detta e-postmeddelande skickades via Eveno Fastigheter.</div>
  </div>
</body>
</html>`
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  async sendToTenant(
    tenantId: string,
    organizationId: string,
    subject: string,
    content: string,
    userId: string,
  ): Promise<SentMessage> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, organizationId },
    })
    if (!tenant) throw new NotFoundException('Hyresgäst hittades inte')

    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })
    const tenantName =
      tenant.type === 'COMPANY'
        ? (tenant.companyName ?? '')
        : `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()

    const bodyHtml = buildEmailHtml(
      subject,
      content,
      org.name,
      org.invoiceColor ?? DEFAULT_BRAND_COLOR,
      tenantName,
    )

    let status: 'SENT' | 'FAILED' = 'SENT'
    let errorLog: { error: string; email: string } | null = null

    try {
      await this.mailService.sendCustomEmail({
        to: tenant.email,
        organizationId,
        subject,
        bodyHtml,
        tenantName,
        organizationName: org.name,
        accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
      })
    } catch (err) {
      status = 'FAILED'
      errorLog = { error: (err as Error).message, email: tenant.email }
    }

    return this.prisma.sentMessage.create({
      data: {
        organizationId,
        tenantId,
        sentById: userId,
        subject,
        content,
        sentToAll: false,
        recipientCount: 1,
        successCount: status === 'SENT' ? 1 : 0,
        failedCount: status === 'FAILED' ? 1 : 0,
        status,
        errorLog: (errorLog as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
      },
    })
  }

  async sendToAll(
    organizationId: string,
    subject: string,
    content: string,
    userId: string,
  ): Promise<SentMessage> {
    const tenants = await this.prisma.tenant.findMany({ where: { organizationId } })
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })

    // ETT id för hela utskicket. Raderna är per mottagare — det är enheten i
    // datan — men de hör ihop, och vyn ska kunna visa dem som ETT utskick.
    const batchId = randomUUID()

    let successCount = 0
    let failedCount = 0
    const errors: Array<{ email: string; error: string }> = []

    const batches = chunk(tenants, 10)
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i] ?? []
      await Promise.allSettled(
        batch.map(async (tenant) => {
          const tenantName =
            tenant.type === 'COMPANY'
              ? (tenant.companyName ?? '')
              : `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()

          const bodyHtml = buildEmailHtml(
            subject,
            content,
            org.name,
            org.invoiceColor ?? DEFAULT_BRAND_COLOR,
            tenantName,
          )

          // ── EN RAD PER MOTTAGARE, SKRIVEN FÖRE UTSKICKET ─────────────────
          //
          // PENDING = påbörjad, utfall okänt. Skrivs före så att en krasch mitt
          // i loopen lämnar ett spår för den mottagare där den dog — en rad
          // skriven efter hade saknats exakt då.
          const rad = await this.prisma.sentMessage.create({
            data: {
              organizationId,
              tenantId: tenant.id,
              sentById: userId,
              subject,
              content,
              // FALSE trots att utskicket är ett massutskick: fältet styr
              // `retryFailed`:s gren, och den gamla grenen läser en errorLog med
              // FLERA mottagare. En per-mottagarrad hör hemma i enkelgrenen, som
              // gör om utskicket till just den hyresgästen.
              sentToAll: false,
              recipientCount: 1,
              successCount: 0,
              failedCount: 0,
              status: 'PENDING',
              batchId,
            },
            select: { id: true },
          })

          try {
            await this.mailService.sendCustomEmail({
              to: tenant.email,
              organizationId,
              subject,
              bodyHtml,
              tenantName,
              organizationName: org.name,
              accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
            })
            successCount++
            await this.prisma.sentMessage.update({
              where: { id: rad.id },
              data: { status: 'SENT', successCount: 1 },
            })
          } catch (err) {
            failedCount++
            errors.push({ email: tenant.email, error: (err as Error).message })
            await this.prisma.sentMessage.update({
              where: { id: rad.id },
              data: {
                status: 'FAILED',
                failedCount: 1,
                errorLog: { email: tenant.email, error: (err as Error).message },
              },
            })
          }
        }),
      )
      if (i < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    const status = failedCount === 0 ? 'SENT' : successCount === 0 ? 'FAILED' : 'PARTIAL'

    // ── SAMMANFATTNINGEN PERSISTERAS INTE LÄNGRE ─────────────────────────────
    //
    // Här skrevs tidigare EN rad för N mottagare (`sentToAll: true`,
    // `recipientCount: N`). Enheten var alltså ANROPET, och det är precis felet:
    // raden kunde inte svara på "fick DEN HÄR hyresgästen sitt brev?" — bara på
    // "hur många av dem fick det?". Kraschade loopen fanns ingen rad alls.
    //
    // Raderna skrivs nu per mottagare i loopen ovan. Det här returvärdet är en
    // ren SAMMANFATTNING för anroparen och rör inte databasen.
    //
    // `id: ''` är avsiktligt: ingen ENSKILD rad representerar utskicket längre.
    // Webben grindar redan sin "försök igen"-knapp på ett sanningsenligt id
    // (`{sendResult.messageId && …}`), så knappen uteblir för massutskick — och
    // varje misslyckad mottagare har i stället sin egen rad med sin egen
    // retry-knapp i listan, vilket är mer träffsäkert än att göra om alltihop.
    return {
      id: '',
      organizationId,
      tenantId: null,
      sentById: userId,
      subject,
      content,
      sentToAll: true,
      recipientCount: tenants.length,
      successCount,
      failedCount,
      status,
      errorLog: errors.length > 0 ? (errors as Prisma.InputJsonValue) : null,
      createdAt: new Date(),
    } as SentMessage
  }

  async retryFailed(
    messageId: string,
    organizationId: string,
    userId: string,
  ): Promise<SentMessage> {
    const original = await this.prisma.sentMessage.findFirst({
      where: { id: messageId, organizationId },
      include: { tenant: { select: SAFE_TENANT_SELECT } },
    })
    if (!original) throw new NotFoundException('Meddelande hittades inte')
    if (original.status === 'SENT') throw new BadRequestException('Meddelandet är redan skickat')

    if (original.sentToAll) {
      const failedEmails = Array.isArray(original.errorLog)
        ? (original.errorLog as Array<{ email: string; error: string }>).map((e) => e.email)
        : []

      const failedTenants =
        failedEmails.length > 0
          ? await this.prisma.tenant.findMany({
              where: { organizationId, email: { in: failedEmails } },
            })
          : []

      const org = await this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
      })

      let successCount = 0
      let failedCount = 0
      const newErrors: Array<{ email: string; error: string }> = []

      for (const tenant of failedTenants) {
        const tenantName =
          tenant.type === 'COMPANY'
            ? (tenant.companyName ?? '')
            : `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()

        const bodyHtml = buildEmailHtml(
          original.subject,
          original.content,
          org.name,
          org.invoiceColor ?? DEFAULT_BRAND_COLOR,
          tenantName,
        )

        try {
          await this.mailService.sendCustomEmail({
            to: tenant.email,
            organizationId,
            subject: original.subject,
            bodyHtml,
            tenantName,
            organizationName: org.name,
            accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
          })
          successCount++
        } catch (err) {
          failedCount++
          newErrors.push({ email: tenant.email, error: (err as Error).message })
        }
      }

      const status = failedCount === 0 ? 'SENT' : successCount === 0 ? 'FAILED' : 'PARTIAL'

      return this.prisma.sentMessage.create({
        data: {
          organizationId,
          sentById: userId,
          subject: original.subject,
          content: original.content,
          sentToAll: true,
          recipientCount: failedTenants.length,
          successCount,
          failedCount,
          status,
          errorLog: newErrors.length > 0 ? (newErrors as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      })
    }

    // Single tenant retry
    if (!original.tenantId) throw new BadRequestException('Ingen hyresgäst kopplad')
    return this.sendToTenant(
      original.tenantId,
      organizationId,
      original.subject,
      original.content,
      userId,
    )
  }

  async findAll(organizationId: string) {
    return this.prisma.sentMessage.findMany({
      where: { organizationId },
      include: {
        tenant: { select: { firstName: true, lastName: true, companyName: true, email: true } },
        sentBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      // TAKET ÄR PÅ RADER, OCH RADER ÄR NUMERA PER MOTTAGARE.
      //
      // 100 räckte när ett massutskick var EN rad. Efter #633 äter ett utskick
      // till 40 hyresgäster 40 av dem, så samma tak visar plötsligt en bråkdel
      // så många UTSKICK — historiken blev grundare utan att någon bad om det.
      // Höjt så att den grupperade vyn visar ungefär lika långt bakåt som förut.
      //
      // Fortfarande ett tak, med flit: en obegränsad lista är en långsam sida
      // som blir långsammare, och paginering är en egen sak att bygga när
      // volymen kräver det.
      take: 500,
    })
  }

  async getStats(organizationId: string): Promise<{
    total: number
    sent: number
    failed: number
    partial: number
    pending: number
    totalRecipients: number
  }> {
    const [messages, agg] = await Promise.all([
      this.prisma.sentMessage.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { status: true },
      }),
      this.prisma.sentMessage.aggregate({
        where: { organizationId },
        _sum: { successCount: true },
        _count: { id: true },
      }),
    ])

    // PENDING står med. Utan den hade påbörjade-men-obekräftade utskick
    // försvunnit ur statistiken samtidigt som de räknas i `total` — och en
    // summa som inte går ihop är svårare att förstå än ett tal som är noll.
    const counts = { SENT: 0, FAILED: 0, PARTIAL: 0, PENDING: 0 }
    for (const row of messages) {
      counts[row.status] = row._count.status
    }

    return {
      total: agg._count.id,
      sent: counts.SENT,
      failed: counts.FAILED,
      partial: counts.PARTIAL,
      pending: counts.PENDING,
      totalRecipients: agg._sum.successCount ?? 0,
    }
  }
}
