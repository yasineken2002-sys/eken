import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { Prisma } from '@prisma/client'
import type { PaymentReminderType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { NotificationsService } from './notifications.service'

interface ProcessSummary {
  friendlySent: number
  formalSent: number
  readyForCollection: number
  errors: number
  skipped: number
}

@Injectable()
export class PaymentReminderService {
  private readonly logger = new Logger(PaymentReminderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Cron-jobb som körs dagligen kl 09:00. Itererar över alla förfallna
   * fakturor och triggar lämplig påminnelsenivå baserat på dagar sedan
   * förfall + organisationens inställningar.
   *
   * Idempotency: PaymentReminder har UNIQUE (invoiceId, type), så samma
   * påminnelsetyp kan aldrig skickas två gånger för samma faktura. En
   * cron-restart eller dubbel cron-fire blir därmed harmlös.
   */
  @Cron('0 9 * * *')
  async processOverdueReminders(): Promise<ProcessSummary> {
    const summary: ProcessSummary = {
      friendlySent: 0,
      formalSent: 0,
      readyForCollection: 0,
      errors: 0,
      skipped: 0,
    }

    const overdue = await this.prisma.invoice.findMany({
      where: {
        status: 'OVERDUE',
        remindersPaused: false,
      },
      include: {
        tenant: true,
        customer: true,
        organization: true,
        paymentReminders: true,
      },
    })

    for (const invoice of overdue) {
      try {
        const org = invoice.organization
        if (!org.remindersEnabled) {
          summary.skipped++
          continue
        }

        const party = invoice.tenant ?? invoice.customer
        if (!party?.email) {
          summary.skipped++
          continue
        }

        const daysOverdue = this.daysSince(invoice.dueDate)
        const sentTypes = new Set<PaymentReminderType>(invoice.paymentReminders.map((r) => r.type))

        // ── Dag 30+ → markera redo för inkasso ───────────────────────────
        if (daysOverdue >= org.reminderCollectionDay && !sentTypes.has('READY_FOR_COLLECTION')) {
          await this.markReadyForCollection(invoice.id, org.id, daysOverdue)
          summary.readyForCollection++
          continue
        }

        // ── Dag formal+ → formell påminnelse + 60 kr avgift ──────────────
        if (daysOverdue >= org.reminderFormalDay && !sentTypes.has('REMINDER_FORMAL')) {
          await this.sendFormalReminder(invoice, party.email, daysOverdue)
          summary.formalSent++
          continue
        }

        // ── Dag 1-7 → vänlig påminnelse, ingen avgift ────────────────────
        if (daysOverdue >= 1 && daysOverdue <= 7 && !sentTypes.has('REMINDER_FRIENDLY')) {
          await this.sendFriendlyReminder(invoice, party.email, daysOverdue)
          summary.friendlySent++
          continue
        }

        summary.skipped++
      } catch (err) {
        this.logger.error(
          `Reminder failed for invoice ${invoice.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
        summary.errors++
      }
    }

    this.logger.log(
      `Påminnelser: ${summary.friendlySent} vänliga, ${summary.formalSent} formella, ${summary.readyForCollection} markerade redo för inkasso, ${summary.errors} fel, ${summary.skipped} hoppades över`,
    )
    return summary
  }

  // ── Manuella triggers (används av AI-tools / UI) ─────────────────────────

  async pauseReminders(invoiceId: string, organizationId: string, reason?: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      throw new BadRequestException('Kan inte pausa påminnelser på en avslutad faktura')
    }
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        remindersPaused: true,
        remindersPausedAt: new Date(),
        ...(reason ? { remindersPausedReason: reason } : { remindersPausedReason: null }),
      },
    })
  }

  async resumeReminders(invoiceId: string, organizationId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        remindersPaused: false,
        remindersPausedAt: null,
        remindersPausedReason: null,
      },
    })
  }

  async getOverdueStatus(organizationId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['OVERDUE', 'SENT_TO_COLLECTION'] },
      },
      include: {
        tenant: true,
        customer: true,
        paymentReminders: { orderBy: { sentAt: 'desc' } },
      },
      orderBy: { dueDate: 'asc' },
    })

    return invoices.map((inv) => {
      const party = inv.tenant ?? inv.customer
      const daysOverdue = this.daysSince(inv.dueDate)
      const reminders = inv.paymentReminders
      const lastReminder = reminders[0] ?? null
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        total: Number(inv.total),
        dueDate: inv.dueDate,
        daysOverdue,
        remindersPaused: inv.remindersPaused,
        sentToCollectionAt: inv.sentToCollectionAt,
        tenantName: party
          ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
          : '–',
        tenantEmail: party?.email ?? null,
        reminderCount: reminders.length,
        reminders: reminders.map((r) => ({
          type: r.type,
          sentAt: r.sentAt,
          feeAmount: Number(r.feeAmount),
        })),
        lastReminderType: lastReminder?.type ?? null,
        lastReminderAt: lastReminder?.sentAt ?? null,
      }
    })
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

  private daysSince(date: Date): number {
    const now = new Date()
    const ms = now.getTime() - date.getTime()
    return Math.floor(ms / (24 * 60 * 60 * 1000))
  }

  private async sendFriendlyReminder(
    invoice: Prisma.InvoiceGetPayload<{
      include: { tenant: true; customer: true; organization: true; paymentReminders: true }
    }>,
    email: string,
    daysOverdue: number,
  ): Promise<void> {
    const party = invoice.tenant ?? invoice.customer
    const tenantName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : 'Hyresgäst'

    const messageId = await this.mail.sendReminderFriendly({
      to: email,
      tenantName,
      invoiceNumber: invoice.invoiceNumber,
      total: Number(invoice.total),
      dueDate: invoice.dueDate,
      daysOverdue,
      organizationName: invoice.organization.name,
      ocrNumber: invoice.ocrNumber,
      bankgiro: invoice.organization.bankgiro,
      idempotencyKey: `reminder-friendly-${invoice.id}`,
    })

    await this.prisma.paymentReminder.create({
      data: {
        invoiceId: invoice.id,
        type: 'REMINDER_FRIENDLY',
        feeAmount: 0,
        emailMessageId: messageId,
      },
    })

    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId: invoice.id,
        type: 'REMINDER_SENT',
        actorType: 'SYSTEM',
        actorLabel: 'Vänlig påminnelse',
        payload: { reminderType: 'REMINDER_FRIENDLY', daysOverdue, fee: 0 },
      },
    })
  }

  private async sendFormalReminder(
    invoice: Prisma.InvoiceGetPayload<{
      include: { tenant: true; customer: true; organization: true; paymentReminders: true }
    }>,
    email: string,
    daysOverdue: number,
  ): Promise<void> {
    const party = invoice.tenant ?? invoice.customer
    const tenantName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : 'Hyresgäst'

    const fee = Number(invoice.organization.reminderFeeSek)
    const originalTotal = Number(invoice.total)
    const newTotal = originalTotal + fee

    // Lägg till påminnelseavgift som ny faktura-rad och uppdatera total.
    // Använd Prisma-transaktion så avgift och total alltid skrivs atomärt.
    await this.prisma.$transaction(async (tx) => {
      await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          description: 'Påminnelseavgift enligt lag (1981:739)',
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(fee.toFixed(2)),
          vatRate: 0,
          total: new Prisma.Decimal(fee.toFixed(2)),
        },
      })
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          total: new Prisma.Decimal(newTotal.toFixed(2)),
        },
      })
    })

    // Bokför påminnelseavgift på BAS 3593 (Påminnelseavgifter)
    await this.bookReminderFee(invoice.id, invoice.organizationId, fee)

    const messageId = await this.mail.sendReminderFormal({
      to: email,
      tenantName,
      invoiceNumber: invoice.invoiceNumber,
      originalTotal,
      feeAmount: fee,
      newTotal,
      dueDate: invoice.dueDate,
      daysOverdue,
      organizationName: invoice.organization.name,
      ocrNumber: invoice.ocrNumber,
      bankgiro: invoice.organization.bankgiro,
      collectionDay: invoice.organization.reminderCollectionDay,
      idempotencyKey: `reminder-formal-${invoice.id}`,
    })

    await this.prisma.paymentReminder.create({
      data: {
        invoiceId: invoice.id,
        type: 'REMINDER_FORMAL',
        feeAmount: new Prisma.Decimal(fee.toFixed(2)),
        emailMessageId: messageId,
      },
    })

    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId: invoice.id,
        type: 'REMINDER_SENT',
        actorType: 'SYSTEM',
        actorLabel: 'Formell påminnelse',
        payload: { reminderType: 'REMINDER_FORMAL', daysOverdue, fee },
      },
    })
  }

  private async markReadyForCollection(
    invoiceId: string,
    organizationId: string,
    daysOverdue: number,
  ): Promise<void> {
    await this.prisma.paymentReminder.create({
      data: {
        invoiceId,
        type: 'READY_FOR_COLLECTION',
        feeAmount: 0,
      },
    })

    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId,
        type: 'DEBT_COLLECTION',
        actorType: 'SYSTEM',
        actorLabel: 'Markerad redo för inkasso',
        payload: { daysOverdue },
      },
    })

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { tenant: true, customer: true },
    })
    const party = invoice?.tenant ?? invoice?.customer
    const tenantName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : 'okänd hyresgäst'

    void this.notifications
      .createForAllOrgUsers(
        organizationId,
        'INVOICE_OVERDUE',
        '⚠️ Faktura redo för inkasso',
        `Faktura ${invoice?.invoiceNumber} (${tenantName}) är förfallen ${daysOverdue} dagar och redo att skickas till inkasso. Generera underlag i Inkasso-vyn.`,
        '/collections',
      )
      .catch(() => undefined)
  }

  private async bookReminderFee(
    invoiceId: string,
    organizationId: string,
    fee: number,
  ): Promise<void> {
    if (fee <= 0) return
    const accounts = await this.prisma.account.findMany({
      where: { organizationId, number: { in: [1510, 3593] } },
      select: { id: true, number: true },
    })
    const byNumber = new Map(accounts.map((a) => [a.number, a.id]))
    const receivableId = byNumber.get(1510)
    const reminderRevenueId = byNumber.get(3593)
    if (!receivableId || !reminderRevenueId) {
      this.logger.warn(
        `Saknar konto 1510 eller 3593 för organisation ${organizationId} — påminnelseavgift bokfördes inte`,
      )
      return
    }
    await this.prisma.journalEntry.create({
      data: {
        organizationId,
        date: new Date(),
        description: `Påminnelseavgift faktura ${invoiceId}`,
        source: 'INVOICE',
        sourceId: `reminder-fee:${invoiceId}`,
        lines: {
          create: [
            { accountId: receivableId, debit: fee, description: 'Påminnelseavgift fordran' },
            {
              accountId: reminderRevenueId,
              credit: fee,
              description: 'Påminnelseintäkt',
            },
          ],
        },
      },
    })
  }
}
