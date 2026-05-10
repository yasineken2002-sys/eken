import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import type { Invoice, Lease, MaintenanceCategory, Property, Unit } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { NotificationsService } from '../notifications/notifications.service'

type InvoiceWithLease = Invoice & {
  lease?: (Lease & { unit: Unit & { property: Property } }) | null
}

@Injectable()
export class TenantPortalService {
  private readonly logger = new Logger(TenantPortalService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenanceService: MaintenanceService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getDashboard(tenantId: string) {
    const [tenant, lease, openTickets, overdueCount, upcomingInvoice] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.getActiveLease(tenantId),
      this.prisma.maintenanceTicket.findMany({
        where: { tenantId, status: { in: ['NEW', 'IN_PROGRESS', 'SCHEDULED'] } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.invoice.count({ where: { tenantId, status: 'OVERDUE' } }),
      this.prisma.invoice.findFirst({
        where: { tenantId, status: { in: ['SENT', 'PARTIAL'] }, dueDate: { gte: new Date() } },
        include: { lease: { include: { unit: { include: { property: true } } } } },
        orderBy: { dueDate: 'asc' },
      }),
    ])

    const activeLease = lease
      ? {
          id: lease.id,
          status: lease.status,
          startDate: lease.startDate.toISOString(),
          endDate: lease.endDate?.toISOString() ?? null,
          monthlyRent: Number(lease.monthlyRent),
          depositAmount: Number(lease.depositAmount),
          noticePeriodMonths: lease.noticePeriodMonths,
          unit: {
            id: lease.unit.id,
            name: lease.unit.name,
            unitNumber: lease.unit.unitNumber,
            area: lease.unit.area,
            floor: lease.unit.floor,
            rooms: lease.unit.rooms,
          },
          property: {
            id: lease.unit.property.id,
            name: lease.unit.property.name,
            street: lease.unit.property.street,
            city: lease.unit.property.city,
            postalCode: lease.unit.property.postalCode,
          },
        }
      : null

    return {
      tenant,
      activeLease,
      overdueInvoices: overdueCount,
      upcomingInvoice: upcomingInvoice ? this.mapInvoice(upcomingInvoice) : null,
      openMaintenanceTickets: openTickets.length,
      unreadNotices: 0,
    }
  }

  async getNotices(tenantId: string) {
    return this.prisma.rentNotice.findMany({
      where: { tenantId },
      include: {
        lease: { include: { unit: { include: { property: true } } } },
      },
      orderBy: { dueDate: 'desc' },
    })
  }

  async getInvoices(tenantId: string) {
    // Fakturor (engångar: DEPOSIT, SERVICE, UTILITY, OTHER, samt admin-skapade
    // RENT-fakturor). DRAFT döljs — hyresgästen ska aldrig se utkast som
    // hyresvärden inte hunnit publicera.
    const rows = await this.prisma.invoice.findMany({
      where: { tenantId, status: { not: 'DRAFT' } },
      include: { lines: true, lease: { include: { unit: { include: { property: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((inv) => this.mapInvoice(inv))
  }

  /**
   * Hyresavier (RentNotice) — separat tabell från Invoice. Avier är
   * återkommande månadshyror som genereras av AviseringService, fakturor är
   * engångsbetalningar (deposition, service, m.m.). Att sammanblanda dessa
   * i samma flik var bug:en där en 16 647 kr-faktura visades under "Avier".
   */
  async getRentNotices(tenantId: string) {
    const rows = await this.prisma.rentNotice.findMany({
      where: {
        tenantId,
        // Skicka inte PENDING/CANCELLED till hyresgästen — bara avier som
        // hyresvärden faktiskt skickat eller markerat betalda.
        status: { in: ['SENT', 'PAID', 'OVERDUE'] },
      },
      include: { lease: { include: { unit: { include: { property: true } } } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    })
    return rows.map((notice) => ({
      id: notice.id,
      noticeNumber: notice.noticeNumber,
      ocrNumber: notice.ocrNumber,
      month: notice.month,
      year: notice.year,
      amount: Number(notice.amount),
      vatAmount: Number(notice.vatAmount),
      totalAmount: Number(notice.totalAmount),
      dueDate: notice.dueDate.toISOString(),
      paidAt: notice.paidAt?.toISOString() ?? null,
      status: notice.status,
      sentAt: notice.sentAt?.toISOString() ?? null,
      propertyName: notice.lease?.unit?.property?.name ?? '',
      unitName: notice.lease?.unit?.name ?? '',
    }))
  }

  async getLease(tenantId: string) {
    return this.getActiveLease(tenantId)
  }

  async getDocuments(tenantId: string) {
    return this.prisma.document.findMany({
      where: { tenantId, NOT: { category: 'INVOICE' } },
      orderBy: { createdAt: 'desc' },
    })
  }

  async getNews(tenantId: string) {
    // Scopa till hyresgästens egen organisation — tidigare saknades detta
    // helt (en hyresgäst kunde i teorin se publicerade nyheter från andra
    // organisationer som hade `targetAll: true`).
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { organizationId: true },
    })
    if (!tenant) return []

    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      include: { unit: { include: { property: true } } },
    })
    const propertyId = lease?.unit?.property?.id

    const posts = await this.prisma.newsPost.findMany({
      where: {
        organizationId: tenant.organizationId,
        publishedAt: { not: null },
        OR: [{ targetAll: true }, ...(propertyId ? [{ propertyId }] : [])],
      },
      include: {
        organization: { select: { name: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    })

    // Mappa till portal-DTO. Kontraktet (`body`, `imageUrl`,
    // `organizationName`) frikopplar portalen från Prisma-modellen så att
    // schemaändringar inte tysta-bryter klienten — vilket var precis vad
    // som hände tidigare när frontend förväntade sig `body` men Prisma
    // returnerade `content`.
    return posts.map((p) => ({
      id: p.id,
      title: p.title,
      body: p.content,
      publishedAt: p.publishedAt,
      imageUrl: null as string | null,
      organizationName: p.organization?.name ?? null,
      authorName: p.createdBy
        ? `${p.createdBy.firstName ?? ''} ${p.createdBy.lastName ?? ''}`.trim() || null
        : null,
    }))
  }

  async submitMaintenanceRequest(
    tenantId: string,
    dto: {
      title: string
      description: string
      category?: MaintenanceCategory
    },
  ) {
    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      include: { unit: { include: { property: true } }, tenant: true },
    })

    if (!lease) throw new BadRequestException('Inget aktivt hyresavtal hittades')

    const ticket = await this.maintenanceService.create(
      {
        title: dto.title,
        description: dto.description,
        propertyId: lease.unit.property.id,
        unitId: lease.unitId,
        tenantId,
        category: dto.category ?? 'OTHER',
        priority: 'NORMAL',
      },
      lease.organizationId,
      '',
    )

    const tenantName = lease.tenant.firstName
      ? `${lease.tenant.firstName} ${lease.tenant.lastName ?? ''}`.trim()
      : (lease.tenant.companyName ?? lease.tenant.email)

    void this.notificationsService
      .createForAllOrgUsers(
        lease.organizationId,
        'MAINTENANCE_NEW',
        '🔔 Ny felanmälan från hyresgäst',
        `${tenantName} har anmält: ${dto.title}`,
        { relatedEntityType: 'MAINTENANCE_TICKET', relatedEntityId: ticket.id },
      )
      .catch((err) =>
        this.logger.error('Notification error', err instanceof Error ? err.stack : String(err)),
      )

    return ticket
  }

  async addMaintenanceComment(tenantId: string, ticketId: string, content: string) {
    const ticket = await this.prisma.maintenanceTicket.findFirst({
      where: { id: ticketId, tenantId },
    })
    if (!ticket) throw new BadRequestException('Ärende hittades inte')

    await this.prisma.maintenanceComment.create({
      data: { ticketId, content, isInternal: false },
    })

    return this.prisma.maintenanceTicket.findUnique({
      where: { id: ticketId },
      include: {
        property: { select: { id: true, name: true, city: true } },
        unit: { select: { id: true, name: true, unitNumber: true } },
        tenant: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            type: true,
            email: true,
          },
        },
        images: true,
        comments: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } },
      },
    })
  }

  async getMaintenanceTickets(tenantId: string) {
    return this.prisma.maintenanceTicket.findMany({
      where: { tenantId },
      include: {
        property: true,
        unit: true,
        comments: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  private mapInvoice(inv: InvoiceWithLease) {
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      type: inv.type,
      status: inv.status,
      total: Number(inv.total),
      dueDate: inv.dueDate.toISOString(),
      issueDate: inv.issueDate.toISOString(),
      paidAt: inv.paidAt?.toISOString() ?? null,
      propertyName: inv.lease?.unit?.property?.name ?? '',
      unitName: inv.lease?.unit?.name ?? '',
    }
  }

  private async getActiveLease(tenantId: string) {
    return this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      include: {
        unit: { include: { property: true } },
        documents: true,
      },
    })
  }

  // ─── GDPR ───────────────────────────────────────────────────────────────────

  /**
   * GDPR Art. 15: maskinläsbar kopia av all hyresgästens data.
   */
  async exportTenantData(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        organization: { select: { id: true, name: true } },
        leases: {
          include: { unit: { include: { property: true } }, documents: true },
        },
        invoices: { include: { lines: true } },
        rentNotices: true,
        maintenanceTickets: {
          include: { comments: { where: { isInternal: false } }, images: true },
        },
        documents: true,
      },
    })
    if (!tenant) throw new BadRequestException('Hyresgäst hittades inte')

    return {
      exportedAt: new Date().toISOString(),
      gdprNotice:
        'Detta är en kopia av personuppgifter som vi behandlar om dig enligt GDPR Art. 15. Begäran om radering kan göras via DELETE /v1/portal/me.',
      tenant: {
        id: tenant.id,
        type: tenant.type,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        companyName: tenant.companyName,
        email: tenant.email,
        phone: tenant.phone,
        personalNumber: tenant.personalNumber,
        orgNumber: tenant.orgNumber,
        street: tenant.street,
        city: tenant.city,
        postalCode: tenant.postalCode,
        portalActivated: tenant.portalActivated,
        portalActivatedAt: tenant.portalActivatedAt,
        createdAt: tenant.createdAt,
      },
      organization: tenant.organization,
      leases: tenant.leases,
      invoices: tenant.invoices,
      rentNotices: tenant.rentNotices,
      maintenanceTickets: tenant.maintenanceTickets,
      documents: tenant.documents,
    }
  }

  /**
   * GDPR Art. 17: anonymisera hyresgästen och radera portal-konto.
   *
   * Vi raderar inte själva tenant-raden eftersom kvarvarande hyresavtal,
   * fakturor och journalposter är räkenskapsmaterial som måste sparas i 7 år
   * enligt Bokföringslagen 7 kap. 2 §. Istället maskerar vi
   * personuppgifterna (namn, e-post, telefon, personnummer) så ingen
   * återidentifiering är möjlig.
   */
  async deleteTenantAccount(tenantId: string) {
    await this.prisma.$transaction(async (tx) => {
      const masked = `gdpr-deleted-${tenantId.slice(0, 8)}`
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          firstName: null,
          lastName: null,
          companyName: 'Raderad hyresgäst',
          email: `${masked}@gdpr.invalid`,
          phone: null,
          personalNumber: null,
          orgNumber: null,
          street: null,
          city: null,
          postalCode: null,
          contactPerson: null,
          passwordHash: null,
          portalActivated: false,
          activationTokenHash: null,
          activationTokenExpiresAt: null,
          activationReminderSentAt: null,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      })
      // Radera alla aktiva sessioner
      await tx.tenantSession.deleteMany({ where: { tenantId } })
    })
  }
}
