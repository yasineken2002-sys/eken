import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'

@Injectable()
export class DataContextService {
  constructor(private readonly prisma: PrismaService) {}

  async buildContext(organizationId: string): Promise<string> {
    const now = new Date()
    const ninetyDaysFromNow = new Date(now)
    ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90)
    const thirtyDaysFromNow = new Date(now)
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30)
    const thirtyDaysAgo = new Date(now)
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const [
      org,
      propertyCount,
      unitStats,
      tenantCount,
      activeLeaseCount,
      invoiceStats,
      overdueInvoices,
      expiringLeases,
      recentInvoices,
      tenantList,
      propertyList,
      activeLeaseList,
      expiring90Count,
      paidInvoicesForBehavior,
    ] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, city: true },
      }),
      this.prisma.property.count({ where: { organizationId } }),
      this.prisma.unit.groupBy({
        by: ['status'],
        where: { property: { organizationId } },
        _count: { id: true },
      }),
      this.prisma.tenant.count({ where: { organizationId } }),
      this.prisma.lease.count({
        where: { organizationId, status: 'ACTIVE' },
      }),
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: { id: true },
        _sum: { total: true },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, status: 'OVERDUE' },
        select: {
          invoiceNumber: true,
          total: true,
          dueDate: true,
          tenant: { select: { firstName: true, lastName: true, companyName: true } },
        },
        orderBy: { dueDate: 'asc' },
        take: 5,
      }),
      this.prisma.lease.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { gte: now, lte: thirtyDaysFromNow },
        },
        select: {
          endDate: true,
          monthlyRent: true,
          unit: { select: { name: true, unitNumber: true } },
          tenant: { select: { firstName: true, lastName: true, companyName: true } },
        },
        orderBy: { endDate: 'asc' },
        take: 5,
      }),
      this.prisma.invoice.findMany({
        where: {
          organizationId,
          createdAt: { gte: thirtyDaysAgo },
        },
        select: {
          invoiceNumber: true,
          status: true,
          total: true,
          issueDate: true,
          tenant: { select: { firstName: true, lastName: true, companyName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.tenant.findMany({
        where: { organizationId },
        select: {
          id: true,
          type: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          leases: {
            where: { status: 'ACTIVE' },
            select: { id: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.property.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          type: true,
          units: {
            select: {
              id: true,
              status: true,
              leases: {
                where: { status: 'ACTIVE' },
                select: { monthlyRent: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.lease.findMany({
        where: { organizationId, status: 'ACTIVE' },
        select: {
          id: true,
          monthlyRent: true,
          startDate: true,
          endDate: true,
          tenant: {
            select: { id: true, type: true, firstName: true, lastName: true, companyName: true },
          },
          unit: { select: { id: true, name: true, unitNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      this.prisma.lease.count({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { gte: now, lte: ninetyDaysFromNow },
        },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, status: 'PAID', paidAt: { not: null } },
        select: { tenantId: true, paidAt: true, dueDate: true },
        take: 200,
      }),
    ])

    // Build unit status map
    const unitMap: Record<string, number> = {}
    for (const row of unitStats) {
      unitMap[row.status] = row._count.id
    }
    const totalUnits = Object.values(unitMap).reduce((a, b) => a + b, 0)
    const vacantUnits = unitMap['VACANT'] ?? 0
    const occupiedUnits = unitMap['OCCUPIED'] ?? 0
    const occupancyPct = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0

    // Build invoice totals map
    const invoiceMap: Record<string, { count: number; total: number }> = {}
    for (const row of invoiceStats) {
      invoiceMap[row.status] = {
        count: row._count.id,
        total: Number(row._sum.total ?? 0),
      }
    }

    // Compute total monthly income from active leases
    const totalMonthlyIncome = activeLeaseList.reduce((sum, l) => sum + Number(l.monthlyRent), 0)

    // Build per-tenant payment behavior map
    const paymentMap = new Map<string, { onTime: number; total: number }>()
    for (const inv of paidInvoicesForBehavior) {
      if (!inv.tenantId || !inv.paidAt) continue
      const cur = paymentMap.get(inv.tenantId) ?? { onTime: 0, total: 0 }
      cur.total++
      if (inv.paidAt <= inv.dueDate) cur.onTime++
      paymentMap.set(inv.tenantId, cur)
    }

    const formatTenantName = (t: {
      firstName?: string | null
      lastName?: string | null
      companyName?: string | null
    }) => t.companyName ?? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()

    const formatSEK = (amount: number) =>
      new Intl.NumberFormat('sv-SE', {
        style: 'currency',
        currency: 'SEK',
        maximumFractionDigits: 0,
      }).format(amount)

    const formatDate = (d: Date | null) =>
      d ? new Intl.DateTimeFormat('sv-SE').format(new Date(d)) : 'okänt'

    const overdueData = invoiceMap['OVERDUE']
    const lines: string[] = [
      `ORGANISATIONSÖVERSIKT – ${org?.name ?? 'Okänd organisation'} (${org?.city ?? ''})`,
      `Datum: ${formatDate(now)}`,
      '',
      'PORTFÖLJSAMMANFATTNING:',
      `Totala månadsinkomster: ${formatSEK(totalMonthlyIncome)}`,
      `Beläggningsgrad: ${occupancyPct}%`,
      `Förfallna fakturor: ${overdueData?.count ?? 0} st (${formatSEK(overdueData?.total ?? 0)})`,
      `Kontrakt som löper ut inom 90 dagar: ${expiring90Count} st`,
      '',
      '## FASTIGHETER & OBJEKT',
      `Antal fastigheter: ${propertyCount}`,
      `Totalt antal objekt: ${totalUnits}`,
      `  Uthyrda: ${occupiedUnits}`,
      `  Lediga: ${vacantUnits}`,
      `  Under renovering: ${unitMap['UNDER_RENOVATION'] ?? 0}`,
      `  Reserverade: ${unitMap['RESERVED'] ?? 0}`,
      `Beläggningsgrad: ${occupancyPct}%`,
      '',
      '## HYRESGÄSTER & AVTAL',
      `Antal hyresgäster: ${tenantCount}`,
      `Aktiva hyresavtal: ${activeLeaseCount}`,
    ]

    if (expiringLeases.length > 0) {
      lines.push('', 'Avtal som löper ut inom 30 dagar:')
      for (const lease of expiringLeases) {
        lines.push(
          `  - ${formatTenantName(lease.tenant)}, ${lease.unit.name} (${lease.unit.unitNumber}), utgår ${formatDate(lease.endDate)}, hyra ${formatSEK(Number(lease.monthlyRent))}/mån`,
        )
      }
    }

    lines.push('', '## FAKTUROR')
    const statusLabels: Record<string, string> = {
      DRAFT: 'Utkast',
      SENT: 'Skickade',
      PARTIAL: 'Delbetalda',
      PAID: 'Betalda',
      OVERDUE: 'Förfallna',
      VOID: 'Makulerade',
    }
    for (const [status, label] of Object.entries(statusLabels)) {
      const data = invoiceMap[status]
      if (data && data.count > 0) {
        lines.push(`  ${label}: ${data.count} st, totalt ${formatSEK(data.total)}`)
      }
    }

    if (overdueInvoices.length > 0) {
      lines.push('', 'Förfallna fakturor (urval):')
      for (const inv of overdueInvoices) {
        lines.push(
          `  - Faktura ${inv.invoiceNumber}, ${formatTenantName(inv.tenant)}, ${formatSEK(Number(inv.total))}, förföll ${formatDate(inv.dueDate)}`,
        )
      }
    }

    if (recentInvoices.length > 0) {
      lines.push('', 'Senaste fakturor (30 dagar):')
      for (const inv of recentInvoices) {
        lines.push(
          `  - Faktura ${inv.invoiceNumber}, ${formatTenantName(inv.tenant)}, ${formatSEK(Number(inv.total))}, ${statusLabels[inv.status] ?? inv.status}, utfärdad ${formatDate(inv.issueDate)}`,
        )
      }
    }

    if (tenantList.length > 0) {
      lines.push('', '## HYRESGÄSTREGISTER (ID krävs vid åtgärder)')
      for (const t of tenantList) {
        const name =
          t.type === 'INDIVIDUAL'
            ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
            : (t.companyName ?? '')
        const activeLeases = t.leases.length
        const behavior = paymentMap.get(t.id)
        const onTimePct =
          behavior && behavior.total > 0
            ? Math.round((behavior.onTime / behavior.total) * 100)
            : null
        const behaviorStr = onTimePct !== null ? `, betalningsbeteende: ${onTimePct}% i tid` : ''
        lines.push(
          `  - ${name} (ID: ${t.id}, e-post: ${t.email ?? 'ingen e-post'}): ${activeLeases} aktiva kontrakt${behaviorStr}`,
        )
      }
      if (tenantCount > tenantList.length) {
        lines.push(`  ... och ${tenantCount - tenantList.length} till`)
      }
    }

    if (propertyList.length > 0) {
      lines.push('', '## FASTIGHETSLISTA (ID krävs vid åtgärder)')
      for (const p of propertyList) {
        const totalPropUnits = p.units.length
        const occupiedPropUnits = p.units.filter((u) => u.status === 'OCCUPIED').length
        const propOccupancyPct =
          totalPropUnits > 0 ? Math.round((occupiedPropUnits / totalPropUnits) * 100) : 0
        const propMonthlyIncome = p.units.reduce(
          (sum, u) => sum + u.leases.reduce((ls, l) => ls + Number(l.monthlyRent), 0),
          0,
        )
        lines.push(
          `  - ${p.name} (ID: ${p.id}): ${totalPropUnits} enheter, ${occupiedPropUnits} uthyrda (${propOccupancyPct}%), månadsinkomst: ${formatSEK(propMonthlyIncome)}`,
        )
      }
    }

    if (activeLeaseList.length > 0) {
      lines.push('', '## AKTIVA KONTRAKT (ID krävs vid åtgärder)')
      for (const l of activeLeaseList) {
        const tenantName =
          l.tenant.type === 'INDIVIDUAL'
            ? `${l.tenant.firstName ?? ''} ${l.tenant.lastName ?? ''}`.trim()
            : (l.tenant.companyName ?? '')
        const startStr = new Date(l.startDate).toISOString().slice(0, 10)
        const endStr = l.endDate
          ? `löper ut ${new Date(l.endDate).toISOString().slice(0, 10)}`
          : 'tillsvidare'
        lines.push(
          `  - ${tenantName} → ${l.unit.name} ${l.unit.unitNumber} (LeaseID: ${l.id}): ${formatSEK(Number(l.monthlyRent))}/mån, startade ${startStr}, ${endStr}`,
        )
      }
    }

    return lines.join('\n')
  }
}
