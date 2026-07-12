import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { computeRentDebt } from '../avisering/rent-debt.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

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
  // Periodiserad intäkt (accrual) ur huvudboken: Σ kontoklass 3 (credit−debit)
  // för räkenskapsåret till dags dato. Ersätter den tidigare Invoice-baserade
  // "totalRevenue" (som var kassa-ish OCH blind för RentNotice OCH felaktigt
  // räknade betalda DEPOSIT-fakturor som intäkt). from/to exponeras så UI kan
  // ange perioden.
  revenue: {
    total: number
    from: string
    to: string
  }
  // Faktisk förfallen, obetald skuld — spänner över RentNotice (hyresmotorn)
  // OCH manuella Invoice, därför ett eget toppfält (inte under `invoices`).
  // RentNotice-delen = Σ computeRentDebt(n).outstanding per OVERDUE-avi
  // (type≠DEPOSIT), klampad PER AVI innan summering (en överbetald avi bidrar 0,
  // aldrig negativt) och räknar bara det OBETALDA (outstanding), inte hela avins
  // belopp. Invoice-delen = Σ OVERDUE Invoice.total (type≠DEPOSIT). De två
  // överlappar aldrig: en manuell RENT-faktura blockeras när en RentNotice finns
  // för perioden → ingen dubbelräkning.
  overdue: {
    total: number
  }
  invoices: {
    total: number
    draft: number
    sent: number
    paid: number
    overdue: number
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
  ) {}

  /**
   * Räkenskapsår-till-idag utifrån Organization.fiscalYearStartMonth (1–12).
   * Allt i UTC för att matcha JournalEntry.date (@db.Date). from = första dagen
   * i innevarande räkenskapsårs startmånad; to = nu (framtida-daterade avier,
   * t.ex. förskottsgenererad hyra, faller utanför → accrual-korrekt).
   */
  private fiscalYearToDate(fiscalYearStartMonth: number, now: Date): { from: Date; to: Date } {
    const y = now.getUTCFullYear()
    const currentMonth = now.getUTCMonth() + 1 // 1–12
    const startYear = currentMonth >= fiscalYearStartMonth ? y : y - 1
    const from = new Date(Date.UTC(startYear, fiscalYearStartMonth - 1, 1))
    return { from, to: now }
  }

  async getStats(organizationId: string): Promise<DashboardStats> {
    const now = new Date()
    const [
      invoiceGroups,
      invoiceOverdueSum,
      overdueNotices,
      organization,
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
      // OVERDUE Invoice, EXKL. DEPOSIT (deposition = 2890-skuld, inte hyresskuld;
      // fixar samma pre-existing type-läcka som PR1 gjorde på intäktssidan).
      // Invoice saknar allokerings-/paidAmount-modell → en OVERDUE-faktura är
      // fullt obetald, så .total ÄR restskulden (ingen klampning behövs här).
      this.prisma.invoice.aggregate({
        where: { organizationId, status: 'OVERDUE', type: { not: 'DEPOSIT' } },
        _sum: { total: true },
      }),
      // OVERDUE hyresavier, EXKL. DEPOSIT. EN findMany (ingen N+1) med de fält
      // computeRentDebt behöver + de granulära betalningsallokeringarna; skulden
      // beräknas + klampas PER AVI i JS nedan (Σ max(0,x) ≠ max(0,Σx)).
      this.prisma.rentNotice.findMany({
        where: { organizationId, status: 'OVERDUE', type: { not: 'DEPOSIT' } },
        select: {
          type: true,
          totalAmount: true,
          consumptionAmount: true,
          miscChargeAmount: true,
          reminderFeeAmount: true,
          interestAccruedAmount: true,
          payments: { select: { amount: true } },
        },
      }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { fiscalYearStartMonth: true },
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
        include: { tenant: { select: SAFE_TENANT_SELECT }, customer: true },
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

    // "Totala intäkter" = periodiserad intäkt ur huvudboken (Σ 3xxx), aldrig
    // Invoice+RentNotice parallellt. Defaultar fiscalYearStartMonth till 1
    // (kalenderår) om organisationen saknar värde.
    const { from, to } = this.fiscalYearToDate(organization?.fiscalYearStartMonth ?? 1, now)
    const revenueTotal = await this.accounting.getRevenueTotal(organizationId, from, to)

    // "Försenat belopp" = förfallen, OBETALD skuld. computeRentDebt klampar
    // outstanding = max(0, claim) PER AVI (en betald/överbetald avi bidrar 0,
    // aldrig negativt) och räknar bara resten på en delbetald avi. Summeras här
    // — aldrig tvärtom. computeRentDebt-logiken rörs inte; vi summerar dess
    // output. + OVERDUE Invoice (separat skuld, ingen överlappning → ingen
    // dubbelräkning).
    const rentOverdue = overdueNotices.reduce(
      (sum, n) =>
        sum +
        computeRentDebt({
          type: n.type,
          totalAmount: n.totalAmount,
          consumptionAmount: n.consumptionAmount,
          miscChargeAmount: n.miscChargeAmount,
          reminderFeeAmount: n.reminderFeeAmount,
          interestAccruedAmount: n.interestAccruedAmount,
          allocations: n.payments.map((p) => p.amount),
        }).outstanding,
      0,
    )
    const overdueTotal =
      Math.round((rentOverdue + Number(invoiceOverdueSum._sum.total ?? 0)) * 100) / 100

    return {
      revenue: {
        total: revenueTotal,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      overdue: {
        total: overdueTotal,
      },
      invoices: {
        total: totalInvoices,
        draft: invoiceByStatus['DRAFT'] ?? 0,
        sent: invoiceByStatus['SENT'] ?? 0,
        paid: invoiceByStatus['PAID'] ?? 0,
        overdue: invoiceByStatus['OVERDUE'] ?? 0,
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
