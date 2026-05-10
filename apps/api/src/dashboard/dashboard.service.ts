import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'

export interface TimeseriesPoint {
  month: string
  revenue: number
  paidRevenue: number
  newLeases: number
  terminatedLeases: number
  occupancy: number
  openTickets: number
}

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
  // Per-process cache. Räcker för en vanlig single-instance-deploy; om vi
  // skalar horisontellt får vi flytta nyckeln till Redis. TTL = 5 minuter
  // — balans mellan färska siffror och att inte hamra DB:n vid varje
  // dashboard-mount.
  private timeseriesCache = new Map<string, { at: number; data: TimeseriesPoint[] }>()
  private static readonly TIMESERIES_TTL_MS = 5 * 60 * 1000

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

  /**
   * Trender: en datapunkt per månad N månader bakåt. Mätvärden:
   * - revenue: totalt fakturerat (issueDate i månaden, exkl. DRAFT/VOID)
   * - paidRevenue: totalt betalat (paidAt i månaden)
   * - newLeases: kontrakt med startDate i månaden
   * - terminatedLeases: kontrakt med terminatedAt i månaden
   * - occupancy: % units med aktivt kontrakt vid månadens sista dag
   * - openTickets: ärenden som var öppna vid månadens sista dag
   *
   * Resultatet cachas per (org, månader) i 5 minuter — räcker för att en
   * dashboard-mount inte kostar 6×N queries.
   */
  async getTimeseries(organizationId: string, months: number): Promise<TimeseriesPoint[]> {
    const key = `${organizationId}:${months}`
    const cached = this.timeseriesCache.get(key)
    if (cached && Date.now() - cached.at < DashboardService.TIMESERIES_TTL_MS) {
      return cached.data
    }

    const now = new Date()
    const buckets: { label: string; start: Date; end: Date }[] = []
    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999)
      const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`
      buckets.push({ label, start, end })
    }

    const totalUnits = await this.prisma.unit.count({
      where: { property: { organizationId } },
    })

    const points = await Promise.all(
      buckets.map(async ({ label, start, end }) => {
        const [revenueAgg, paidAgg, newLeases, terminatedLeases, occupiedUnits, openTickets] =
          await Promise.all([
            this.prisma.invoice.aggregate({
              where: {
                organizationId,
                issueDate: { gte: start, lte: end },
                status: { notIn: ['DRAFT', 'VOID'] },
              },
              _sum: { total: true },
            }),
            this.prisma.invoice.aggregate({
              where: { organizationId, paidAt: { gte: start, lte: end } },
              _sum: { total: true },
            }),
            this.prisma.lease.count({
              where: { organizationId, startDate: { gte: start, lte: end } },
            }),
            this.prisma.lease.count({
              where: { organizationId, terminatedAt: { gte: start, lte: end } },
            }),
            this.prisma.unit.count({
              where: {
                property: { organizationId },
                leases: {
                  some: {
                    startDate: { lte: end },
                    AND: [
                      { OR: [{ endDate: null }, { endDate: { gte: end } }] },
                      { OR: [{ terminatedAt: null }, { terminatedAt: { gt: end } }] },
                    ],
                  },
                },
              },
            }),
            this.prisma.maintenanceTicket.count({
              where: {
                organizationId,
                createdAt: { lte: end },
                status: { notIn: ['CANCELLED'] },
                OR: [{ completedAt: null }, { completedAt: { gt: end } }],
              },
            }),
          ])

        return {
          month: label,
          revenue: Number(revenueAgg._sum.total ?? 0),
          paidRevenue: Number(paidAgg._sum.total ?? 0),
          newLeases,
          terminatedLeases,
          occupancy: totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 1000) / 10 : 0,
          openTickets,
        }
      }),
    )

    this.timeseriesCache.set(key, { at: Date.now(), data: points })
    return points
  }
}
