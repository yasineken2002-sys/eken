import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import type { Invoice, InvoiceStatus, InvoiceEventType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { InvoiceEventsService } from './invoice-events.service'
import { PdfService } from './pdf.service'
import { MailService } from '../mail/mail.service'
import { AccountingService, vatRateForRent } from '../accounting/accounting.service'
import { NotificationsService } from '../notifications/notifications.service'
import { isValidTransition } from '@eken/shared'
import { CreateInvoiceDto } from './dto/create-invoice.dto'
import { UpdateInvoiceDto } from './dto/update-invoice.dto'
import { BulkInvoiceDto } from './dto/bulk-invoice.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'

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
    private readonly ocrService: OcrService,
    private readonly pdfQueue: PdfQueue,
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
        customer: {
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
        tenant: { select: SAFE_TENANT_SELECT },
        customer: true,
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
  ): Promise<{ invoiceNumber: string; sequence: number }> {
    const year = new Date().getFullYear()
    // Atomär, race-säker allokering via InvoiceNumberSequence (ML 11 kap 8 §:
    // fortlöpande nummerserie). Tidigare count()+1 kunde dela ut samma nummer
    // vid samtidiga anrop och lämna hål vid rollback. UPSERT med increment ger
    // Postgres row-lock; eftersom allokeringen sker i samma transaktion som
    // fakturan skapas blir serien gap-free. Numret är globalt per org (året i
    // F-{år}-{nr} är kosmetiskt) — det bevarar OCR-unikheten som härleds ur
    // sekvensen.
    const row = await tx.invoiceNumberSequence.upsert({
      where: { organizationId },
      create: { organizationId, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })
    const sequence = row.lastNumber
    return {
      invoiceNumber: `F-${year}-${String(sequence).padStart(4, '0')}`,
      sequence,
    }
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async create(organizationId: string, actorId: string, dto: CreateInvoiceDto): Promise<Invoice> {
    // XOR: exakt en av leaseId / customerId. CHECK-constraint i DB är sista
    // försvarslinjen — vi vill ge tydligt fel innan vi når dit.
    const hasLease = dto.leaseId != null
    const hasCustomer = dto.customerId != null
    if (hasLease === hasCustomer) {
      throw new BadRequestException(
        'Faktura måste vara kopplad till antingen hyresavtal eller extern kund — inte båda eller ingen',
      )
    }

    let leaseTenantId: string | null = null
    let leaseId: string | null = null
    let customerId: string | null = null

    if (hasLease) {
      // Hämta avtalet org-scopat. unit.property.organizationId är källan till sanning
      // (Lease saknar eget organizationId-fält).
      const lease = await this.prisma.lease.findFirst({
        where: {
          id: dto.leaseId!,
          unit: { property: { organizationId } },
        },
        select: {
          id: true,
          status: true,
          tenantId: true,
          unit: { select: { type: true, voluntaryTaxLiability: true } },
        },
      })
      if (!lease) throw new NotFoundException('Hyresavtal hittades inte')
      if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
        throw new BadRequestException('Endast aktiva eller utkast-avtal kan faktureras')
      }

      // Momskontroll (ML 1994:200): en momsfri upplåtelse får inte faktureras
      // med moms. Bostad (APARTMENT) är alltid undantagen (ML 3 kap 2 §); lokal
      // utan frivillig skattskyldighet likaså. Annars skulle felaktig moms
      // debiteras hyresgästen och redovisas till staten.
      const allowedVatRate = vatRateForRent(lease.unit.type, lease.unit.voluntaryTaxLiability)
      if (allowedVatRate === 0) {
        // Momsfri upplåtelse får inte faktureras med moms.
        const offending = dto.lines.find((l) => l.vatRate !== 0)
        if (offending) {
          throw new BadRequestException(
            lease.unit.type === 'APARTMENT'
              ? 'Bostadshyra är undantagen från moms enligt ML 3 kap 2 § — vatRate måste vara 0'
              : 'Lokalen saknar frivillig skattskyldighet — hyran är momsfri (ML 3 kap 3 § 2 st). ' +
                  'Sätt frivillig skattskyldighet på enheten eller använd vatRate 0.',
          )
        }
      } else {
        // Omvänd kontroll: en i lag momspliktig upplåtelse får inte faktureras
        // momsfritt — det vore underredovisning av utgående moms till staten.
        const offending = dto.lines.find((l) => l.vatRate !== allowedVatRate)
        if (offending) {
          throw new BadRequestException(
            lease.unit.type === 'PARKING'
              ? `Parkeringsplats är momspliktig enligt ML 3 kap 3 § 5 — vatRate måste vara ${allowedVatRate}`
              : `Lokalen har frivillig skattskyldighet — vatRate måste vara ${allowedVatRate} (ML 9 kap)`,
          )
        }
      }

      leaseId = lease.id
      leaseTenantId = lease.tenantId
    } else {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId!, organizationId },
        select: { id: true, isActive: true },
      })
      if (!customer) throw new NotFoundException('Kunden hittades inte')
      if (!customer.isActive) {
        throw new BadRequestException('Kunden är arkiverad och kan inte faktureras')
      }
      customerId = customer.id
    }

    const invoice = await this.prisma.$transaction(async (tx) => {
      const { invoiceNumber, sequence } = await this.generateInvoiceNumber(organizationId, tx)

      // Auto-generera Luhn-validerat OCR från fakturasekvensen.
      // Lagras alltid på Invoice.ocrNumber. Reference defaultar till OCR
      // om klienten inte angett egen referens.
      const ocrNumber = this.ocrService.generateForInvoiceSequence(sequence)
      const reference = dto.reference != null ? dto.reference : ocrNumber

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
          ocrNumber,
          reference,
          type: dto.type,
          status: 'DRAFT',
          tenantId: leaseTenantId,
          leaseId,
          customerId,
          subtotal,
          vatTotal,
          total,
          dueDate: new Date(dto.dueDate),
          issueDate: new Date(dto.issueDate),
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
        // H3: hämta med rader direkt i transaktionen — bokföringen behöver dem,
        // och vi slipper den extra findUnique-rundturen som fanns tidigare.
        include: { lines: true },
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

    // H3 (BFL 5 kap 6 §): bokför intäktsverifikatet SYNKRONT med try/catch —
    // samma mönster som AviseringService.bookRentNoticeRevenue. Tidigare var
    // detta ett fire-and-forget `void ...catch(log)`: om bokföringen kastade
    // (saknad kontoplan, DB-glapp) fanns fakturan kvar UTAN journalpost och
    // utan återhämtning — ett BFL-gap. Saknad kontoplan loggas fortfarande
    // (avin/fakturan är redan skapad) men felet blir nu synligt i request-
    // kedjan i stället för att tystna i en bortglömd promise.
    try {
      await this.accountingService.createJournalEntryForInvoice(invoice, organizationId, actorId)
    } catch (err) {
      this.logger.error(
        `Accounting journal entry failed for invoice ${invoice.invoiceNumber}`,
        err instanceof Error ? err.stack : String(err),
      )
    }

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
        tenant: { select: SAFE_TENANT_SELECT },
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
            this.logger.error(
              `Bulk-invoice email failed for ${invoice.id}`,
              err instanceof Error ? err.stack : String(err),
            ),
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

  // Soft-delete (LAGBROTT 1, BFL 1999:1078): en faktura och dess append-only
  // händelselogg får ALDRIG raderas hårt. Ett utkast har dessutom redan
  // förbrukat ett fakturanummer ur InvoiceNumberSequence (PR 4) — en hård
  // radering skulle lämna ett oförklarat hål i den fortlöpande nummerserien.
  // I stället makuleras utkastet (DRAFT → VOID) via state machine:n, vilket
  // bevarar fakturan, loggar en VOIDED-händelse (vem + när + varför) och gör
  // hålet i serien spårbart (behandlingshistorik, BFL 5 kap 11 §).
  async remove(id: string, organizationId: string, actorId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan tas bort. Makulera fakturan istället.')
    }

    await this.transitionStatus(id, organizationId, 'VOID', actorId, 'USER', {
      reason: 'draft_voided',
    })
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
          { relatedEntityType: 'INVOICE', relatedEntityId: result.id },
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
      .catch((err) =>
        this.logger.error('View tracking error', err instanceof Error ? err.stack : String(err)),
      )
  }

  /**
   * Generera PDF och skicka faktura via e-post till hyresgästen.
   * Om fakturan är DRAFT övergår den till SENT automatiskt.
   */
  /**
   * Validerar fakturan och köar utskicket. Själva PDF-renderingen + mejlet
   * sker i PdfWorker (processInvoiceSendJob) så HTTP-svaret returneras direkt
   * (202) i stället för att blockera tills Chromium renderat klart.
   */
  async sendInvoiceEmail(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ jobId: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: { tenant: { select: SAFE_TENANT_SELECT }, customer: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'VOID' || invoice.status === 'PAID') {
      throw new BadRequestException('Fakturan kan inte skickas i nuvarande status')
    }

    // En faktura har antingen tenant eller customer (XOR-constraint).
    const recipient = invoice.tenant ?? invoice.customer
    if (!recipient) throw new BadRequestException('Fakturan saknar mottagare')
    if (!recipient.email) throw new BadRequestException('Mottagaren saknar e-postadress')

    const jobId = await this.pdfQueue.enqueue({
      kind: 'invoice-send',
      organizationId,
      invoiceId: id,
      actorId: userId,
    })
    return { jobId }
  }

  /**
   * Renderar faktura-PDF, köar mejlet och gör statusövergången DRAFT→SENT.
   * Anropas av PdfWorker. Idempotent: en faktura som hunnit bli VOID/PAID
   * hoppas tyst över, och mejlet har en idempotencyKey så en Bull-retry
   * (efter t.ex. ett fel i statusövergången) aldrig ger ett dubbelmejl.
   */
  async processInvoiceSendJob(id: string, organizationId: string, userId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        lines: true,
        tenant: { select: SAFE_TENANT_SELECT },
        customer: true,
        organization: true,
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    // Status kan ha ändrats mellan enqueue och körning — hoppa tyst över.
    if (invoice.status === 'VOID' || invoice.status === 'PAID') {
      this.logger.warn(`[pdf] hoppar över invoice-send för ${id} — status ${invoice.status}`)
      return
    }

    const recipient = invoice.tenant ?? invoice.customer
    if (!recipient?.email) {
      throw new BadRequestException('Fakturan saknar mottagare med e-postadress')
    }

    const pdfBuffer = await this.pdfService.generateInvoicePdf(id, organizationId)

    const recipientName =
      recipient.type === 'INDIVIDUAL'
        ? [recipient.firstName, recipient.lastName].filter(Boolean).join(' ')
        : (recipient.companyName ?? recipient.email)

    await this.mailService.sendInvoice({
      to: recipient.email,
      tenantName: recipientName,
      invoiceNumber: invoice.invoiceNumber,
      total: Number(invoice.total),
      dueDate: invoice.dueDate,
      pdfBuffer,
      organizationName: invoice.organization.name,
      accentColor: invoice.organization.invoiceColor ?? '#1a6b3c',
      idempotencyKey: `invoice-send-${id}`,
    })

    // Transition DRAFT → SENT
    if (invoice.status === 'DRAFT') {
      await this.transitionStatus(id, organizationId, 'SENT', userId, 'USER')
    } else {
      // Record send event without status transition
      await this.eventsService.record(id, 'SENT', 'USER', userId, {
        sentTo: recipient.email,
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
