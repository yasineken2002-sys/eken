import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import type { Invoice, InvoiceStatus, InvoiceEventType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { InvoiceEventsService } from './invoice-events.service'
import { PdfService } from './pdf.service'
import { MailService } from '../mail/mail.service'
import { AccountingService } from '../accounting/accounting.service'
import { NotificationsService } from '../notifications/notifications.service'
import { isValidTransition } from '@eken/shared'
import { CreateInvoiceDto } from './dto/create-invoice.dto'
import { UpdateInvoiceDto } from './dto/update-invoice.dto'
import { BulkInvoiceDto } from './dto/bulk-invoice.dto'

// Mappar InvoiceStatus → Prisma InvoiceEventType enum-värde
const STATUS_TO_EVENT_TYPE: Partial<Record<InvoiceStatus, InvoiceEventType>> = {
  SENT: 'SENT',
  PARTIAL: 'PAYMENT_PARTIAL',
  PAID: 'PAYMENT_RECEIVED',
  OVERDUE: 'OVERDUE',
  VOID: 'VOIDED',
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: InvoiceEventsService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
    private readonly accountingService: AccountingService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ── Queries ────────────────────────────────────────────────────────────────

  async findAll(
    organizationId: string,
    filters?: {
      status?: InvoiceStatus
      tenantId?: string
    },
  ) {
    return this.prisma.invoice.findMany({
      where: {
        organizationId,
        ...(filters?.status && { status: filters.status }),
        ...(filters?.tenantId && { tenantId: filters.tenantId }),
      },
      include: {
        lines: true,
        tenant: {
          select: { id: true, firstName: true, lastName: true, companyName: true, type: true },
        },
        bankTransactions: {
          where: { status: 'MATCHED' },
          select: { id: true, date: true, amount: true, description: true, rawOcr: true },
          orderBy: { date: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        lines: true,
        tenant: true,
        lease: true,
        events: { orderBy: { createdAt: 'asc' } },
        bankTransactions: {
          where: { status: 'MATCHED' },
          orderBy: { date: 'desc' },
        },
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    return invoice
  }

  async getTimeline(id: string, organizationId: string) {
    // Verifiera att fakturan tillhör organisationen
    await this.findOne(id, organizationId)
    return this.eventsService.getTimeline(id)
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async generateInvoiceNumber(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const year = new Date().getFullYear()
    const count = await tx.invoice.count({ where: { organizationId } })
    return `F-${year}-${String(count + 1).padStart(4, '0')}`
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async create(organizationId: string, actorId: string, dto: CreateInvoiceDto): Promise<Invoice> {
    // Hämta avtalet org-scopat. unit.property.organizationId är källan till sanning
    // (Lease saknar eget organizationId-fält).
    const lease = await this.prisma.lease.findFirst({
      where: {
        id: dto.leaseId,
        unit: { property: { organizationId } },
      },
      select: { id: true, status: true, tenantId: true },
    })
    if (!lease) throw new NotFoundException('Hyresavtal hittades inte')
    if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
      throw new BadRequestException('Endast aktiva eller utkast-avtal kan faktureras')
    }

    const invoice = await this.prisma.$transaction(async (tx) => {
      const invoiceNumber = await this.generateInvoiceNumber(organizationId, tx)

      // Beräkna belopp server-side (lita aldrig på klienten)
      const subtotal = dto.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
      const vatTotal = dto.lines.reduce(
        (s, l) => s + l.quantity * l.unitPrice * (l.vatRate / 100),
        0,
      )
      const total = subtotal + vatTotal

      const created = await tx.invoice.create({
        data: {
          organizationId,
          invoiceNumber,
          type: dto.type,
          status: 'DRAFT',
          tenantId: lease.tenantId,
          leaseId: lease.id,
          subtotal,
          vatTotal,
          total,
          dueDate: new Date(dto.dueDate),
          issueDate: new Date(dto.issueDate),
          ...(dto.reference != null ? { reference: dto.reference } : {}),
          ...(dto.notes != null ? { notes: dto.notes } : {}),
          lines: {
            createMany: {
              data: dto.lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                vatRate: l.vatRate,
                total: l.quantity * l.unitPrice * (1 + l.vatRate / 100),
              })),
            },
          },
        },
      })

      await this.eventsService.record(
        created.id,
        'CREATED',
        'USER',
        actorId,
        { invoiceNumber: created.invoiceNumber },
        { tx },
      )

      return created
    })

    // Fire-and-forget: create accounting journal entry
    void this.prisma.invoice
      .findUnique({ where: { id: invoice.id }, include: { lines: true } })
      .then((invoiceWithLines) => {
        if (!invoiceWithLines) return
        return this.accountingService.createJournalEntryForInvoice(
          invoiceWithLines,
          organizationId,
          actorId,
        )
      })
      .catch((err) => console.error('[invoices] accounting journal entry failed:', err))

    return invoice
  }

  async createBulk(
    organizationId: string,
    actorId: string,
    dto: BulkInvoiceDto,
  ): Promise<{ created: number; skipped: number; errors: string[] }> {
    const leases = await this.prisma.lease.findMany({
      where: {
        status: 'ACTIVE',
        unit: { property: { organizationId } },
        ...(dto.leaseIds?.length ? { id: { in: dto.leaseIds } } : {}),
      },
      include: {
        tenant: true,
        unit: { include: { property: true } },
      },
    })

    let created = 0
    let skipped = 0
    const errors: string[] = []

    const issueStart = startOfMonth(dto.issueDate)
    const issueEnd = endOfMonth(dto.issueDate)
    const description = dto.description ?? formatBulkMonth(dto.issueDate)

    for (const lease of leases) {
      if (!lease.tenant.email) {
        skipped++
        continue
      }

      const duplicate = await this.prisma.invoice.findFirst({
        where: {
          leaseId: lease.id,
          issueDate: { gte: issueStart, lte: issueEnd },
        },
        select: { id: true },
      })
      if (duplicate) {
        skipped++
        continue
      }

      const createDto: CreateInvoiceDto = {
        type: 'RENT',
        leaseId: lease.id,
        issueDate: dto.issueDate,
        dueDate: dto.dueDate,
        lines: [
          {
            description,
            quantity: 1,
            unitPrice: Number(lease.monthlyRent),
            vatRate: (dto.vatRate ?? 0) as 0 | 6 | 12 | 25,
          },
        ],
      }

      try {
        const invoice = await this.create(organizationId, actorId, createDto)
        created++

        if (dto.sendEmail) {
          void this.sendInvoiceEmail(invoice.id, organizationId, actorId).catch((err) =>
            console.error('[bulk-invoices] email failed for', invoice.id, err),
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Kontrakt ${lease.id}: ${msg}`)
      }
    }

    return { created, skipped, errors }
  }

  async update(
    id: string,
    organizationId: string,
    actorId: string,
    dto: UpdateInvoiceDto,
  ): Promise<Invoice> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan redigeras')
    }

    return this.prisma.$transaction(async (tx) => {
      const updateData: Prisma.InvoiceUncheckedUpdateInput = {}

      if (dto.type != null) updateData.type = dto.type
      // tenantId kan aldrig ändras manuellt – det härleds alltid från leaseId.
      if (dto.leaseId != null) {
        const lease = await tx.lease.findFirst({
          where: { id: dto.leaseId, unit: { property: { organizationId } } },
          select: { id: true, status: true, tenantId: true },
        })
        if (!lease) throw new NotFoundException('Hyresavtal hittades inte')
        if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
          throw new BadRequestException('Endast aktiva eller utkast-avtal kan faktureras')
        }
        updateData.leaseId = lease.id
        updateData.tenantId = lease.tenantId
      }
      if (dto.dueDate != null) updateData.dueDate = new Date(dto.dueDate)
      if (dto.issueDate != null) updateData.issueDate = new Date(dto.issueDate)
      if (dto.reference != null) updateData.reference = dto.reference
      if (dto.notes != null) updateData.notes = dto.notes

      if (dto.lines && dto.lines.length > 0) {
        // Ta bort alla befintliga rader och skapa nya (replace-all)
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } })

        const subtotal = dto.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
        const vatTotal = dto.lines.reduce(
          (s, l) => s + l.quantity * l.unitPrice * (l.vatRate / 100),
          0,
        )
        const total = subtotal + vatTotal

        updateData.subtotal = subtotal
        updateData.vatTotal = vatTotal
        updateData.total = total
        updateData.lines = {
          createMany: {
            data: dto.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              vatRate: l.vatRate,
              total: l.quantity * l.unitPrice * (1 + l.vatRate / 100),
            })),
          },
        }
      }

      const updated = await tx.invoice.update({
        where: { id },
        data: updateData,
      })

      await this.eventsService.record(id, 'UPDATED', 'USER', actorId, {}, { tx })

      return updated
    })
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan tas bort. Makulera istället.')
    }

    await this.prisma.invoice.delete({ where: { id } })
  }

  /**
   * Statusövergång med state machine-validering.
   *
   * Faktura-raden och event-raden skrivs i samma transaktion.
   * Om något felar rullar båda tillbaka – status och historik hålls alltid i sync.
   */
  async transitionStatus(
    id: string,
    organizationId: string,
    newStatus: InvoiceStatus,
    actorId: string | null,
    actorType: 'USER' | 'SYSTEM',
    payload: Record<string, unknown> = {},
  ): Promise<Invoice> {
    const result = await this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, organizationId },
        select: { id: true, status: true, invoiceNumber: true },
      })
      if (!invoice) throw new NotFoundException('Faktura hittades inte')

      if (!isValidTransition(invoice.status as InvoiceStatus, newStatus)) {
        throw new BadRequestException(`Ogiltig statusövergång: ${invoice.status} → ${newStatus}`)
      }

      const updated = await tx.invoice.update({
        where: { id },
        data: {
          status: newStatus,
          // exactOptionalPropertyTypes: null för att rensa fältet, undefined utelämnar det
          ...(newStatus === 'PAID' ? { paidAt: new Date() } : {}),
        },
      })

      const eventType = STATUS_TO_EVENT_TYPE[newStatus]
      if (eventType) {
        await this.eventsService.record(
          id,
          eventType,
          actorType,
          actorId,
          { previousStatus: invoice.status, newStatus, ...payload },
          { tx },
        )
      }

      return updated
    })

    if (newStatus === 'PAID') {
      void this.notificationsService
        .createForAllOrgUsers(
          organizationId,
          'INVOICE_PAID',
          'Faktura betald',
          `Faktura ${result.invoiceNumber} har betalats`,
          '/invoices',
        )
        .catch((err) => this.logger.error(`Notification error: ${String(err)}`))
    }

    return result
  }

  /**
   * Registrera att en inloggad användare har öppnat fakturan i systemet.
   * Fire-and-forget – påverkar aldrig API-svaret.
   */
  recordView(invoiceId: string, actorId: string): void {
    this.eventsService
      .record(invoiceId, 'VIEWED_BY_USER', 'USER', actorId, {})
      .catch((err) => console.error('[invoices] view tracking error', err))
  }

  /**
   * Generera PDF och skicka faktura via e-post till hyresgästen.
   * Om fakturan är DRAFT övergår den till SENT automatiskt.
   */
  async sendInvoiceEmail(id: string, organizationId: string, userId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: { lines: true, tenant: true, organization: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    if (invoice.status === 'VOID' || invoice.status === 'PAID') {
      throw new BadRequestException('Fakturan kan inte skickas i nuvarande status')
    }

    // Generate PDF
    const pdfBuffer = await this.pdfService.generateInvoicePdf(id, organizationId)

    const tenantName =
      invoice.tenant.type === 'INDIVIDUAL'
        ? [invoice.tenant.firstName, invoice.tenant.lastName].filter(Boolean).join(' ')
        : (invoice.tenant.companyName ?? invoice.tenant.email)

    try {
      await this.mailService.sendInvoice({
        to: invoice.tenant.email,
        tenantName,
        invoiceNumber: invoice.invoiceNumber,
        total: Number(invoice.total),
        dueDate: invoice.dueDate,
        pdfBuffer,
        organizationName: invoice.organization.name,
        accentColor: invoice.organization.invoiceColor ?? '#1a6b3c',
      })
    } catch {
      throw new BadRequestException('E-post kunde inte skickas. Kontrollera SMTP-inställningar.')
    }

    // Transition DRAFT → SENT
    if (invoice.status === 'DRAFT') {
      await this.transitionStatus(id, organizationId, 'SENT', userId, 'USER')
    } else {
      // Record send event without status transition
      await this.eventsService.record(id, 'SENT', 'USER', userId, {
        sentTo: invoice.tenant.email,
      })
    }
  }
}

// ── Bulk helpers (file-private) ───────────────────────────────────────────────

function formatBulkMonth(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('sv-SE', {
    month: 'long',
    year: 'numeric',
  })
}

function startOfMonth(dateStr: string): Date {
  const d = new Date(dateStr)
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(dateStr: string): Date {
  const d = new Date(dateStr)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}
