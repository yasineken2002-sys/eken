import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { MailService } from '../mail/mail.service'
import type { AiAssistantService } from '../ai/ai-assistant.service'

type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: { tenant: true; organization: true }
}>

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private aiService: AiAssistantService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendOverdueReminders(): Promise<void> {
    const invoices: InvoiceWithRelations[] = await this.prisma.invoice.findMany({
      where: { status: 'OVERDUE' },
      include: { tenant: true, organization: true },
    })

    let sent = 0
    let failed = 0

    for (const invoice of invoices) {
      if (!invoice.tenant.email) continue
      try {
        const tenantName = this.resolveTenantName(invoice)
        await this.mail.sendOverdueReminder({
          to: invoice.tenant.email,
          tenantName,
          invoiceNumber: invoice.invoiceNumber,
          total: Number(invoice.total),
          dueDate: invoice.dueDate,
          organizationName: invoice.organization.name,
          accentColor: invoice.organization.invoiceColor ?? '#1a6b3c',
        })

        await this.prisma.invoiceEvent.create({
          data: {
            invoiceId: invoice.id,
            type: 'REMINDER_SENT',
            actorType: 'SYSTEM',
            actorLabel: 'Automatisk påminnelse',
            payload: {},
          },
        })
        sent++
      } catch (err) {
        this.logger.error(`Failed to send reminder for invoice ${invoice.id}: ${String(err)}`)
        failed++
      }
    }
    this.logger.log(`Overdue reminders: ${sent} sent, ${failed} failed`)
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async markOverdueInvoices(): Promise<void> {
    const now = new Date()
    const result = await this.prisma.invoice.updateMany({
      where: { status: 'SENT', dueDate: { lt: now } },
      data: { status: 'OVERDUE' },
    })
    this.logger.log(`Marked ${result.count} invoices as OVERDUE`)
  }

  async sendOverdueRemindersForOrg(organizationId: string): Promise<void> {
    const invoices: InvoiceWithRelations[] = await this.prisma.invoice.findMany({
      where: { organizationId, status: 'OVERDUE' },
      include: { tenant: true, organization: true },
    })

    for (const invoice of invoices) {
      if (!invoice.tenant.email) continue
      try {
        const tenantName = this.resolveTenantName(invoice)
        await this.mail.sendOverdueReminder({
          to: invoice.tenant.email,
          tenantName,
          invoiceNumber: invoice.invoiceNumber,
          total: Number(invoice.total),
          dueDate: invoice.dueDate,
          organizationName: invoice.organization.name,
          accentColor: invoice.organization.invoiceColor ?? '#1a6b3c',
        })
      } catch (err) {
        this.logger.error(`Failed: ${String(err)}`)
      }
    }
  }

  @Cron('0 7 * * 1-5')
  async sendMorningInsights(): Promise<void> {
    const organizations = await this.prisma.organization.findMany({
      include: {
        users: { where: { role: { in: ['OWNER', 'ADMIN'] }, isActive: true } },
      },
    })

    const today = new Date().toLocaleDateString('sv-SE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    let sent = 0
    let failed = 0

    for (const org of organizations) {
      if (org.users.length === 0) continue
      try {
        const insights = await this.aiService.generateDailyInsights(org.id)
        if (!insights) continue

        for (const user of org.users) {
          if (!user.email) continue
          try {
            await this.mail.sendMorningInsights({
              to: user.email,
              firstName: user.firstName,
              insights,
              today,
              organizationName: org.name,
              accentColor: org.invoiceColor ?? '#1a6b3c',
            })
            sent++
          } catch (err) {
            this.logger.error(`Morning insights email failed for ${user.email}: ${String(err)}`)
            failed++
          }
        }
      } catch (err) {
        this.logger.error(`Morning insights generation failed for org ${org.id}: ${String(err)}`)
        failed++
      }
    }

    this.logger.log(`Morning insights: ${sent} sent, ${failed} failed`)
  }

  private resolveTenantName(invoice: InvoiceWithRelations): string {
    if (invoice.tenant.type === 'INDIVIDUAL') {
      return `${invoice.tenant.firstName ?? ''} ${invoice.tenant.lastName ?? ''}`.trim()
    }
    return invoice.tenant.companyName ?? invoice.tenant.email
  }
}
