import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'

export interface DashboardStats {
  invoices: {
    total: number
    draft: number
    sent: number
    paid: number
    overdue: number
    totalRevenue: number
    overdueAmount: number
  }
  tenants: {
    total: number
    individual: number
    company: number
  }
  properties: {
    total: number
  }
  leases: {
    total: number
    active: number
    draft: number
  }
  recentInvoices: Array<{
    id: string
    invoiceNumber: string
    status: string
    total: number
    dueDate: string
    tenantName: string
  }>
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats(organizationId: string): Promise<DashboardStats> {
    const [
      invoiceGroups,
      paidSum,
      overdueSum,
      tenantGroups,
      propertyCount,
      leaseGroups,
      recentInvoices,
    ] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { id: true },
      }),
      this.prisma.invoice.aggregate({
        where: { organizationId, status: 'PAID' },
        _sum: { total: true },
      }),
      this.prisma.invoice.aggregate({
        where: { organizationId, status: 'OVERDUE' },
        _sum: { total: true },
      }),
      this.prisma.tenant.groupBy({
        by: ['type'],
        where: { organizationId },
        _count: { id: true },
      }),
      this.prisma.property.count({ where: { organizationId } }),
      this.prisma.lease.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { id: true },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { tenant: true, customer: true },
      }),
    ])

    // Map invoice groups to counts
    const invoiceByStatus = Object.fromEntries(invoiceGroups.map((g) => [g.status, g._count.id]))
    const totalInvoices = invoiceGroups.reduce((s, g) => s + g._count.id, 0)

    // Map tenant groups
    const tenantByType = Object.fromEntries(tenantGroups.map((g) => [g.type, g._count.id]))
    const totalTenants = tenantGroups.reduce((s, g) => s + g._count.id, 0)

    // Map lease groups
    const leaseByStatus = Object.fromEntries(leaseGroups.map((g) => [g.status, g._count.id]))
    const totalLeases = leaseGroups.reduce((s, g) => s + g._count.id, 0)

    return {
      invoices: {
        total: totalInvoices,
        draft: invoiceByStatus['DRAFT'] ?? 0,
        sent: invoiceByStatus['SENT'] ?? 0,
        paid: invoiceByStatus['PAID'] ?? 0,
        overdue: invoiceByStatus['OVERDUE'] ?? 0,
        totalRevenue: Number(paidSum._sum.total ?? 0),
        overdueAmount: Number(overdueSum._sum.total ?? 0),
      },
      tenants: {
        total: totalTenants,
        individual: tenantByType['INDIVIDUAL'] ?? 0,
        company: tenantByType['COMPANY'] ?? 0,
      },
      properties: {
        total: propertyCount,
      },
      leases: {
        total: totalLeases,
        active: leaseByStatus['ACTIVE'] ?? 0,
        draft: leaseByStatus['DRAFT'] ?? 0,
      },
      recentInvoices: recentInvoices.map((inv) => {
        const party = inv.tenant ?? inv.customer
        const partyName = !party
          ? '–'
          : party.type === 'INDIVIDUAL'
            ? [party.firstName, party.lastName].filter(Boolean).join(' ')
            : (party.companyName ?? party.email ?? '–')
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          total: Number(inv.total),
          dueDate: inv.dueDate.toISOString(),
          tenantName: partyName,
        }
      }),
    }
  }
}
