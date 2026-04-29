import type { OnModuleInit } from '@nestjs/common'
import { Injectable, Logger } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { Cron, CronExpression } from '@nestjs/schedule'
import type { Notification, NotificationType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { AiAssistantService } from '../ai/ai-assistant.service'

type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: { tenant: true; customer: true; organization: true }
}>

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name)
  private aiService!: AiAssistantService

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    // Dynamic import breaks the TypeScript circular import chain:
    // notifications.service → ai-assistant.service → tool-executor.service → invoices.service → notifications.service
    const { AiAssistantService: AiSvc } = await import('../ai/ai-assistant.service')
    this.aiService = this.moduleRef.get<AiAssistantService>(AiSvc, { strict: false })
  }

  // ─── In-app notification CRUD ──────────────────────────────────────────────

  async create(
    organizationId: string,
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    link?: string,
  ): Promise<Notification> {
    return this.prisma.notification.create({
      data: { organizationId, userId, type, title, message, ...(link ? { link } : {}) },
    })
  }

  async createForAllOrgUsers(
    organizationId: string,
    type: NotificationType,
    title: string,
    message: string,
    link?: string,
  ): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true },
    })
    if (users.length === 0) return
    await this.prisma.notification.createMany({
      data: users.map((u) => ({
        organizationId,
        userId: u.id,
        type,
        title,
        message,
        ...(link ? { link } : {}),
      })),
    })
  }

  async findAll(
    organizationId: string,
    userId: string,
    onlyUnread?: boolean,
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        organizationId,
        userId,
        ...(onlyUnread ? { read: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  }

  async markAsRead(id: string, userId: string): Promise<{ count: number }> {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true, readAt: new Date() },
    })
  }

  async markAllAsRead(organizationId: string, userId: string): Promise<{ count: number }> {
    return this.prisma.notification.updateMany({
      where: { organizationId, userId, read: false },
      data: { read: true, readAt: new Date() },
    })
  }

  async getUnreadCount(organizationId: string, userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { organizationId, userId, read: false },
    })
  }

  @Cron('0 2 * * *')
  async deleteOld(): Promise<void> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    this.logger.log(`Deleted ${result.count} old notifications`)
  }

  // ─── Email cron jobs ───────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendOverdueReminders(): Promise<void> {
    const invoices: InvoiceWithRelations[] = await this.prisma.invoice.findMany({
      where: { status: 'OVERDUE' },
      include: { tenant: true, customer: true, organization: true },
    })

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(startOfDay)
    endOfDay.setDate(endOfDay.getDate() + 1)

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const invoice of invoices) {
      const party = invoice.tenant ?? invoice.customer
      if (!party?.email) continue

      // Idempotency-guard: hoppa över om en påminnelse redan loggats för
      // denna faktura idag (t.ex. efter server-restart eller dubbel cron-fire).
      const alreadySent = await this.prisma.invoiceEvent.findFirst({
        where: {
          invoiceId: invoice.id,
          type: 'REMINDER_SENT',
          createdAt: { gte: startOfDay, lt: endOfDay },
        },
        select: { id: true },
      })
      if (alreadySent) {
        skipped++
        continue
      }

      try {
        const tenantName = this.resolveTenantName(invoice)
        await this.mail.sendOverdueReminder({
          to: party.email,
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
    this.logger.log(`Overdue reminders: ${sent} sent, ${failed} failed, ${skipped} skipped`)
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
      include: { tenant: true, customer: true, organization: true },
    })

    for (const invoice of invoices) {
      const party = invoice.tenant ?? invoice.customer
      if (!party?.email) continue
      try {
        const tenantName = this.resolveTenantName(invoice)
        await this.mail.sendOverdueReminder({
          to: party.email,
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

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(startOfDay)
    endOfDay.setDate(endOfDay.getDate() + 1)

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const org of organizations) {
      if (org.users.length === 0) continue

      // Idempotency-guard: hoppa över om dagens rapport redan markerats som
      // skickad för denna organisation (t.ex. efter server-restart eller dubbel
      // cron-fire). Sentinel-markeringen är en SYSTEM-notification med fast
      // titel som vi kan slå upp på (organizationId + dag).
      const alreadySent = await this.prisma.notification.findFirst({
        where: {
          organizationId: org.id,
          type: 'SYSTEM',
          title: 'MORNING_INSIGHTS_SENT',
          createdAt: { gte: startOfDay, lt: endOfDay },
        },
        select: { id: true },
      })
      if (alreadySent) {
        skipped++
        continue
      }

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

        // Markera dagens rapport som hanterad oavsett om enskilda mejl misslyckats —
        // vi vill inte regenerera AI-insikter eller spamma användare vid retry.
        const markerUserId = org.users[0]?.id
        if (markerUserId) {
          await this.prisma.notification.create({
            data: {
              organizationId: org.id,
              userId: markerUserId,
              type: 'SYSTEM',
              title: 'MORNING_INSIGHTS_SENT',
              message: today,
              read: true,
              readAt: new Date(),
            },
          })
        }
      } catch (err) {
        this.logger.error(`Morning insights generation failed for org ${org.id}: ${String(err)}`)
        failed++
      }
    }

    this.logger.log(`Morning insights: ${sent} sent, ${failed} failed, ${skipped} skipped`)
  }

  private resolveTenantName(invoice: InvoiceWithRelations): string {
    const party = invoice.tenant ?? invoice.customer
    if (!party) return '–'
    if (party.type === 'INDIVIDUAL') {
      return `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim()
    }
    return party.companyName ?? party.email ?? '–'
  }
}
