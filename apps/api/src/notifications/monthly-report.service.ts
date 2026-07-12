import type { OnModuleInit } from '@nestjs/common'
import { Injectable, Logger } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { PrismaService } from '../common/prisma/prisma.service'
import { OverdueDebtService } from '../overdue/overdue-debt.service'
import { StorageService } from '../storage/storage.service'
import { getLogoDataUrl } from '../common/branding'
import { generateMonthlyReportHtml } from './templates/monthly-report.template'
import type { MonthlyReportData } from './templates/monthly-report.template'
import type { PdfService } from '../invoices/pdf.service'
import type { AiAssistantService } from '../ai/ai-assistant.service'
import type { DashboardService } from '../dashboard/dashboard.service'

const DAY_MS = 86_400_000

// Procentuell förändring current vs base. Returnerar null när basen är 0 —
// då finns ingen meningsfull jämförelse (t.ex. nystartad organisation utan
// historik). Mallen renderar null som "ingen jämförelse".
function pctChange(current: number, base: number): number | null {
  if (base <= 0) return null
  return ((current - base) / base) * 100
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function tenantName(
  t: {
    type: string
    firstName: string | null
    lastName: string | null
    companyName: string | null
  } | null,
): string {
  if (!t) return '–'
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

/**
 * Bygger datat för månadsrapportens PDF och renderar PDF:en. Återanvänder
 * befintlig infrastruktur via ModuleRef (samma mönster som NotificationsService
 * använder för AiAssistantService) — det undviker cirkulära modulberoenden
 * mellan NotificationsModule och Invoices-/Ai-/Dashboard-modulerna.
 */
@Injectable()
export class MonthlyReportService implements OnModuleInit {
  private readonly logger = new Logger(MonthlyReportService.name)
  private pdf!: PdfService
  private ai!: AiAssistantService
  private dashboard!: DashboardService

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly storage: StorageService,
    // Delad sanningskälla för "Försenat belopp" (samma som dashboarden). Endast
    // Prisma-beroende → ingen cirkelrisk, injiceras direkt (till skillnad från
    // pdf/ai/dashboard som resolvas via ModuleRef).
    private readonly overdue: OverdueDebtService,
  ) {}

  async onModuleInit(): Promise<void> {
    const [pdfMod, aiMod, dashMod] = await Promise.all([
      import('../invoices/pdf.service'),
      import('../ai/ai-assistant.service'),
      import('../dashboard/dashboard.service'),
    ])
    this.pdf = this.moduleRef.get(pdfMod.PdfService, { strict: false })
    this.ai = this.moduleRef.get(aiMod.AiAssistantService, { strict: false })
    this.dashboard = this.moduleRef.get(dashMod.DashboardService, { strict: false })
  }

  /**
   * Genererar månadsrapporten som PDF-buffer för en organisation. Returnerar
   * null om organisationen saknar fastigheter (skicka inte en tom rapport).
   */
  async generatePdf(
    organizationId: string,
  ): Promise<{ pdf: Buffer; data: MonthlyReportData } | null> {
    const data = await this.buildReportData(organizationId)
    if (!data) return null
    const html = generateMonthlyReportHtml(data)
    const pdf = await this.pdf.generateFromHtml(html)
    return { pdf, data }
  }

  private async buildReportData(organizationId: string): Promise<MonthlyReportData | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        name: true,
        orgNumber: true,
        street: true,
        city: true,
        postalCode: true,
        // Varumärke (Steg 3, PR 3a) — läses av den brandade shellen.
        invoiceColor: true,
        brandSecondaryColor: true,
        brandFont: true,
        logoStorageKey: true,
      },
    })
    if (!org) return null

    // Logga som data:-URL (samlade helpern). Saknad/felad logga → null,
    // shellen visar då org-namnet i stället. Får aldrig fälla rapporten.
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)

    // Tidsserie över 14 månader: index 12 = rapportmånad (månaden som just
    // tog slut), 11 = månaden dessförinnan, 0 = samma månad förra året.
    const series = await this.dashboard.getTimeseries(organizationId, 14)
    const report = series[12]
    if (!report) return null
    const prevMonthRevenue = series[11]?.revenue ?? 0
    const prevMonthOccupancy = series[11]?.occupancy ?? 0
    const prevYearRevenue = series[0]?.revenue ?? 0

    // report.month har formatet "YYYY-MM".
    const [yStr, mStr] = report.month.split('-')
    const year = Number(yStr)
    const month = Number(mStr) // 1-12
    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999)
    const monthLabel = capitalize(
      monthStart.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }),
    )
    const now = new Date()
    const inMonth = { gte: monthStart, lte: monthEnd }

    const [
      properties,
      revByType,
      unitsByStatus,
      paidInvoices,
      overdueSnapshot,
      monthInvoices,
      ticketGroups,
      incomingTickets,
      resolvedTickets,
      newLeases,
      terminatedLeases,
    ] = await Promise.all([
      this.prisma.property.findMany({
        where: { organizationId },
        select: { id: true, name: true, units: { select: { status: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.invoice.groupBy({
        by: ['type'],
        where: { organizationId, issueDate: inMonth, status: { notIn: ['DRAFT', 'VOID'] } },
        _sum: { total: true },
      }),
      this.prisma.unit.groupBy({
        by: ['status'],
        where: { property: { organizationId } },
        _count: { id: true },
      }),
      this.prisma.invoice.findMany({
        where: { organizationId, paidAt: inMonth },
        select: { paidAt: true, dueDate: true },
      }),
      // Förfallen skuld via DELADE sanningskällan (samma tal som dashboardens
      // "Försenat belopp"). Ersätter den gamla Invoice-ENDAST-summeringen som
      // var blind för RentNotice och inte exkluderade DEPOSIT (samma bug som
      // dashboard-PR2 fixade — nu en sanningskälla för båda ytorna).
      this.overdue.getOverdueSnapshot(organizationId, now),
      this.prisma.invoice.findMany({
        where: {
          organizationId,
          issueDate: inMonth,
          status: { notIn: ['DRAFT', 'VOID'] },
          leaseId: { not: null },
        },
        select: { total: true, lease: { select: { unit: { select: { propertyId: true } } } } },
      }),
      this.prisma.maintenanceTicket.groupBy({
        by: ['propertyId'],
        where: { organizationId, createdAt: inMonth },
        _count: { id: true },
      }),
      this.prisma.maintenanceTicket.count({
        where: { organizationId, createdAt: inMonth },
      }),
      this.prisma.maintenanceTicket.findMany({
        where: { organizationId, completedAt: inMonth },
        select: { createdAt: true, completedAt: true },
      }),
      this.prisma.lease.findMany({
        where: { organizationId, startDate: inMonth },
        orderBy: { startDate: 'asc' },
        select: {
          startDate: true,
          monthlyRent: true,
          tenant: { select: { type: true, firstName: true, lastName: true, companyName: true } },
          unit: { select: { name: true, property: { select: { name: true } } } },
        },
      }),
      this.prisma.lease.findMany({
        where: { organizationId, terminatedAt: inMonth },
        orderBy: { terminatedAt: 'asc' },
        select: {
          terminatedAt: true,
          tenant: { select: { type: true, firstName: true, lastName: true, companyName: true } },
          unit: { select: { name: true, property: { select: { name: true } } } },
        },
      }),
    ])

    if (properties.length === 0) return null // tom org — skicka inte tom rapport

    // ── Intäkter per fakturatyp ──────────────────────────────────────────────
    const revMap = new Map(revByType.map((g) => [g.type, Number(g._sum.total ?? 0)]))
    const rent = revMap.get('RENT') ?? 0
    const service = revMap.get('SERVICE') ?? 0
    const utility = revMap.get('UTILITY') ?? 0
    const deposit = revMap.get('DEPOSIT') ?? 0
    const other = revMap.get('OTHER') ?? 0
    const revenueTotal = rent + service + utility + deposit + other

    // ── Beläggning (nuläge via Unit.status) ──────────────────────────────────
    const statusMap = new Map(unitsByStatus.map((g) => [g.status, g._count.id]))
    const occupied = statusMap.get('OCCUPIED') ?? 0
    const vacant = statusMap.get('VACANT') ?? 0
    const renovation = statusMap.get('UNDER_RENOVATION') ?? 0
    const reserved = statusMap.get('RESERVED') ?? 0
    const totalUnits = occupied + vacant + renovation + reserved
    const ratePct = totalUnits > 0 ? Math.round((occupied / totalUnits) * 1000) / 10 : 0

    // ── Betalningsmönster ────────────────────────────────────────────────────
    let onTime = 0
    let late1to7 = 0
    let late8to30 = 0
    let late30plus = 0
    for (const inv of paidInvoices) {
      if (!inv.paidAt) continue
      const daysLate = Math.floor((inv.paidAt.getTime() - inv.dueDate.getTime()) / DAY_MS)
      if (daysLate <= 0) onTime++
      else if (daysLate <= 7) late1to7++
      else if (daysLate <= 30) late8to30++
      else late30plus++
    }

    // ── Förfallen skuld (nuläge) ─────────────────────────────────────────────
    // Från den delade OverdueDebtService: hyresavier (outstanding, klampat per
    // avi) + OVERDUE-fakturor, DEPOSIT exkluderad. Samma tal som dashboarden.
    const overdueCount = overdueSnapshot.count
    const overdueAmount = overdueSnapshot.total
    const over30Count = overdueSnapshot.over30Count

    // ── Underhåll ────────────────────────────────────────────────────────────
    let avgResolutionDays: number | null = null
    if (resolvedTickets.length > 0) {
      const totalDays = resolvedTickets.reduce((sum, t) => {
        if (!t.completedAt) return sum
        return sum + (t.completedAt.getTime() - t.createdAt.getTime()) / DAY_MS
      }, 0)
      avgResolutionDays = Math.round((totalDays / resolvedTickets.length) * 10) / 10
    }
    const propNameById = new Map(properties.map((p) => [p.id, p.name]))
    const ticketCountById = new Map(ticketGroups.map((g) => [g.propertyId, g._count.id]))
    const topProperties = [...ticketGroups]
      .sort((a, b) => b._count.id - a._count.id)
      .slice(0, 3)
      .map((g) => ({
        name: propNameById.get(g.propertyId) ?? 'Okänd fastighet',
        count: g._count.id,
      }))

    // ── Per fastighet ────────────────────────────────────────────────────────
    const revenueByProperty = new Map<string, number>()
    for (const inv of monthInvoices) {
      const propertyId = inv.lease?.unit.propertyId
      if (!propertyId) continue
      revenueByProperty.set(
        propertyId,
        (revenueByProperty.get(propertyId) ?? 0) + Number(inv.total),
      )
    }
    const propertyRows = properties.map((p) => {
      const unitCount = p.units.length
      const occ = p.units.filter((u) => u.status === 'OCCUPIED').length
      const vac = p.units.filter((u) => u.status === 'VACANT').length
      return {
        name: p.name,
        revenue: revenueByProperty.get(p.id) ?? 0,
        occupancyPct: unitCount > 0 ? Math.round((occ / unitCount) * 1000) / 10 : 0,
        vacant: vac,
        tickets: ticketCountById.get(p.id) ?? 0,
      }
    })

    // ── Appendix: kontraktsrörelser ──────────────────────────────────────────
    const newLeaseRows = newLeases.map((l) => ({
      tenant: tenantName(l.tenant),
      unit: l.unit.name,
      property: l.unit.property.name,
      startDate: l.startDate.toLocaleDateString('sv-SE'),
      monthlyRent: Number(l.monthlyRent),
    }))
    const terminatedLeaseRows = terminatedLeases.map((l) => ({
      tenant: tenantName(l.tenant),
      unit: l.unit.name,
      property: l.unit.property.name,
      endDate: l.terminatedAt ? l.terminatedAt.toLocaleDateString('sv-SE') : '–',
    }))

    // ── AI-insikter ──────────────────────────────────────────────────────────
    const monthSummary = [
      `Rapportmånad: ${monthLabel}`,
      `Omsättning (fakturerat): ${revenueTotal} kr — förra månaden ${prevMonthRevenue} kr, samma månad förra året ${prevYearRevenue} kr`,
      `Inbetalt under månaden: ${report.paidRevenue} kr`,
      `Intäkter per typ — hyra ${rent}, tjänster ${service}, förbrukning ${utility}, deposition ${deposit}, övrigt ${other}`,
      `Beläggning: ${ratePct}% (${occupied} uthyrda, ${vacant} lediga, ${renovation} under renovering, ${reserved} reserverade av ${totalUnits})`,
      `Förfallen skuld just nu: ${overdueCount} poster, ${overdueAmount} kr, varav ${over30Count} äldre än 30 dagar`,
      `Nya kontrakt: ${report.newLeases}, avslutade kontrakt: ${report.terminatedLeases}`,
      `Betalningsmönster (betalda denna månad): i tid ${onTime}, 1-7 dagar sent ${late1to7}, 8-30 dagar ${late8to30}, 30+ dagar ${late30plus}`,
      `Underhåll: ${incomingTickets} inkomna ärenden, ${resolvedTickets.length} lösta, snittlösningstid ${avgResolutionDays ?? 'okänd'} dagar`,
      `Antal fastigheter: ${properties.length}`,
    ].join('\n')

    let aiInsights = ''
    try {
      aiInsights = await this.ai.generateMonthlyInsights(organizationId, monthSummary)
    } catch (err) {
      this.logger.warn(
        `Månadsrapport-insikter misslyckades för org ${organizationId}: ${String(err)}`,
      )
    }

    return {
      header: {
        monthLabel,
        organizationName: org.name,
        organizationAddress: `${org.street}, ${org.postalCode} ${org.city}`,
        generatedAt: now.toLocaleDateString('sv-SE', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }),
      },
      brand: {
        logoDataUrl,
        primaryColor: org.invoiceColor ?? null,
        secondaryColor: org.brandSecondaryColor ?? null,
        brandFont: org.brandFont ?? null,
        org: {
          name: org.name,
          orgNumber: org.orgNumber ?? null,
          street: org.street ?? null,
          postalCode: org.postalCode ?? null,
          city: org.city ?? null,
        },
      },
      summary: {
        revenue: {
          current: revenueTotal,
          prevMonthPct: pctChange(revenueTotal, prevMonthRevenue),
          prevYearPct: pctChange(revenueTotal, prevYearRevenue),
        },
        occupancy: {
          currentPct: report.occupancy,
          prevMonthDeltaPct: prevMonthOccupancy > 0 ? report.occupancy - prevMonthOccupancy : null,
        },
        overdue: { count: overdueCount, totalAmount: overdueAmount, over30Count },
        tenants: { newLeases: report.newLeases, terminatedLeases: report.terminatedLeases },
      },
      kpis: {
        revenue: {
          total: revenueTotal,
          rent,
          service,
          utility,
          deposit,
          other,
          paid: report.paidRevenue,
        },
        occupancy: { totalUnits, occupied, vacant, renovation, reserved, ratePct },
        payments: { onTime, late1to7, late8to30, late30plus },
        maintenance: {
          incoming: incomingTickets,
          resolved: resolvedTickets.length,
          avgResolutionDays,
          topProperties,
        },
      },
      properties: propertyRows,
      appendix: { newLeases: newLeaseRows, terminatedLeases: terminatedLeaseRows },
      aiInsights,
    }
  }
}
