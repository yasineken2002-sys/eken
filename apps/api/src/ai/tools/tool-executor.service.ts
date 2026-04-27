import { Injectable, ForbiddenException } from '@nestjs/common'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Prisma } from '@prisma/client'
import type { InvoiceStatus, LeaseStatus } from '@prisma/client'
import { PrismaService } from '../../common/prisma/prisma.service'
import { InvoicesService } from '../../invoices/invoices.service'
import { PdfService } from '../../invoices/pdf.service'
import { TenantsService } from '../../tenants/tenants.service'
import { LeasesService } from '../../leases/leases.service'
import { PropertiesService } from '../../properties/properties.service'
import { UnitsService } from '../../units/units.service'
import { AccountingService } from '../../accounting/accounting.service'
import { MailService } from '../../mail/mail.service'
import { MaintenanceService } from '../../maintenance/maintenance.service'
import { AviseringService } from '../../avisering/avisering.service'
import { InspectionsService } from '../../inspections/inspections.service'
import { MaintenancePlanService } from '../../maintenance-plan/maintenance-plan.service'
import { ACTION_TOOLS } from './ai-tools.definition'

export interface ToolResult {
  success: boolean
  data?: unknown
  message: string
  downloadUrl?: string
  nextSteps?: string[]
  suggestCreateTenant?: boolean
  tenantName?: string
}

// Tools MANAGER is allowed to use (beyond read tools)
const MANAGER_ALLOWED_ACTIONS = new Set([
  'create_invoice',
  'create_bulk_invoices',
  'send_invoice_email',
  'send_overdue_reminders',
  'mark_invoice_paid',
  'compose_and_send_email',
])

function formatAmount(n: number): string {
  return n.toLocaleString('sv-SE')
}

function parseSwedishAmount(input: unknown): number | null {
  if (typeof input === 'number') return input
  if (typeof input !== 'string') return null
  const cleaned = input
    .replace(/\s/g, '')
    .replace(/kr/gi, '')
    .replace(/,/g, '.')
    .replace(/[^\d.]/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function parseSwedishDate(input: unknown): Date {
  if (!input) return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const s = String(input).toLowerCase().trim()

  if (s.includes('idag') || s.includes('today')) return new Date()

  const daysMatch = s.match(/om\s*(\d+)\s*dag/)
  if (daysMatch?.[1]) {
    return new Date(Date.now() + parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000)
  }

  const monthsMatch = s.match(/om\s*(\d+)\s*månad/)
  if (monthsMatch?.[1]) {
    const d = new Date()
    d.setMonth(d.getMonth() + parseInt(monthsMatch[1]))
    return d
  }

  const date = new Date(s)
  if (!isNaN(date.getTime())) return date

  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
}

type TenantLike = {
  id: string
  type: string
  firstName?: string | null
  lastName?: string | null
  companyName?: string | null
  email: string
}

function fuzzyFindTenant(name: string, tenants: TenantLike[]): TenantLike | null {
  const q = name.toLowerCase().trim()

  const exact = tenants.find((t) => {
    const full =
      t.type === 'INDIVIDUAL'
        ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.toLowerCase().trim()
        : (t.companyName ?? '').toLowerCase()
    return full === q || t.email.toLowerCase() === q
  })
  if (exact) return exact

  const partial = tenants.filter((t) => {
    const full =
      t.type === 'INDIVIDUAL'
        ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.toLowerCase()
        : (t.companyName ?? '').toLowerCase()
    return (
      full.includes(q) ||
      q.includes((t.firstName ?? '').toLowerCase()) ||
      q.includes((t.lastName ?? '').toLowerCase()) ||
      t.email.toLowerCase().includes(q)
    )
  })

  return partial.length === 1 ? (partial[0] ?? null) : null
}

function detectInvoiceType(description: string): string {
  const d = description.toLowerCase()
  if (d.includes('hyra') || d.includes('rent')) return 'RENT'
  if (d.includes('deposition') || d.includes('deposit')) return 'DEPOSIT'
  if (d.includes('el') || d.includes('vatten') || d.includes('värme') || d.includes('drift'))
    return 'UTILITY'
  if (d.includes('service') || d.includes('avgift')) return 'SERVICE'
  return 'OTHER'
}

function sanityCheckInvoice(amount: number, vatRate: number | undefined, dueDate: Date): string[] {
  const warnings: string[] = []
  if (amount <= 0) warnings.push('Beloppet måste vara positivt')
  if (amount > 500000)
    warnings.push(
      `Beloppet ${formatAmount(amount)} kr är ovanligt högt — verifiera att det är korrekt`,
    )
  if (vatRate !== undefined && vatRate !== 0 && vatRate !== 6 && vatRate !== 12 && vatRate !== 25)
    warnings.push(`Momssatsen ${vatRate}% är ovanlig — vanliga satser är 0%, 6%, 12%, 25%`)
  const now = new Date()
  if (dueDate < new Date(now.getTime() - 24 * 60 * 60 * 1000))
    warnings.push(`Förfallodatumet ${dueDate.toISOString().slice(0, 10)} är i förfluten tid`)
  const maxFuture = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000)
  if (dueDate > maxFuture)
    warnings.push(`Förfallodatumet ${dueDate.toISOString().slice(0, 10)} är mer än 1 år framåt`)
  return warnings
}

function translateUnitType(type: string): string {
  const map: Record<string, string> = {
    APARTMENT: 'Lägenhet',
    HOUSE: 'Hus',
    OFFICE: 'Kontor',
    RETAIL: 'Butik',
    STORAGE: 'Förråd',
    PARKING: 'Parkering',
    OTHER: 'Övrigt',
  }
  return map[type] ?? type
}

function sanityCheckLease(
  monthlyRent: number,
  startDate: Date,
  endDate: Date | undefined,
): string[] {
  const warnings: string[] = []
  if (monthlyRent <= 0) warnings.push('Hyran måste vara positiv')
  if (monthlyRent > 200000)
    warnings.push(
      `Hyran ${formatAmount(monthlyRent)} kr/mån är ovanligt hög — verifiera att det är korrekt`,
    )
  if (endDate && endDate <= startDate)
    warnings.push(
      `Slutdatumet ${endDate.toISOString().slice(0, 10)} är före startdatumet ${startDate.toISOString().slice(0, 10)}`,
    )
  const fiveYearsAgo = new Date()
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5)
  if (startDate < fiveYearsAgo)
    warnings.push(
      `Startdatumet ${startDate.toISOString().slice(0, 10)} är mer än 5 år tillbaka — är det korrekt?`,
    )
  return warnings
}

function translatePriority(priority: string): string {
  const map: Record<string, string> = { URGENT: 'Akut', HIGH: 'Hög', NORMAL: 'Normal', LOW: 'Låg' }
  return map[priority] ?? priority
}

function translateMaintenanceStatus(status: string): string {
  const map: Record<string, string> = {
    NEW: 'Ny',
    IN_PROGRESS: 'Pågår',
    SCHEDULED: 'Schemalagd',
    COMPLETED: 'Åtgärdad',
    CLOSED: 'Stängd',
    CANCELLED: 'Avbruten',
  }
  return map[status] ?? status
}

