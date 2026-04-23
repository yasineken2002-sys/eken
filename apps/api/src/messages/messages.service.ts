import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import type { SentMessage } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
  return result
}

function buildEmailHtml(
  subject: string,
  content: string,
  orgName: string,
  accentColor: string,
  tenantName?: string,
): string {
  const greeting = tenantName ? `<p>Hej ${tenantName},</p>` : ''
  const paragraphs = content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `<p>${l}</p>`)
    .join('\n')

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${subject}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;color:#1a1a1a}
    .card{background:#fff;border-radius:12px;max-width:560px;margin:0 auto;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .logo{color:${accentColor};font-size:20px;font-weight:700;margin-bottom:32px}
    p{font-size:15px;line-height:1.6;color:#444;margin:0 0 16px}
    .footer{margin-top:32px;font-size:13px;color:#aaa;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${orgName}</div>
    ${greeting}
    ${paragraphs}
    <p style="margin-top:30px;color:#666;font-size:13px">Med vänliga hälsningar,<br><strong>${orgName}</strong></p>
    <div class="footer">Detta e-postmeddelande skickades via Eken Fastigheter.</div>
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
      org.invoiceColor ?? '#2563EB',
      tenantName,
    )

    let status: 'SENT' | 'FAILED' = 'SENT'
    let errorLog: { error: string; email: string } | null = null

    try {
      await this.mailService.sendCustomEmail({
        to: tenant.email,
        subject,
        bodyHtml,
        tenantName,
        organizationName: org.name,
        accentColor: org.invoiceColor ?? '#2563EB',
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
            org.invoiceColor ?? '#2563EB',
            tenantName,
          )

          try {
            await this.mailService.sendCustomEmail({
              to: tenant.email,
              subject,
              bodyHtml,
              tenantName,
              organizationName: org.name,
              accentColor: org.invoiceColor ?? '#2563EB',
            })
            successCount++
          } catch (err) {
            failedCount++
            errors.push({ email: tenant.email, error: (err as Error).message })
          }
        }),
      )
      if (i < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    const status = failedCount === 0 ? 'SENT' : successCount === 0 ? 'FAILED' : 'PARTIAL'

    return this.prisma.sentMessage.create({
      data: {
        organizationId,
        sentById: userId,
        subject,
        content,
        sentToAll: true,
        recipientCount: tenants.length,
        successCount,
        failedCount,
        status,
        errorLog: errors.length > 0 ? (errors as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    })
  }

  async retryFailed(
    messageId: string,
    organizationId: string,
    userId: string,
  ): Promise<SentMessage> {
    const original = await this.prisma.sentMessage.findFirst({
      where: { id: messageId, organizationId },
      include: { tenant: true },
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
          org.invoiceColor ?? '#2563EB',
          tenantName,
        )

        try {
          await this.mailService.sendCustomEmail({
            to: tenant.email,
            subject: original.subject,
            bodyHtml,
            tenantName,
            organizationName: org.name,
            accentColor: org.invoiceColor ?? '#2563EB',
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
      take: 100,
    })
  }

  async getStats(organizationId: string): Promise<{
    total: number
    sent: number
    failed: number
    partial: number
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

    const counts = { SENT: 0, FAILED: 0, PARTIAL: 0 }
    for (const row of messages) {
      counts[row.status] = row._count.status
    }

    return {
      total: agg._count.id,
      sent: counts.SENT,
      failed: counts.FAILED,
      partial: counts.PARTIAL,
      totalRecipients: agg._sum.successCount ?? 0,
    }
  }
}
