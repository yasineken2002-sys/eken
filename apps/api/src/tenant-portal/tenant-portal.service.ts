import { Injectable, BadRequestException } from '@nestjs/common'
import type { Invoice, Lease, MaintenanceCategory, Property, Unit } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { NotificationsService } from '../notifications/notifications.service'

type InvoiceWithLease = Invoice & {
  lease?: (Lease & { unit: Unit & { property: Property } }) | null
}

@Injectable()
export class TenantPortalService {
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
    const rows = await this.prisma.invoice.findMany({
      where: { tenantId },
      include: { lines: true, lease: { include: { unit: { include: { property: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((inv) => this.mapInvoice(inv))
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
    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      include: { unit: { include: { property: true } } },
    })
    const propertyId = lease?.unit?.property?.id

    return this.prisma.newsPost.findMany({
      where: {
        publishedAt: { not: null },
        OR: [{ targetAll: true }, ...(propertyId ? [{ propertyId }] : [])],
      },
      include: { createdBy: { select: { firstName: true, lastName: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    })
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
        '/maintenance',
      )
      .catch((err) => console.error('[portal] notification error', String(err)))

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
          activationToken: null,
          activationTokenExpiresAt: null,
        },
      })
      // Radera alla aktiva sessioner
      await tx.tenantSession.deleteMany({ where: { tenantId } })
    })
  }
}