@Injectable()
export class ToolExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoicesService: InvoicesService,
    private readonly pdfService: PdfService,
    private readonly tenantsService: TenantsService,
    private readonly leasesService: LeasesService,
    private readonly propertiesService: PropertiesService,
    private readonly unitsService: UnitsService,
    private readonly accountingService: AccountingService,
    private readonly mailService: MailService,
    private readonly maintenanceService: MaintenanceService,
    private readonly aviseringService: AviseringService,
    private readonly inspectionsService: InspectionsService,
    private readonly maintenancePlanService: MaintenancePlanService,
  ) {}

  async executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    organizationId: string,
    userId: string,
    userRole: string,
  ): Promise<ToolResult> {
    // ── Role guards (propagate as HTTP exceptions) ────────────────────────────

    if (ACTION_TOOLS.has(toolName)) {
      if (userRole === 'VIEWER') {
        throw new ForbiddenException('Du har inte behörighet att utföra åtgärder.')
      }
      if (userRole === 'MANAGER' && !MANAGER_ALLOWED_ACTIONS.has(toolName)) {
        throw new ForbiddenException('Du har inte behörighet för denna åtgärd.')
      }
    }

    // ── Tool execution — FIX 4: top-level try/catch ───────────────────────────

    try {
      switch (toolName) {
        // ── READ TOOLS ──────────────────────────────────────────────────────

        case 'get_dashboard_stats': {
          const [invoiceCounts, tenantCount, propertyCount, leaseCounts, paidRevenue] =
            await Promise.all([
              this.prisma.invoice.groupBy({
                by: ['status'],
                where: { organizationId },
                _count: { id: true },
                _sum: { total: true },
              }),
              this.prisma.tenant.count({ where: { organizationId } }),
              this.prisma.property.count({ where: { organizationId } }),
              this.prisma.lease.groupBy({
                by: ['status'],
                where: { organizationId },
                _count: { id: true },
              }),
              this.prisma.invoice.aggregate({
                where: { organizationId, status: 'PAID' },
                _sum: { total: true },
              }),
            ])

          const byStatus: Record<string, number> = {}
          for (const row of invoiceCounts) {
            byStatus[row.status] = row._count.id
          }
          const leaseByStatus: Record<string, number> = {}
          for (const row of leaseCounts) {
            leaseByStatus[row.status] = row._count.id
          }

          return {
            success: true,
            data: {
              invoices: byStatus,
              tenantCount,
              propertyCount,
              leases: leaseByStatus,
              totalPaidRevenue: Number(paidRevenue._sum.total ?? 0),
            },
            message: 'Dashboard-statistik hämtad',
          }
        }

        case 'get_overdue_invoices': {
          const invoices = await this.prisma.invoice.findMany({
            where: { organizationId, status: 'OVERDUE' },
            include: {
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
            },
            orderBy: { dueDate: 'asc' },
          })
          return {
            success: true,
            data: invoices,
            message: `${invoices.length} förfallna fakturor hittades`,
          }
        }

        case 'get_expiring_leases': {
          const days = typeof toolInput.days === 'number' ? toolInput.days : 90
          const cutoff = new Date()
          cutoff.setDate(cutoff.getDate() + days)

          const leases = await this.prisma.lease.findMany({
            where: {
              organizationId,
              status: 'ACTIVE',
              endDate: { not: null, lte: cutoff },
            },
            include: {
              tenant: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  companyName: true,
                  type: true,
                },
              },
              unit: {
                select: {
                  id: true,
                  name: true,
                  unitNumber: true,
                  property: { select: { id: true, name: true } },
                },
              },
            },
            orderBy: { endDate: 'asc' },
          })
          return {
            success: true,
            data: leases,
            message: `${leases.length} kontrakt löper ut inom ${days} dagar`,
          }
        }

        case 'get_tenants': {
          const search = typeof toolInput.search === 'string' ? toolInput.search : undefined
          const tenants = await this.tenantsService.findAll(organizationId, search)
          return {
            success: true,
            data: tenants,
            message: `${tenants.length} hyresgäster hittades`,
          }
        }

        case 'get_invoices': {
          const status =
            typeof toolInput.status === 'string' ? (toolInput.status as InvoiceStatus) : undefined
          const invoices = await this.invoicesService.findAll(
            organizationId,
            status ? { status } : undefined,
          )
          return {
            success: true,
            data: invoices,
            message: `${invoices.length} fakturor hittades`,
          }
        }

        case 'get_properties': {
          const properties = await this.propertiesService.findAll(organizationId)
          return {
            success: true,
            data: properties,
            message: `${properties.length} fastigheter hittades`,
          }
        }

        case 'get_revenue_report': {
          const from = toolInput.from as string
          const to = toolInput.to as string

          const invoices = await this.prisma.invoice.findMany({
            where: {
              organizationId,
              status: 'PAID',
              paidAt: { gte: new Date(from), lte: new Date(to) },
            },
            select: { total: true, paidAt: true },
          })

          const byMonth = new Map<string, number>()
          for (const inv of invoices) {
            if (!inv.paidAt) continue
            const key = inv.paidAt.toISOString().slice(0, 7)
            byMonth.set(key, (byMonth.get(key) ?? 0) + Number(inv.total))
          }

          const totalRevenue = invoices.reduce((sum, inv) => sum + Number(inv.total), 0)

          return {
            success: true,
            data: {
              totalRevenue,
              byMonth: Array.from(byMonth.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([month, amount]) => ({ month, amount })),
            },
            message: `Intäktsrapport för ${from} till ${to}: ${totalRevenue.toFixed(2)} SEK totalt`,
          }
        }

        // ── ACTION TOOLS ────────────────────────────────────────────────────

        case 'create_invoice': {
          // Parse amount with Swedish format support ("8323kr", "8 323", etc.)
          const amount = parseSwedishAmount(toolInput.amount)
          if (amount === null) {
            return {
              success: false,
              message: `Ogiltigt belopp: "${String(toolInput.amount)}". Ange t.ex. "8323" eller "8 323 kr".`,
            }
          }

          // Resolve tenant: fuzzy name match with smart error recovery
          const tenantNameInput = toolInput.tenantName as string | undefined
          const allTenants = await this.tenantsService.findAll(organizationId)
          const displayName = (t: TenantLike): string =>
            t.type === 'INDIVIDUAL'
              ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
              : (t.companyName ?? '')

          let resolvedTenant: TenantLike | null = null

          // Try tenantId first if provided
          if (toolInput.tenantId) {
            resolvedTenant = allTenants.find((t) => t.id === (toolInput.tenantId as string)) ?? null
          }

          // Fall back to fuzzy name match
          if (!resolvedTenant && tenantNameInput) {
            resolvedTenant = fuzzyFindTenant(tenantNameInput, allTenants)
          }

          if (!resolvedTenant) {
            const names = allTenants.map((t) => `${displayName(t)} (${t.email})`).join(', ')
            return {
              success: false,
              suggestCreateTenant: true,
              tenantName: tenantNameInput ?? '',
              message: `Hittade ingen hyresgäst med namnet "${tenantNameInput ?? ''}". Tillgängliga hyresgäster: ${names || 'inga'}. Vill du skapa en ny hyresgäst med detta namn och sedan fakturan?`,
            }
          }

          const resolvedName = displayName(resolvedTenant)

          // Detect invoice type from description if not provided or generic
          const description = (toolInput.description as string | undefined)?.trim() || 'Övrigt'
          const invoiceType = (
            toolInput.type && toolInput.type !== 'OTHER'
              ? toolInput.type
              : detectInvoiceType(description)
          ) as 'RENT' | 'DEPOSIT' | 'SERVICE' | 'UTILITY' | 'OTHER'

          const dueDateParsed = parseSwedishDate(toolInput.dueDate)

          // Sanity check
          const invoiceSanityWarnings = sanityCheckInvoice(
            amount,
            toolInput.vatRate as number | undefined,
            dueDateParsed,
          )
          if (invoiceSanityWarnings.length > 0) {
            return {
              success: false,
              message: `Valideringsfel:\n${invoiceSanityWarnings.map((w) => `• ${w}`).join('\n')}`,
            }
          }

          // Fakturor måste kopplas till ett hyresavtal. Slå upp aktivt avtal
          // för hyresgästen — om flera finns, välj det senast påbörjade.
          const tenantLease = await this.prisma.lease.findFirst({
            where: {
              tenantId: resolvedTenant.id,
              status: { in: ['ACTIVE', 'DRAFT'] },
              unit: { property: { organizationId } },
            },
            orderBy: { startDate: 'desc' },
            select: { id: true },
          })
          if (!tenantLease) {
            return {
              success: false,
              message: `Kan inte skapa faktura: ${resolvedName} saknar aktivt hyresavtal. Skapa ett avtal först.`,
            }
          }

          const invoice = await this.invoicesService.create(organizationId, userId, {
            leaseId: tenantLease.id,
            type: invoiceType,
            issueDate: new Date().toISOString(),
            dueDate: dueDateParsed.toISOString(),
            lines: [
              {
                description,
                quantity: 1,
                unitPrice: amount,
                vatRate: (toolInput.vatRate as number) ?? 0,
              },
            ],
          })

          return {
            success: true,
            data: invoice,
            message: [
              `Faktura ${invoice.invoiceNumber} skapad för ${resolvedName}`,
              `Belopp: ${formatAmount(Number(invoice.total))} kr`,
              `Förfaller: ${invoice.dueDate.toISOString().slice(0, 10)}`,
              `Status: Utkast — kom ihåg att skicka den till hyresgästen!`,
            ].join('\n'),
            nextSteps: [
              `Skicka fakturan till ${resolvedTenant.email} via e-post`,
              `Sätt upp automatisk påminnelse`,
              `Skapa fler fakturor för kommande månader`,
            ],
          }
        }

        case 'create_bulk_invoices': {
          const month = toolInput.month as number
          const year = toolInput.year as number
          const firstDay = new Date(year, month - 1, 1)
          const lastDay = new Date(year, month, 0)

          const result = await this.invoicesService.createBulk(organizationId, userId, {
            issueDate: firstDay.toISOString(),
            dueDate: lastDay.toISOString(),
            vatRate: (toolInput.vatRate as number) ?? 0,
          })
          return {
            success: true,
            data: result,
            message: `${result.created} fakturor skapade för ${month}/${year}`,
          }
        }

        case 'update_tenant': {
          // FIX 2: verify tenantId belongs to org
          const updateTenantId = toolInput.tenantId as string
          const tenantCheck = await this.prisma.tenant.findFirst({
            where: { id: updateTenantId, organizationId },
            select: { id: true },
          })
          if (!tenantCheck) {
            return {
              success: false,
              message: `Hyresgäst med id "${updateTenantId}" hittades inte. Anropa get_tenants för att hitta rätt id.`,
            }
          }

          const updated = await this.tenantsService.update(
            updateTenantId,
            {
              ...(toolInput.email ? { email: toolInput.email as string } : {}),
              ...(toolInput.phone ? { phone: toolInput.phone as string } : {}),
            },
            organizationId,
          )
          return {
            success: true,
            data: updated,
            message: `${toolInput.tenantName as string} uppdaterad`,
          }
        }

        case 'send_invoice_email': {
          // FIX 2: verify invoiceId belongs to org
          const sendInvoiceId = toolInput.invoiceId as string
          const invoiceEmailCheck = await this.prisma.invoice.findFirst({
            where: { id: sendInvoiceId, organizationId },
            select: { id: true },
          })
          if (!invoiceEmailCheck) {
            return {
              success: false,
              message: `Faktura med id "${sendInvoiceId}" hittades inte. Anropa get_invoices för att hitta rätt invoiceId.`,
            }
          }

          await this.invoicesService.sendInvoiceEmail(sendInvoiceId, organizationId, userId)
          return {
            success: true,
            message: `Faktura ${toolInput.invoiceNumber as string} skickad till ${toolInput.tenantEmail as string}`,
          }
        }

        case 'send_overdue_reminders': {
          const invoiceIds = toolInput.invoiceIds as string[] | undefined

          const overdueInvoices = await this.prisma.invoice.findMany({
            where: {
              organizationId,
              status: 'OVERDUE',
              ...(invoiceIds && invoiceIds.length > 0 ? { id: { in: invoiceIds } } : {}),
            },
            include: {
              tenant: {
                select: {
                  firstName: true,
                  lastName: true,
                  companyName: true,
                  type: true,
                  email: true,
                },
              },
              organization: { select: { name: true } },
            },
          })

          let sent = 0
          for (const inv of overdueInvoices) {
            if (!inv.tenant?.email) continue
            const tenantName =
              inv.tenant.type === 'INDIVIDUAL'
                ? `${inv.tenant.firstName ?? ''} ${inv.tenant.lastName ?? ''}`.trim()
                : (inv.tenant.companyName ?? '')

            try {
              await this.mailService.sendOverdueReminder({
                to: inv.tenant.email,
                tenantName,
                invoiceNumber: inv.invoiceNumber,
                total: Number(inv.total),
                dueDate: inv.dueDate,
                organizationName: inv.organization.name,
              })
              sent++
            } catch {
              console.warn(`Kunde inte skicka påminnelse för faktura ${inv.invoiceNumber}`)
            }
          }

          return {
            success: true,
            message: `Betalningspåminnelser skickade till ${sent} av ${overdueInvoices.length} hyresgäster`,
          }
        }

        case 'mark_invoice_paid': {
          // FIX 2: verify invoiceId belongs to org
          const paidInvoiceId = toolInput.invoiceId as string
          const paidInvoiceCheck = await this.prisma.invoice.findFirst({
            where: { id: paidInvoiceId, organizationId },
            select: { id: true },
          })
          if (!paidInvoiceCheck) {
            return {
              success: false,
              message: `Faktura med id "${paidInvoiceId}" hittades inte. Anropa get_invoices för att hitta rätt invoiceId.`,
            }
          }

          await this.invoicesService.transitionStatus(
            paidInvoiceId,
            organizationId,
            'PAID',
            userId,
            'USER',
            { paymentDate: toolInput.paymentDate ?? new Date().toISOString() },
          )
          const paidAmount = parseSwedishAmount(toolInput.amount) ?? (toolInput.amount as number)
          return {
            success: true,
            message: `Faktura ${toolInput.invoiceNumber as string} markerad som betald (${paidAmount.toFixed(2)} kr)`,
            nextSteps: [`Skapa nästa månads faktura`, `Visa betalningshistorik`],
          }
        }

        case 'create_lease': {
          // FIX 2: verify tenantId and unitId belong to org
          const leaseTenantId = toolInput.tenantId as string
          const leaseUnitId = toolInput.unitId as string

          const leaseTenantCheck = await this.prisma.tenant.findFirst({
            where: { id: leaseTenantId, organizationId },
            select: { id: true },
          })
          if (!leaseTenantCheck) {
            return {
              success: false,
              message: `Hyresgäst med id "${leaseTenantId}" hittades inte. Anropa get_tenants för att hitta rätt tenantId.`,
            }
          }

          const leaseUnitCheck = await this.prisma.unit.findFirst({
            where: { id: leaseUnitId, property: { organizationId } },
            select: { id: true },
          })
          if (!leaseUnitCheck) {
            return {
              success: false,
              message: `Enhet med id "${leaseUnitId}" hittades inte i din organisation. Anropa get_properties för att hitta rätt unitId.`,
            }
          }

          const monthlyRent = parseSwedishAmount(toolInput.monthlyRent)
          if (monthlyRent === null) {
            return {
              success: false,
              message: `Ogiltigt hyresbelopp: "${String(toolInput.monthlyRent)}". Ange t.ex. "8000" eller "8 000 kr".`,
            }
          }

          const leaseStartDate = parseSwedishDate(toolInput.startDate)
          const leaseEndDate = toolInput.endDate ? parseSwedishDate(toolInput.endDate) : undefined

          // Sanity check
          const leaseSanityWarnings = sanityCheckLease(monthlyRent, leaseStartDate, leaseEndDate)
          if (leaseSanityWarnings.length > 0) {
            return {
              success: false,
              message: `Valideringsfel:\n${leaseSanityWarnings.map((w) => `• ${w}`).join('\n')}`,
            }
          }

          const lease = await this.leasesService.create(
            {
              tenantId: leaseTenantId,
              unitId: leaseUnitId,
              monthlyRent,
              startDate: leaseStartDate.toISOString(),
              depositAmount: 0,
              ...(leaseEndDate ? { endDate: leaseEndDate.toISOString() } : {}),
            },
            organizationId,
          )
          const leaseTenantName = toolInput.tenantName as string
          return {
            success: true,
            data: lease,
            message: `Kontrakt skapat för ${leaseTenantName} i ${toolInput.unitName as string}`,
            nextSteps: [
              `Skapa en hyresfaktura för ${leaseTenantName}`,
              `Ladda upp kontraktsdokument`,
            ],
          }
        }

        case 'transition_lease_status': {
          // FIX 2: verify leaseId belongs to org
          const transLeaseId = toolInput.leaseId as string
          const leaseStatusCheck = await this.prisma.lease.findFirst({
            where: { id: transLeaseId, organizationId },
            select: { id: true },
          })
          if (!leaseStatusCheck) {
            return {
              success: false,
              message: `Kontrakt med id "${transLeaseId}" hittades inte. Anropa get_expiring_leases eller liknande för att hitta rätt leaseId.`,
            }
          }

          await this.leasesService.transitionStatus(
            transLeaseId,
            toolInput.newStatus as LeaseStatus,
            organizationId,
          )
          const statusLabel = toolInput.newStatus === 'ACTIVE' ? 'aktiverat' : 'avslutat'
          return {
            success: true,
            message: `Kontrakt för ${toolInput.tenantName as string} ${statusLabel}`,
          }
        }

        case 'create_property': {
          const property = await this.propertiesService.create(organizationId, {
            name: toolInput.name as string,
            propertyDesignation: toolInput.propertyDesignation as string,
            type: toolInput.type as 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED' | 'INDUSTRIAL' | 'LAND',
            address: {
              street: toolInput.street as string,
              city: toolInput.city as string,
              postalCode: toolInput.postalCode as string,
              country: 'SE',
            },
            totalArea: 1,
          })
          return {
            success: true,
            data: property,
            message: `Fastighet "${toolInput.name as string}" skapad`,
          }
        }

        case 'create_unit': {
          // FIX 2: verify propertyId belongs to org
          const unitPropertyId = toolInput.propertyId as string
          const propertyCheck = await this.prisma.property.findFirst({
            where: { id: unitPropertyId, organizationId },
            select: { id: true },
          })
          if (!propertyCheck) {
            return {
              success: false,
              message: `Fastighet med id "${unitPropertyId}" hittades inte. Anropa get_properties för att hitta rätt propertyId.`,
            }
          }

          const unit = await this.unitsService.create(
            {
              propertyId: unitPropertyId,
              name: toolInput.name as string,
              unitNumber: toolInput.unitNumber as string,
              type: toolInput.type as
                | 'APARTMENT'
                | 'OFFICE'
                | 'RETAIL'
                | 'STORAGE'
                | 'PARKING'
                | 'OTHER',
              area: toolInput.area as number,
              monthlyRent:
                parseSwedishAmount(toolInput.monthlyRent) ?? (toolInput.monthlyRent as number),
            },
            organizationId,
          )
          return {
            success: true,
            data: unit,
            message: `Enhet "${toolInput.name as string}" skapad i ${toolInput.propertyName as string}`,
          }
        }

        case 'export_sie4': {
          const from = toolInput.from as string
          const to = toolInput.to as string
          const buffer = await this.accountingService.exportSie4(organizationId, from, to)
          return {
            success: true,
            data: { base64: buffer.toString('base64') },
            downloadUrl: `/api/v1/accounting/journal?from=${from}&to=${to}`,
            message: `SIE4-fil genererad för perioden ${from} till ${to}`,
          }
        }

        case 'compose_and_send_email': {
          const emailTenantIds = toolInput.tenantIds as string[]
          const subject = toolInput.subject as string
          const body = toolInput.body as string

          const emailTenants = await this.prisma.tenant.findMany({
            where: { id: { in: emailTenantIds }, organizationId },
            select: {
              id: true,
              type: true,
              firstName: true,
              lastName: true,
              companyName: true,
              email: true,
            },
          })

          if (emailTenants.length === 0) {
            return {
              success: false,
              message: 'Inga giltiga hyresgäster hittades för de angivna ID:na.',
            }
          }

          const emailOrg = await this.prisma.organization.findUnique({
            where: { id: organizationId },
            select: { name: true, invoiceColor: true },
          })

          let sentCount = 0
          const sendErrors: string[] = []

          for (const tenant of emailTenants) {
            const tenantName =
              tenant.type === 'INDIVIDUAL'
                ? `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()
                : (tenant.companyName ?? '')

            const personalizedBody = body.replace(/\{namn\}/gi, tenantName)

            const bodyHtml =
              `<p>Hej ${tenantName},</p>` +
              personalizedBody
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => `<p>${line}</p>`)
                .join('')

            try {
              await this.mailService.sendCustomEmail({
                to: tenant.email,
                subject,
                bodyHtml,
                tenantName,
                organizationName: emailOrg?.name ?? '',
                ...(emailOrg?.invoiceColor ? { accentColor: emailOrg.invoiceColor } : {}),
              })
              sentCount++
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              sendErrors.push(`${tenantName}: ${msg}`)
              console.warn(`Kunde inte skicka e-post till ${tenant.email}: ${msg}`)
            }
          }

          const recipientNames = emailTenants
            .map((t) =>
              t.type === 'INDIVIDUAL'
                ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
                : (t.companyName ?? ''),
            )
            .join(', ')

          if (sentCount === 0) {
            return {
              success: false,
              message: `Kunde inte skicka e-post. Fel: ${sendErrors.join('; ')}`,
            }
          }

          return {
            success: true,
            message: `E-post skickad till ${sentCount} hyresgäst${sentCount > 1 ? 'er' : ''}!\nÄmne: "${subject}"\nMottagare: ${recipientNames}`,
            nextSteps: ['Kontrollera att e-posten kom fram', 'Arkivera kommunikationen'],
          }
        }

        case 'analyze_payment_behavior': {
          const filterTenantId =
            typeof toolInput.tenantId === 'string' ? toolInput.tenantId : undefined

          const invoices = await this.prisma.invoice.findMany({
            where: {
              organizationId,
              ...(filterTenantId ? { tenantId: filterTenantId } : {}),
            },
            select: {
              tenantId: true,
              paidAt: true,
              dueDate: true,
              total: true,
              status: true,
              tenant: {
                select: {
                  id: true,
                  type: true,
                  firstName: true,
                  lastName: true,
                  companyName: true,
                },
              },
            },
          })

          const tenantMap = new Map<
            string,
            {
              name: string
              total: number
              paidOnTime: number
              late: number
              lateDaysSum: number
              outstanding: number
            }
          >()

          for (const inv of invoices) {
            if (!inv.tenantId || !inv.tenant) continue
            const tenantName =
              inv.tenant.type === 'INDIVIDUAL'
                ? `${inv.tenant.firstName ?? ''} ${inv.tenant.lastName ?? ''}`.trim()
                : (inv.tenant.companyName ?? '')

            if (!tenantMap.has(inv.tenantId)) {
              tenantMap.set(inv.tenantId, {
                name: tenantName,
                total: 0,
                paidOnTime: 0,
                late: 0,
                lateDaysSum: 0,
                outstanding: 0,
              })
            }
            const entry = tenantMap.get(inv.tenantId)!
            entry.total++

            if (inv.paidAt) {
              const lateDays = Math.floor(
                (inv.paidAt.getTime() - inv.dueDate.getTime()) / (1000 * 60 * 60 * 24),
              )
              if (lateDays <= 0) {
                entry.paidOnTime++
              } else {
                entry.late++
                entry.lateDaysSum += lateDays
              }
            }
            if (inv.status === 'SENT' || inv.status === 'OVERDUE') {
              entry.outstanding += Number(inv.total)
            }
          }

          if (tenantMap.size === 0) {
            return { success: true, data: {}, message: 'Inga fakturor hittades.' }
          }

          const lines: string[] = ['BETALNINGSBETEENDE PER HYRESGÄST:']
          for (const [, entry] of tenantMap) {
            const onTimePct =
              entry.total > 0 ? Math.round((entry.paidOnTime / entry.total) * 100) : 0
            const avgLate = entry.late > 0 ? Math.round(entry.lateDaysSum / entry.late) : 0
            lines.push(
              `  ${entry.name}: ${entry.total} fakturor, ${onTimePct}% i tid` +
                (entry.late > 0 ? `, genomsnittlig försening ${avgLate} dagar` : '') +
                (entry.outstanding > 0
                  ? `, utestående: ${formatAmount(entry.outstanding)} kr`
                  : ''),
            )
          }

          return {
            success: true,
            data: Object.fromEntries(tenantMap),
            message: lines.join('\n'),
          }
        }

        case 'compare_revenue': {
          const p1From = new Date(toolInput.period1From as string)
          const p1To = new Date(toolInput.period1To as string)
          const p2From = new Date(toolInput.period2From as string)
          const p2To = new Date(toolInput.period2To as string)

          const [period1Invoices, period2Invoices] = await Promise.all([
            this.prisma.invoice.findMany({
              where: { organizationId, status: 'PAID', paidAt: { gte: p1From, lte: p1To } },
              select: { total: true, paidAt: true },
            }),
            this.prisma.invoice.findMany({
              where: { organizationId, status: 'PAID', paidAt: { gte: p2From, lte: p2To } },
              select: { total: true, paidAt: true },
            }),
          ])

          const total1 = period1Invoices.reduce((s, i) => s + Number(i.total), 0)
          const total2 = period2Invoices.reduce((s, i) => s + Number(i.total), 0)
          const diff = total2 - total1
          const pctChange = total1 > 0 ? Math.round((diff / total1) * 100) : null

          const byMonth1 = new Map<string, number>()
          for (const inv of period1Invoices) {
            if (!inv.paidAt) continue
            const key = inv.paidAt.toISOString().slice(0, 7)
            byMonth1.set(key, (byMonth1.get(key) ?? 0) + Number(inv.total))
          }
          const byMonth2 = new Map<string, number>()
          for (const inv of period2Invoices) {
            if (!inv.paidAt) continue
            const key = inv.paidAt.toISOString().slice(0, 7)
            byMonth2.set(key, (byMonth2.get(key) ?? 0) + Number(inv.total))
          }

          const changeStr =
            pctChange !== null
              ? `${diff >= 0 ? '+' : ''}${formatAmount(diff)} kr (${diff >= 0 ? '+' : ''}${pctChange}%)`
              : `${diff >= 0 ? '+' : ''}${formatAmount(diff)} kr`

          const lines: string[] = [
            `Period 1 (${toolInput.period1From as string}–${toolInput.period1To as string}): ${formatAmount(total1)} kr`,
            `Period 2 (${toolInput.period2From as string}–${toolInput.period2To as string}): ${formatAmount(total2)} kr`,
            `Förändring: ${changeStr}`,
          ]

          const allMonths = [...new Set([...byMonth1.keys(), ...byMonth2.keys()])].sort()
          if (allMonths.length > 1) {
            lines.push('', 'Månadsvis:')
            for (const m of allMonths) {
              const v1 = byMonth1.get(m) ?? 0
              const v2 = byMonth2.get(m) ?? 0
              lines.push(`  ${m}: Period1=${formatAmount(v1)} kr, Period2=${formatAmount(v2)} kr`)
            }
          }

          return {
            success: true,
            data: { total1, total2, diff, pctChange },
            message: lines.join('\n'),
          }
        }

        case 'predict_cashflow': {
          const monthsAhead = typeof toolInput.months === 'number' ? toolInput.months : 3

          const activeLeases = await this.prisma.lease.findMany({
            where: { organizationId, status: 'ACTIVE' },
            select: {
              id: true,
              monthlyRent: true,
              startDate: true,
              endDate: true,
              tenant: {
                select: { firstName: true, lastName: true, companyName: true, type: true },
              },
            },
          })

          const now = new Date()
          const lines: string[] = ['KASSAFLÖDESPROGNOS:']
          let grandTotal = 0

          for (let i = 1; i <= monthsAhead; i++) {
            const monthStart = new Date(now.getFullYear(), now.getMonth() + i, 1)
            const monthEnd = new Date(now.getFullYear(), now.getMonth() + i + 1, 0)

            const activeForMonth = activeLeases.filter((lease) => {
              const started = new Date(lease.startDate) <= monthEnd
              const notEnded = !lease.endDate || new Date(lease.endDate) >= monthStart
              return started && notEnded
            })

            const monthIncome = activeForMonth.reduce((sum, l) => sum + Number(l.monthlyRent), 0)
            grandTotal += monthIncome

            const monthLabel = monthStart.toLocaleDateString('sv-SE', {
              year: 'numeric',
              month: 'long',
            })
            lines.push(
              `  ${monthLabel}: ${formatAmount(monthIncome)} kr (${activeForMonth.length} kontrakt)`,
            )
          }

          lines.push(``, `Totalt ${monthsAhead} månader: ${formatAmount(grandTotal)} kr`)

          return {
            success: true,
            data: { monthsAhead, grandTotal },
            message: lines.join('\n'),
          }
        }

        case 'find_optimization_opportunities': {
          const now = new Date()
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          const sixtyDaysFromNow = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000)
          const threeYearsAgo = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate())

          const [vacantUnits, activeLeases, overdueOld, expiringLeases] = await Promise.all([
            this.prisma.unit.findMany({
              where: {
                property: { organizationId },
                status: 'VACANT',
                updatedAt: { lte: thirtyDaysAgo },
              },
              select: {
                id: true,
                name: true,
                unitNumber: true,
                type: true,
                monthlyRent: true,
                updatedAt: true,
                property: { select: { name: true } },
              },
            }),
            this.prisma.lease.findMany({
              where: { organizationId, status: 'ACTIVE' },
              select: {
                id: true,
                monthlyRent: true,
                startDate: true,
                endDate: true,
                unit: { select: { type: true, name: true, unitNumber: true } },
                tenant: {
                  select: {
                    type: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            }),
            this.prisma.invoice.findMany({
              where: { organizationId, status: 'OVERDUE', dueDate: { lte: thirtyDaysAgo } },
              select: {
                invoiceNumber: true,
                total: true,
                dueDate: true,
                tenant: {
                  select: {
                    type: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            }),
            this.prisma.lease.findMany({
              where: {
                organizationId,
                status: 'ACTIVE',
                endDate: { not: null, gte: now, lte: sixtyDaysFromNow },
              },
              select: {
                id: true,
                endDate: true,
                monthlyRent: true,
                unit: { select: { name: true, unitNumber: true } },
                tenant: {
                  select: {
                    type: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            }),
          ])

          const formatTenantName = (t: {
            type: string
            firstName?: string | null
            lastName?: string | null
            companyName?: string | null
          }) =>
            t.type === 'INDIVIDUAL'
              ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
              : (t.companyName ?? '')

          // Average rent per unit type from active leases
          const rentByType = new Map<string, { sum: number; count: number }>()
          for (const l of activeLeases) {
            const type = l.unit.type
            const cur = rentByType.get(type) ?? { sum: 0, count: 0 }
            cur.sum += Number(l.monthlyRent)
            cur.count++
            rentByType.set(type, cur)
          }

          const belowMarket = activeLeases.filter((l) => {
            const avg = rentByType.get(l.unit.type)
            if (!avg || avg.count < 2) return false
            return Number(l.monthlyRent) < (avg.sum / avg.count) * 0.85
          })

          const oldOpenEnded = activeLeases.filter(
            (l) => !l.endDate && new Date(l.startDate) < threeYearsAgo,
          )

          const opportunities: string[] = ['OPTIMERINGSMÖJLIGHETER (prioriterad):']

          if (overdueOld.length > 0) {
            const totalOverdue = overdueOld.reduce((s, i) => s + Number(i.total), 0)
            opportunities.push(
              `\n🔴 PRIORITET 1 — Förfallna fakturor >30 dagar (${overdueOld.length} st, ${formatAmount(totalOverdue)} kr):`,
            )
            for (const inv of overdueOld) {
              opportunities.push(
                `  - Faktura ${inv.invoiceNumber}, ${formatTenantName(inv.tenant)}, ${formatAmount(Number(inv.total))} kr, förföll ${inv.dueDate.toISOString().slice(0, 10)}`,
              )
            }
          }

          if (expiringLeases.length > 0) {
            opportunities.push(
              `\n🟠 PRIORITET 2 — Kontrakt löper ut inom 60 dagar (${expiringLeases.length} st):`,
            )
            for (const l of expiringLeases) {
              opportunities.push(
                `  - ${formatTenantName(l.tenant)}, ${l.unit.name} ${l.unit.unitNumber}, utgår ${l.endDate?.toISOString().slice(0, 10)}, hyra ${formatAmount(Number(l.monthlyRent))} kr/mån`,
              )
            }
          }

          if (vacantUnits.length > 0) {
            const totalLoss = vacantUnits.reduce((s, u) => s + Number(u.monthlyRent), 0)
            opportunities.push(
              `\n🟡 PRIORITET 3 — Vakanta enheter >30 dagar (${vacantUnits.length} st, inkomstbortfall ${formatAmount(totalLoss)} kr/mån):`,
            )
            for (const u of vacantUnits) {
              opportunities.push(
                `  - ${u.property.name} / ${u.name} ${u.unitNumber} (${u.type}), potential ${formatAmount(Number(u.monthlyRent))} kr/mån`,
              )
            }
          }

          if (belowMarket.length > 0) {
            opportunities.push(
              `\n🔵 PRIORITET 4 — Hyra under marknadsnivå (${belowMarket.length} kontrakt):`,
            )
            for (const l of belowMarket) {
              const avg = rentByType.get(l.unit.type)!
              const avgRent = Math.round(avg.sum / avg.count)
              opportunities.push(
                `  - ${formatTenantName(l.tenant)}, ${l.unit.name}: ${formatAmount(Number(l.monthlyRent))} kr/mån (snitt ${formatAmount(avgRent)} kr)`,
              )
            }
          }

          if (oldOpenEnded.length > 0) {
            opportunities.push(
              `\n⚪ PRIORITET 5 — Tillsvidareavtal äldre än 3 år (${oldOpenEnded.length} st):`,
            )
            for (const l of oldOpenEnded) {
              opportunities.push(
                `  - ${formatTenantName(l.tenant)}, startade ${new Date(l.startDate).toISOString().slice(0, 10)}, ${formatAmount(Number(l.monthlyRent))} kr/mån`,
              )
            }
          }

          if (opportunities.length === 1) {
            opportunities.push(
              'Inga optimeringsmöjligheter hittades just nu. Portföljen ser bra ut!',
            )
          }

          return {
            success: true,
            data: {
              overdueOldCount: overdueOld.length,
              expiringCount: expiringLeases.length,
              vacantCount: vacantUnits.length,
              belowMarketCount: belowMarket.length,
              oldOpenEndedCount: oldOpenEnded.length,
            },
            message: opportunities.join('\n'),
          }
        }

        case 'get_available_units': {
          const allProperties = await this.prisma.property.findMany({
            where: { organizationId },
          })

          let propertyWhere: { id: string; organizationId: string } | { organizationId: string } = {
            organizationId,
          }

          if (typeof toolInput.propertyId === 'string' && toolInput.propertyId) {
            propertyWhere = { id: toolInput.propertyId, organizationId }
          } else if (typeof toolInput.propertyName === 'string' && toolInput.propertyName) {
            const nameQuery = toolInput.propertyName.toLowerCase()
            const match = allProperties.find((p) => p.name.toLowerCase().includes(nameQuery))
            if (match) propertyWhere = { id: match.id, organizationId }
          }

          const properties = await this.prisma.property.findMany({
            where: propertyWhere,
            include: {
              units: { where: { status: 'VACANT' }, orderBy: { unitNumber: 'asc' } },
            },
          })

          if (properties.length === 0) {
            return {
              success: true,
              message:
                'Välj en fastighet:\n\n' +
                allProperties
                  .map((p, i) => `${i + 1}. ${p.name} (${p.propertyDesignation}) — ${p.city}`)
                  .join('\n'),
            }
          }

          const totalVacant = properties.reduce((s, p) => s + p.units.length, 0)

          if (totalVacant === 0) {
            return {
              success: true,
              message:
                `Inga lediga lägenheter hittades i ` +
                properties.map((p) => p.name).join(', ') +
                '.\nAlla enheter är uthyrda.',
            }
          }

          const result = properties
            .map((property) => {
              if (property.units.length === 0) return null
              return (
                `📍 ${property.name} (${property.city})\n` +
                property.units
                  .map(
                    (unit) =>
                      `  • ${unit.name} (nr ${unit.unitNumber})\n` +
                      `    Typ: ${translateUnitType(unit.type)}\n` +
                      `    Storlek: ${unit.area ? Number(unit.area) + ' m²' : 'ej angiven'}\n` +
                      `    Våning: ${unit.floor ?? 'ej angiven'}\n` +
                      `    Rum: ${unit.rooms ?? 'ej angiven'}\n` +
                      `    Hyra: ${Number(unit.monthlyRent).toLocaleString('sv-SE')} kr/mån\n` +
                      `    ID: ${unit.id}`,
                  )
                  .join('\n\n')
              )
            })
            .filter(Boolean)
            .join('\n\n---\n\n')

          return {
            success: true,
            data: { properties, totalVacant },
            message: result as string,
          }
        }

        case 'create_tenant_and_lease': {
          const unit = await this.prisma.unit.findFirst({
            where: { id: toolInput.unitId as string, property: { organizationId } },
          })
          if (!unit) {
            return {
              success: false,
              message:
                'Enheten hittades inte. Anropa get_available_units för att hitta rätt enhet.',
            }
          }
          if (unit.status !== 'VACANT') {
            return {
              success: false,
              message: `${toolInput.unitName as string} är inte ledig. Status: ${unit.status}`,
            }
          }

          const existing = await this.prisma.tenant.findFirst({
            where: { email: toolInput.email as string, organizationId },
          })

          const tenant =
            existing ??
            (await this.prisma.tenant.create({
              data: {
                organizationId,
                type: toolInput.tenantType as 'INDIVIDUAL' | 'COMPANY',
                ...(toolInput.firstName ? { firstName: toolInput.firstName as string } : {}),
                ...(toolInput.lastName ? { lastName: toolInput.lastName as string } : {}),
                ...(toolInput.companyName ? { companyName: toolInput.companyName as string } : {}),
                ...(toolInput.personalNumber
                  ? { personalNumber: toolInput.personalNumber as string }
                  : {}),
                email: toolInput.email as string,
                ...(toolInput.phone ? { phone: toolInput.phone as string } : {}),
              },
            }))

          const lease = await this.prisma.lease.create({
            data: {
              organizationId,
              unitId: toolInput.unitId as string,
              tenantId: tenant.id,
              monthlyRent: new Prisma.Decimal(toolInput.monthlyRent as number),
              depositAmount: new Prisma.Decimal(
                (toolInput.depositAmount as number | undefined) ?? 0,
              ),
              startDate: new Date(toolInput.startDate as string),
              ...(toolInput.endDate ? { endDate: new Date(toolInput.endDate as string) } : {}),
              status: 'ACTIVE',
            },
          })

          await this.prisma.unit.update({
            where: { id: toolInput.unitId as string },
            data: { status: 'OCCUPIED' },
          })

          const tenantName =
            tenant.type === 'INDIVIDUAL'
              ? `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()
              : (tenant.companyName ?? '')

          return {
            success: true,
            data: { tenant, lease },
            message:
              `Kontrakt skapat!\n\n` +
              `Hyresgäst: ${tenantName}${existing ? ' (befintlig)' : ' (ny)'}\n` +
              `Lägenhet: ${toolInput.unitName as string}, ${toolInput.propertyName as string}\n` +
              `Hyra: ${(toolInput.monthlyRent as number).toLocaleString('sv-SE')} kr/mån\n` +
              `Från: ${toolInput.startDate as string}\n` +
              (toolInput.endDate ? `Till: ${toolInput.endDate as string}` : 'Tillsvidare'),
            nextSteps: [
              `Generera hyreskontrakt som PDF`,
              `Skicka välkomstbrev till ${tenant.email}`,
              `Skapa första månadens faktura`,
            ],
          }
        }

        case 'calculate_rent_increases': {
          const kpiPercent = toolInput.kpiChangePercent as number
          const effectiveDate = toolInput.effectiveDate as string

          const activeLeases = await this.prisma.lease.findMany({
            where: { organizationId, status: 'ACTIVE' },
            include: {
              tenant: true,
              unit: { include: { property: true } },
            },
          })

          if (activeLeases.length === 0) {
            return { success: true, message: 'Inga aktiva kontrakt hittades.' }
          }

          const calculations = activeLeases.map((lease) => {
            const currentRent = Number(lease.monthlyRent)
            const increase = currentRent * (kpiPercent / 100)
            const newRent = Math.round(currentRent + increase)
            const tenantName =
              lease.tenant.type === 'INDIVIDUAL'
                ? `${lease.tenant.firstName ?? ''} ${lease.tenant.lastName ?? ''}`.trim()
                : (lease.tenant.companyName ?? '')
            return {
              leaseId: lease.id,
              tenantName,
              tenantEmail: lease.tenant.email,
              unit: `${lease.unit.property.name} — ${lease.unit.name}`,
              currentRent,
              increase: Math.round(increase),
              newRent,
            }
          })

          const totalCurrentMonthly = calculations.reduce((s, c) => s + c.currentRent, 0)
          const totalNewMonthly = calculations.reduce((s, c) => s + c.newRent, 0)
          const totalAnnualIncrease = (totalNewMonthly - totalCurrentMonthly) * 12

          const tableRows = calculations
            .map(
              (c) =>
                `${c.tenantName}: ${c.currentRent.toLocaleString('sv-SE')} kr → ` +
                `${c.newRent.toLocaleString('sv-SE')} kr (+${c.increase.toLocaleString('sv-SE')} kr/mån)`,
            )
            .join('\n')

          return {
            success: true,
            data: calculations,
            message:
              `KPI-beräkning för ${kpiPercent}% höjning från ${effectiveDate}:\n\n` +
              tableRows +
              '\n\n' +
              `Totalt: ${totalCurrentMonthly.toLocaleString('sv-SE')} kr/mån → ` +
              `${totalNewMonthly.toLocaleString('sv-SE')} kr/mån\n` +
              `Ökad årsintäkt: +${totalAnnualIncrease.toLocaleString('sv-SE')} kr/år`,
            nextSteps: [
              'Tillämpa höjning på varje kontrakt med apply_rent_increase',
              'Skicka hyreshöjningsbrev till alla hyresgäster (3 månaders varsel krävs)',
            ],
          }
        }

        case 'apply_rent_increase': {
          const leaseId = toolInput.leaseId as string
          const newRent = toolInput.newRent as number
          const currentRent = toolInput.currentRent as number
          const effectiveDate = toolInput.effectiveDate as string
          const sendNotification = toolInput.sendNotification === true

          const leaseCheck = await this.prisma.lease.findFirst({
            where: { id: leaseId, organizationId },
            include: {
              tenant: {
                select: {
                  email: true,
                  firstName: true,
                  lastName: true,
                  companyName: true,
                  type: true,
                },
              },
            },
          })
          if (!leaseCheck) {
            return {
              success: false,
              message: `Kontrakt med id "${leaseId}" hittades inte. Anropa calculate_rent_increases för att hitta rätt leaseId.`,
            }
          }

          await this.prisma.lease.update({
            where: { id: leaseId },
            data: { monthlyRent: new Prisma.Decimal(newRent) },
          })

          let emailSent = false
          if (sendNotification && leaseCheck.tenant.email) {
            const organization = await this.prisma.organization.findUnique({
              where: { id: organizationId },
              select: { name: true },
            })
            try {
              await this.mailService.sendRentIncreaseNotice({
                to: leaseCheck.tenant.email,
                tenantName: toolInput.tenantName as string,
                currentRent,
                newRent,
                effectiveDate,
                organizationName: organization?.name ?? 'Eken Fastigheter',
              })
              emailSent = true
            } catch {
              // Email failure is non-fatal — rent was already updated
            }
          }

          const notificationLine = sendNotification
            ? emailSent
              ? '\nHyreshöjningsbrev skickat via e-post'
              : '\nKunde inte skicka e-post — skicka manuellt'
            : ''

          return {
            success: true,
            message:
              `Hyran för ${toolInput.tenantName as string} uppdaterad!\n` +
              `${currentRent.toLocaleString('sv-SE')} kr → ${newRent.toLocaleString('sv-SE')} kr/mån\n` +
              `Gäller från: ${effectiveDate}` +
              notificationLine,
            nextSteps: [
              emailSent
                ? 'Bekräfta att hyresgästen mottagit brevet'
                : 'Skicka hyreshöjningsbrev till hyresgästen',
              'Uppdatera övriga kontrakt med apply_rent_increase',
            ],
          }
        }

        case 'generate_lease_contract': {
          const leaseId = toolInput.leaseId as string
          const contractType = toolInput.contractType as 'RESIDENTIAL' | 'COMMERCIAL'
          const isResidential = contractType === 'RESIDENTIAL'

          const [lease, org] = await Promise.all([
            this.prisma.lease.findFirst({
              where: { id: leaseId, unit: { property: { organizationId } } },
              include: {
                tenant: true,
                unit: { include: { property: true } },
              },
            }),
            this.prisma.organization.findUnique({ where: { id: organizationId } }),
          ])

          if (!lease) {
            return {
              success: false,
              message: `Kontrakt med id "${leaseId}" hittades inte. Anropa get_expiring_leases eller liknande för att hitta rätt leaseId.`,
            }
          }
          if (!org) {
            return { success: false, message: 'Organisationsdata kunde inte hämtas.' }
          }

          const tenantDisplayName =
            lease.tenant.type === 'INDIVIDUAL'
              ? `${lease.tenant.firstName ?? ''} ${lease.tenant.lastName ?? ''}`.trim()
              : (lease.tenant.companyName ?? '')

          const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6; color: #333; }
    h1 { font-size: 18px; text-align: center; margin-bottom: 5px; }
    h2 { font-size: 14px; margin-top: 25px; margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 3px; }
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .party { border: 1px solid #ddd; padding: 12px; border-radius: 4px; }
    .field { margin-bottom: 8px; }
    .label { font-weight: bold; font-size: 11px; color: #666; }
    .value { font-size: 12px; }
    .signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 60px; }
    .signature-line { border-top: 1px solid #333; padding-top: 8px; margin-top: 40px; }
    .clause { margin-bottom: 15px; }
  </style>
</head>
<body>
  <h1>HYRESKONTRAKT</h1>
  <p style="text-align:center;color:#666;font-size:11px">${isResidential ? 'Bostadslägenhet' : 'Lokal'} — Upprättat ${new Date().toLocaleDateString('sv-SE')}</p>

  <h2>1. PARTER</h2>
  <div class="parties">
    <div class="party">
      <strong>HYRESVÄRD</strong>
      <div class="field"><div class="label">Namn/Företag</div><div class="value">${org.name}</div></div>
      <div class="field"><div class="label">Adress</div><div class="value">${org.street}, ${org.postalCode} ${org.city}</div></div>
      ${org.bankgiro ? `<div class="field"><div class="label">Bankgiro</div><div class="value">${org.bankgiro}</div></div>` : ''}
    </div>
    <div class="party">
      <strong>HYRESGÄST</strong>
      <div class="field"><div class="label">Namn</div><div class="value">${tenantDisplayName}</div></div>
      <div class="field"><div class="label">E-post</div><div class="value">${lease.tenant.email}</div></div>
      ${lease.tenant.phone ? `<div class="field"><div class="label">Telefon</div><div class="value">${lease.tenant.phone}</div></div>` : ''}
    </div>
  </div>

  <h2>2. HYRESOBJEKT</h2>
  <div class="field"><div class="label">Fastighet</div><div class="value">${lease.unit.property.name} (${lease.unit.property.propertyDesignation})</div></div>
  <div class="field"><div class="label">Adress</div><div class="value">${lease.unit.property.street}, ${lease.unit.property.postalCode} ${lease.unit.property.city}</div></div>
  <div class="field"><div class="label">Enhet/Lägenhet</div><div class="value">${lease.unit.name} (nr ${lease.unit.unitNumber})</div></div>
  ${lease.unit.area ? `<div class="field"><div class="label">Area</div><div class="value">${lease.unit.area} m²</div></div>` : ''}

  <h2>3. HYRESTID</h2>
  <div class="field"><div class="label">Tillträdesdatum</div><div class="value">${new Date(lease.startDate).toLocaleDateString('sv-SE')}</div></div>
  <div class="field"><div class="label">Kontraktsform</div><div class="value">${lease.endDate ? `Tidsbegränsat t.o.m. ${new Date(lease.endDate).toLocaleDateString('sv-SE')}` : 'Tillsvidareavtal'}</div></div>
  <div class="field"><div class="label">Uppsägningstid</div><div class="value">${isResidential ? '3 månader (12 kap. 4 § Jordabalken)' : '9 månader om ej annat avtalats'}</div></div>

  <h2>4. HYRA OCH BETALNING</h2>
  <div class="field"><div class="label">Månadshyra</div><div class="value">${Number(lease.monthlyRent).toLocaleString('sv-SE')} kr/månad</div></div>
  <div class="field"><div class="label">Betalningsdag</div><div class="value">Senast den 1:a varje månad (förskott)</div></div>
  ${org.bankgiro ? `<div class="field"><div class="label">Betalas till</div><div class="value">Bankgiro ${org.bankgiro}</div></div>` : ''}
  ${Number(lease.depositAmount) > 0 ? `<div class="field"><div class="label">Deposition</div><div class="value">${Number(lease.depositAmount).toLocaleString('sv-SE')} kr (erläggs vid tillträde)</div></div>` : ''}

  <h2>5. INDEXKLAUSUL</h2>
  <div class="clause">Hyran är kopplad till konsumentprisindex (KPI). Hyran kan justeras en gång per år baserat på förändringen i KPI under perioden oktober–oktober. Hyresvärden meddelar eventuell hyreshöjning skriftligen senast 3 månader i förväg.</div>

  <h2>6. SKICK OCH UNDERHÅLL</h2>
  <div class="clause">Hyresgästen förbinder sig att väl vårda hyresobjektet och hålla det i gott skick. Hyresgästen ansvarar för reparationer av skador som uppkommit genom oaktsamhet eller vårdslöshet. Hyresvärden ansvarar för det löpande underhållet av fastigheten.</div>

  <h2>7. BESIKTNING OCH TILLTRÄDE</h2>
  <div class="clause">Hyresvärden äger rätt att besiktiga hyresobjektet efter 24 timmars varsel. Vid akuta situationer (t.ex. vattenläcka) kan tillträde ske utan förvarning.</div>

  ${
    isResidential
      ? `<h2>8. ANDRAHANDSUTHYRNING</h2>
  <div class="clause">Andrahandsuthyrning är ej tillåten utan hyresvärdens skriftliga godkännande. Ansökan ska göras i god tid.</div>`
      : ''
  }

  <h2>${isResidential ? '9' : '8'}. ÖVRIGA BESTÄMMELSER</h2>
  <div class="clause">För detta hyresförhållande gäller i övrigt bestämmelserna i 12 kap. Jordabalken (Hyreslagen). Vid tvist ska parterna i första hand söka lösa denna genom förhandling. I andra hand kan ärendet hänskjutas till Hyresnämnden.</div>

  <div class="signature-block">
    <div>
      <strong>HYRESVÄRD</strong>
      <div class="signature-line">Ort och datum</div>
      <div class="signature-line">Underskrift</div>
      <div class="signature-line">Namnförtydligande</div>
    </div>
    <div>
      <strong>HYRESGÄST</strong>
      <div class="signature-line">Ort och datum</div>
      <div class="signature-line">Underskrift</div>
      <div class="signature-line">Namnförtydligande: ${tenantDisplayName}</div>
    </div>
  </div>

  <p style="margin-top:40px;font-size:10px;color:#999;text-align:center">
    Detta kontrakt är upprättat i två exemplar, ett till vardera parten.
    Genererat av Eken Fastighetsförvaltning ${new Date().toLocaleDateString('sv-SE')}
  </p>
</body>
</html>`

          const pdfBuffer = await this.pdfService.generateFromHtml(html)

          const safeFilename = `kontrakt_${tenantDisplayName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`
          const uploadDir = path.join(process.cwd(), 'uploads', 'documents', organizationId)
          await fs.mkdir(uploadDir, { recursive: true })
          const filePath = path.join(uploadDir, safeFilename)
          await fs.writeFile(filePath, pdfBuffer)

          const fileUrl = `/uploads/documents/${organizationId}/${safeFilename}`
          await this.prisma.document.create({
            data: {
              organizationId,
              uploadedById: userId,
              leaseId: lease.id,
              name: `Hyreskontrakt – ${tenantDisplayName}`,
              fileUrl,
              fileSize: pdfBuffer.length,
              mimeType: 'application/pdf',
              category: 'CONTRACT',
            },
          })

          return {
            success: true,
            message: [
              `Hyreskontrakt genererat för ${tenantDisplayName}!`,
              `Kontraktet är sparat under Dokument.`,
              `Fastighet: ${lease.unit.property.name}`,
              `Enhet: ${lease.unit.name}`,
              `Hyra: ${Number(lease.monthlyRent).toLocaleString('sv-SE')} kr/mån`,
            ].join('\n'),
            nextSteps: [
              'Ladda ned kontraktet från Dokument-sidan',
              'Skicka kontraktet till hyresgästen för underskrift',
              'Spara det signerade kontraktet i systemet',
            ],
          }
        }

        case 'get_maintenance_tickets': {
          const tickets = await this.maintenanceService.findAll(organizationId, {
            ...(toolInput.status ? { status: toolInput.status as never } : {}),
            ...(toolInput.priority ? { priority: toolInput.priority as never } : {}),
            ...(toolInput.propertyId ? { propertyId: toolInput.propertyId as string } : {}),
          })

          if (tickets.length === 0) {
            return { success: true, data: [], message: 'Inga underhållsärenden hittades.' }
          }

          const lines = [`${tickets.length} underhållsärenden:\n`]
          for (const t of tickets) {
            lines.push(
              `- [${t.ticketNumber}] ${t.title} — ${t.property.name}` +
                (t.unit ? ` ${t.unit.name}` : '') +
                `, Prioritet: ${translatePriority(t.priority)}, Status: ${translateMaintenanceStatus(t.status)}`,
            )
          }

          return { success: true, data: tickets, message: lines.join('\n') }
        }

        case 'create_maintenance_ticket': {
          const propertyCheck = await this.prisma.property.findFirst({
            where: { id: toolInput.propertyId as string, organizationId },
          })
          if (!propertyCheck) {
            return {
              success: false,
              message: `Fastighet hittades inte. Anropa get_properties för att hitta rätt propertyId.`,
            }
          }

          const ticket = await this.maintenanceService.create(
            {
              title: toolInput.title as string,
              description: toolInput.description as string,
              propertyId: toolInput.propertyId as string,
              ...(toolInput.unitId ? { unitId: toolInput.unitId as string } : {}),
              ...(toolInput.category ? { category: toolInput.category as never } : {}),
              ...(toolInput.priority ? { priority: toolInput.priority as never } : {}),
              ...(toolInput.estimatedCost
                ? { estimatedCost: toolInput.estimatedCost as number }
                : {}),
            },
            organizationId,
            userId,
          )

          return {
            success: true,
            data: ticket,
            message: `Ärende ${ticket.ticketNumber} skapat!\n${ticket.title}\nFastighet: ${toolInput.propertyName as string}${toolInput.unitName ? ` / ${toolInput.unitName as string}` : ''}`,
          }
        }

        case 'update_maintenance_status': {
          const ticketCheck = await this.prisma.maintenanceTicket.findFirst({
            where: { id: toolInput.ticketId as string, organizationId },
          })
          if (!ticketCheck) {
            return {
              success: false,
              message: `Ärende hittades inte. Anropa get_maintenance_tickets för att hitta rätt ticketId.`,
            }
          }

          await this.maintenanceService.update(
            toolInput.ticketId as string,
            { status: toolInput.newStatus as never },
            organizationId,
          )

          if (toolInput.comment) {
            await this.maintenanceService.addComment(
              toolInput.ticketId as string,
              toolInput.comment as string,
              true,
              organizationId,
              userId,
            )
          }

          return {
            success: true,
            message: `Ärende ${toolInput.ticketNumber as string} uppdaterat till ${translateMaintenanceStatus(toolInput.newStatus as string)}`,
          }
        }

        case 'get_inspections': {
          const translateInspectionType = (t: string) => {
            const m: Record<string, string> = {
              MOVE_IN: 'Inflyttning',
              MOVE_OUT: 'Utflyttning',
              PERIODIC: 'Periodisk',
              DAMAGE: 'Skada',
            }
            return m[t] ?? t
          }
          const translateInspectionStatus = (s: string) => {
            const m: Record<string, string> = {
              SCHEDULED: 'Schemalagd',
              IN_PROGRESS: 'Pågår',
              COMPLETED: 'Slutförd',
              SIGNED: 'Signerad',
            }
            return m[s] ?? s
          }
          const inspections = await this.inspectionsService.findAll(organizationId, {
            ...(toolInput.type ? { type: toolInput.type as never } : {}),
            ...(toolInput.status ? { status: toolInput.status as never } : {}),
            ...(toolInput.unitId ? { unitId: toolInput.unitId as string } : {}),
          })

          if (inspections.length === 0) {
            return { success: true, data: [], message: 'Inga besiktningar hittades.' }
          }

          const lines = [`${inspections.length} besiktningar:\n`]
          for (const ins of inspections) {
            lines.push(
              `- ${translateInspectionType(ins.type)} — ${ins.property.name} ${ins.unit.name}, ` +
                `${new Date(ins.scheduledDate).toLocaleDateString('sv-SE')}, ` +
                `Status: ${translateInspectionStatus(ins.status)}`,
            )
          }
          return { success: true, data: inspections, message: lines.join('\n') }
        }

        case 'create_inspection': {
          const propCheck = await this.prisma.property.findFirst({
            where: { id: toolInput.propertyId as string, organizationId },
          })
          if (!propCheck) {
            return {
              success: false,
              message:
                'Fastighet hittades inte. Anropa get_properties för att hitta rätt propertyId.',
            }
          }

          const inspection = await this.inspectionsService.create(
            {
              type: toolInput.type as never,
              scheduledDate: toolInput.scheduledDate as string,
              propertyId: toolInput.propertyId as string,
              unitId: toolInput.unitId as string,
              ...(toolInput.tenantId ? { tenantId: toolInput.tenantId as string } : {}),
            },
            organizationId,
            userId,
          )

          const typeLabels: Record<string, string> = {
            MOVE_IN: 'Inflyttningsbesiktning',
            MOVE_OUT: 'Utflyttningsbesiktning',
            PERIODIC: 'Periodisk besiktning',
            DAMAGE: 'Skadebesiktning',
          }
          return {
            success: true,
            data: inspection,
            message: `${typeLabels[toolInput.type as string] ?? 'Besiktning'} skapad!\nFastighet: ${toolInput.propertyName as string}, Enhet: ${toolInput.unitName as string}\nDatum: ${toolInput.scheduledDate as string}${inspection?.items.length ? `\n${inspection.items.length} förinladdade checkpunkter.` : ''}`,
          }
        }

        case 'get_rent_notices': {
          const notices = await this.aviseringService.findAll(organizationId, {
            ...(toolInput.month ? { month: toolInput.month as number } : {}),
            ...(toolInput.year ? { year: toolInput.year as number } : {}),
            ...(toolInput.status ? { status: toolInput.status as never } : {}),
          })

          if (notices.length === 0) {
            return { success: true, data: [], message: 'Inga hyresavier hittades.' }
          }

          const translateNoticeStatus = (s: string) => {
            const m: Record<string, string> = {
              PENDING: 'Väntande',
              SENT: 'Skickad',
              PAID: 'Betald',
              OVERDUE: 'Försenad',
              CANCELLED: 'Avbruten',
            }
            return m[s] ?? s
          }
          const lines = [`${notices.length} hyresavier:\n`]
          for (const n of notices) {
            const tenant = n.tenant
            const name =
              tenant.type === 'INDIVIDUAL'
                ? `${tenant.firstName ?? ''} ${tenant.lastName ?? ''}`.trim()
                : (tenant.companyName ?? tenant.email)
            lines.push(
              `- [${n.noticeNumber}] ${name} — OCR: ${n.ocrNumber}, ` +
                `${Number(n.totalAmount).toLocaleString('sv-SE')} kr, ` +
                `Förfaller: ${new Date(n.dueDate).toLocaleDateString('sv-SE')}, ` +
                `Status: ${translateNoticeStatus(n.status)}`,
            )
          }
          return { success: true, data: notices, message: lines.join('\n') }
        }

        case 'generate_rent_notices': {
          const result = await this.aviseringService.generateMonthlyNotices(
            organizationId,
            toolInput.month as number,
            toolInput.year as number,
          )
          return {
            success: true,
            data: result,
            message: `${result.created} hyresavier skapades för ${toolInput.month}/${toolInput.year}. ${result.skipped > 0 ? `${result.skipped} hoppades över (finns redan).` : ''}`,
          }
        }

        case 'get_maintenance_plan': {
          const currentYear = new Date().getFullYear()
          const fromYear = (toolInput.fromYear as number) ?? currentYear
          const toYear = (toolInput.toYear as number) ?? currentYear + 5
          const summary = await this.maintenancePlanService.getYearlySummary(
            organizationId,
            fromYear,
            toYear,
          )

          const translatePlanStatus = (s: string) => {
            const m: Record<string, string> = {
              PLANNED: 'Planerad',
              APPROVED: 'Godkänd',
              IN_PROGRESS: 'Pågår',
              COMPLETED: 'Slutförd',
              CANCELLED: 'Avbruten',
            }
            return m[s] ?? s
          }
          const translatePlanCategory = (c: string) => {
            const m: Record<string, string> = {
              ROOF: 'Tak',
              FACADE: 'Fasad',
              WINDOWS: 'Fönster',
              PLUMBING: 'VVS',
              ELECTRICAL: 'El',
              HEATING: 'Värme',
              ELEVATOR: 'Hiss',
              COMMON_AREAS: 'Gemensamma utrymmen',
              PAINTING: 'Målning',
              FLOORING: 'Golv',
              OTHER: 'Övrigt',
            }
            return m[c] ?? c
          }

          const totalCount = summary.reduce((s, y) => s + y.count, 0)
          const totalCost = summary.reduce((s, y) => s + y.totalEstimated, 0)

          if (totalCount === 0) {
            return {
              success: true,
              data: summary,
              message: `Inga underhållsåtgärder planerade för ${fromYear}–${toYear}.`,
            }
          }

          const lines = [
            `Underhållsplan ${fromYear}–${toYear}: ${totalCount} åtgärder, totalt ${totalCost.toLocaleString('sv-SE')} kr\n`,
          ]
          for (const yearEntry of summary) {
            if (yearEntry.count === 0) continue
            lines.push(
              `\n${yearEntry.year} (${yearEntry.totalEstimated.toLocaleString('sv-SE')} kr):`,
            )
            for (const plan of yearEntry.plans) {
              const priorityLabel =
                plan.priority === 3 ? 'Hög' : plan.priority === 2 ? 'Normal' : 'Låg'
              lines.push(
                `  - ${translatePlanCategory(plan.category)}: ${plan.title} — ${plan.property.name} — ${Number(plan.estimatedCost).toLocaleString('sv-SE')} kr — ${translatePlanStatus(plan.status)} (Prio: ${priorityLabel})`,
              )
            }
          }
          return { success: true, data: summary, message: lines.join('\n') }
        }

        default:
          return { success: false, message: `Okänt verktyg: ${toolName}` }
      }
    } catch (error) {
      // FIX 4: all unexpected errors return gracefully instead of throwing
      const msg = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        message: `Åtgärden misslyckades: ${msg}. Försök igen eller kontakta support om problemet kvarstår.`,
      }
    }
  }
}
