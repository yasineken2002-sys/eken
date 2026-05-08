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

// Strukturerad referens till entiteten en notis handlar om. Frontend mappar
// `relatedEntityType` → Route och använder `relatedEntityId` för att öppna
// rätt detaljvy. `link` behålls för bakåtkompatibilitet med äldre rader.
export type RelatedEntityType =
  | 'MAINTENANCE_TICKET'
  | 'INVOICE'
  | 'LEASE'
  | 'TENANT'
  | 'DEPOSIT'
  | 'RENT_INCREASE'
  | 'TERMINATION_REQUEST'

export interface NotificationTarget {
  link?: string
  relatedEntityType?: RelatedEntityType
  relatedEntityId?: string
}

function buildTargetPatch(target: NotificationTarget | undefined): {
  link?: string
  relatedEntityType?: string
  relatedEntityId?: string
} {
  if (!target) return {}
  const out: { link?: string; relatedEntityType?: string; relatedEntityId?: string } = {}
  if (target.link) out.link = target.link
  if (target.relatedEntityType) out.relatedEntityType = target.relatedEntityType
  if (target.relatedEntityId) out.relatedEntityId = target.relatedEntityId
  return out
}

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

  // `link` är legacy-fältet (URL-sträng). För nya notiser passas istället
  // `relatedEntityType` + `relatedEntityId` så att frontend kan resolva rätt
  // detaljvy via en typ→Route-mappning. `link` behålls bakåtkompatibelt
  // tills alla rader backfillats / cron-rensats.
  async create(
    organizationId: string,
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    target?: NotificationTarget,
  ): Promise<Notification> {
    return this.prisma.notification.create({
      data: {
        organizationId,
        userId,
        type,
        title,
        message,
        ...buildTargetPatch(target),
      },
    })
  }

  async createForAllOrgUsers(
    organizationId: string,
    type: NotificationType,
    title: string,
    message: string,
    target?: NotificationTarget,
  ): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true },
    })
    if (users.length === 0) return
    const patch = buildTargetPatch(target)
    await this.prisma.notification.createMany({
      data: users.map((u) => ({
        organizationId,
        userId: u.id,
        type,
        title,
        message,
        ...patch,
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

  /**
   * @deprecated Det tiered påminnelseflödet (vänlig → formell → redo för
   * inkasso) ligger i PaymentReminderService.processOverdueReminders och
   * körs kl 09:00. Den här metoden behålls bara för manuella anrop via
   * sendOverdueRemindersForOrg — cron-triggern är borttagen så samma
   * faktura inte får två mejl per dag.
   */
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

    const now = new Date()
    const today = now.toLocaleDateString('sv-SE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    // Stabil dagsnyckel i lokal tid — basen för idempotency på både sentinel
    // och Resend. Använder sv-SE → "YYYY-MM-DD".
    const dayKey = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const org of organizations) {
      if (org.users.length === 0) continue

      // Atomic sentinel-lås: skriv markeringen FÖRE mejlen skickas, med ett
      // deterministiskt id (organizationId + dag). Lyckas insert → vi äger
      // dagens utskick. Faller på unique-violation (P2002) → en annan replica
      // / cron-fire har redan tagit jobbet, hoppa över. Detta löser race
      // condition mellan check-then-act i föregående version.
      const sentinelId = `morning-insights-${org.id}-${dayKey}`
      const markerUserId = org.users[0]?.id
      if (!markerUserId) continue

      try {
        await this.prisma.notification.create({
          data: {
            id: sentinelId,
            organizationId: org.id,
            userId: markerUserId,
            type: 'SYSTEM',
            title: 'MORNING_INSIGHTS_SENT',
            message: today,
            read: true,
            readAt: now,
          },
        })
      } catch (err) {
        // P2002: unique constraint på id → annan process har redan låst dagen.
        const code = (err as { code?: string }).code
        if (code === 'P2002') {
          skipped++
          continue
        }
        this.logger.error(`Sentinel-lås misslyckades för org ${org.id}: ${String(err)}`)
        failed++
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
              // Stabil nyckel per (org, user, dag) — Bull-jobId dedupar dubbla
              // enqueues, och Resend dedupar dubbla worker-körningar (24h-fönster).
              idempotencyKey: `morning-insights-${org.id}-${user.id}-${dayKey}`,
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
