import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'

@Injectable()
export class PlatformStatsService {
  constructor(private prisma: PrismaService) {}

  async overview() {
    const [totalOrgs, activeOrgs, suspendedOrgs, trialOrgs, revenueAgg, mrrAgg, criticalErrors] =
      await Promise.all([
        this.prisma.organization.count(),
        this.prisma.organization.count({ where: { status: 'ACTIVE' } }),
        this.prisma.organization.count({ where: { status: 'SUSPENDED' } }),
        this.prisma.organization.count({ where: { plan: 'TRIAL' } }),
        this.prisma.platformInvoice.aggregate({
          _sum: { amount: true },
          where: { status: 'PAID' },
        }),
        this.prisma.organization.aggregate({
          _sum: { monthlyFee: true },
          where: { status: 'ACTIVE' },
        }),
        this.prisma.errorLog.count({ where: { severity: 'CRITICAL', resolved: false } }),
      ])

    return {
      totalOrgs,
      activeOrgs,
      suspendedOrgs,
      trialOrgs,
      totalRevenue: Number(revenueAgg._sum.amount ?? 0),
      mrr: Number(mrrAgg._sum.monthlyFee ?? 0),
      criticalErrors,
    }
  }

  async growth(periodDays = 30) {
    const from = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)

    const orgs = await this.prisma.organization.findMany({
      where: { createdAt: { gte: from } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    })

    const buckets = new Map<string, number>()
    for (let d = 0; d < periodDays; d++) {
      const date = new Date(from.getTime() + d * 24 * 60 * 60 * 1000)
      buckets.set(date.toISOString().slice(0, 10), 0)
    }
    for (const o of orgs) {
      const key = o.createdAt.toISOString().slice(0, 10)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }

    return Array.from(buckets.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  async activity(limit = 20) {
    const [orgs, payments, errors] = await Promise.all([
      this.prisma.organization.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, name: true, createdAt: true, plan: true },
      }),
      this.prisma.platformInvoice.findMany({
        where: { status: 'PAID' },
        orderBy: { paidAt: 'desc' },
        take: limit,
        include: { organization: { select: { id: true, name: true } } },
      }),
      this.prisma.errorLog.findMany({
        where: { severity: 'CRITICAL' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { organization: { select: { id: true, name: true } } },
      }),
    ])

    const events = [
      ...orgs.map((o) => ({
        type: 'ORG_CREATED' as const,
        timestamp: o.createdAt.toISOString(),
        data: { id: o.id, name: o.name, plan: o.plan },
      })),
      ...payments.map((p) => ({
        type: 'PAYMENT_RECEIVED' as const,
        timestamp: (p.paidAt ?? p.updatedAt).toISOString(),
        data: {
          id: p.id,
          amount: Number(p.amount),
          invoiceNumber: p.invoiceNumber,
          organization: p.organization,
        },
      })),
      ...errors.map((e) => ({
        type: 'CRITICAL_ERROR' as const,
        timestamp: e.createdAt.toISOString(),
        data: {
          id: e.id,
          message: e.message,
          source: e.source,
          organization: e.organization,
        },
      })),
    ]

    return events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit)
  }

  async topOrganizations(limit = 10) {
    const rows = await this.prisma.organization.findMany({
      take: limit,
      orderBy: { properties: { _count: 'desc' } },
      include: {
        _count: { select: { properties: true, tenants: true, users: true } },
      },
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      plan: r.plan,
      status: r.status,
      propertyCount: r._count.properties,
      tenantCount: r._count.tenants,
      userCount: r._count.users,
    }))
  }

  async planBreakdown() {
    const rows = await this.prisma.organization.groupBy({
      by: ['plan'],
      _count: { plan: true },
    })
    const map: Record<string, number> = { TRIAL: 0, BASIC: 0, STANDARD: 0, PREMIUM: 0 }
    for (const row of rows) {
      map[row.plan] = row._count.plan
    }
    return map
  }
}
