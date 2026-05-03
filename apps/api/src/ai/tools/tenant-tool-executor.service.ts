import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common'
import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'
import { PrismaService } from '../../common/prisma/prisma.service'
import { MaintenanceService } from '../../maintenance/maintenance.service'
import { NotificationsService } from '../../notifications/notifications.service'
import { AiAuditService } from '../audit/ai-audit.service'
import { TENANT_ACTION_TOOLS } from './tenant-ai-tools.definition'

/**
 * Whitelista vilka fält som är säkra att returnera till hyresgäst-AI:n.
 * Personnummer, lösenordshashar och tokens får ALDRIG hamna i tool-svaret.
 * Defense-in-depth: tool-executor kör även en redact-funktion på all output.
 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'personalNumber',
  'passwordHash',
  'activationToken',
  'activationTokenExpiresAt',
  'sessionToken',
  'refreshToken',
  'magicLinkToken',
  'token',
  'apiKey',
])

function redactSensitive<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1)) as unknown as T
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAMES.has(k)) continue
      out[k] = redactSensitive(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

export interface TenantToolResult {
  success: boolean
  data?: unknown
  message: string
  nextSteps?: string[]
}

function formatAmount(n: number): string {
  return n.toLocaleString('sv-SE')
}

@Injectable()
export class TenantToolExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenanceService: MaintenanceService,
    private readonly notificationsService: NotificationsService,
    private readonly audit: AiAuditService,
  ) {}

  async executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    tenantId: string,
    organizationId: string,
    auditContext?: { conversationId?: string | null; confirmedAt?: Date | null },
  ): Promise<TenantToolResult> {
    const startedAt = Date.now()
    let result: TenantToolResult
    let thrownError: Error | null = null

    try {
      result = await this.executeToolUnsafe(toolName, toolInput, tenantId, organizationId)
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err))
      void this.audit.logToolExecution({
        organizationId,
        tenantId,
        conversationId: auditContext?.conversationId ?? null,
        toolName,
        toolInput,
        success: false,
        errorMessage: thrownError.message,
        durationMs: Date.now() - startedAt,
        requiredConfirmation: TENANT_ACTION_TOOLS.has(toolName),
        confirmedAt: auditContext?.confirmedAt ?? null,
      })
      throw thrownError
    }

    if (result.data !== undefined && result.data !== null) {
      result.data = redactSensitive(result.data)
    }

    void this.audit.logToolExecution({
      organizationId,
      tenantId,
      conversationId: auditContext?.conversationId ?? null,
      toolName,
      toolInput,
      toolResult: result.data,
      success: result.success,
      errorMessage: result.success ? null : result.message,
      durationMs: Date.now() - startedAt,
      requiredConfirmation: TENANT_ACTION_TOOLS.has(toolName),
      confirmedAt: auditContext?.confirmedAt ?? null,
    })

    return result
  }

  private async executeToolUnsafe(
    toolName: string,
    toolInput: Record<string, unknown>,
    tenantId: string,
    organizationId: string,
  ): Promise<TenantToolResult> {
    try {
      switch (toolName) {
        // ── READ ──────────────────────────────────────────────────────────

        case 'get_my_lease': {
          const lease = await this.prisma.lease.findFirst({
            where: { tenantId, status: 'ACTIVE' },
            include: {
              unit: { include: { property: true } },
            },
          })
          if (!lease) {
            return {
              success: true,
              data: null,
              message:
                'Du har inget aktivt hyresavtal just nu. Kontakta hyresvärden om detta är fel.',
            }
          }
          return {
            success: true,
            data: {
              monthlyRent: Number(lease.monthlyRent),
              depositAmount: Number(lease.depositAmount),
              startDate: lease.startDate,
              endDate: lease.endDate,
              noticePeriodMonths: lease.noticePeriodMonths,
              indexClause: lease.indexClause,
              leaseType: lease.leaseType,
              unit: {
                name: lease.unit.name,
                unitNumber: lease.unit.unitNumber,
                area: lease.unit.area,
                rooms: lease.unit.rooms,
              },
              property: {
                name: lease.unit.property.name,
                street: lease.unit.property.street,
                city: lease.unit.property.city,
                postalCode: lease.unit.property.postalCode,
              },
            },
            message: `Du hyr ${lease.unit.name} (${lease.unit.unitNumber}) för ${formatAmount(Number(lease.monthlyRent))} kr/mån.`,
          }
        }

        case 'get_my_invoices': {
          const status =
            typeof toolInput.status === 'string'
              ? (toolInput.status as 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID')
              : undefined
          const limit = typeof toolInput.limit === 'number' ? toolInput.limit : 20
          const invoices = await this.prisma.invoice.findMany({
            where: { tenantId, ...(status ? { status } : {}) },
            orderBy: { dueDate: 'desc' },
            take: limit,
            select: {
              id: true,
              invoiceNumber: true,
              type: true,
              status: true,
              total: true,
              dueDate: true,
              issueDate: true,
              paidAt: true,
            },
          })
          return {
            success: true,
            data: invoices.map((i) => ({ ...i, total: Number(i.total) })),
            message: `${invoices.length} fakturor${status ? ` med status ${status}` : ''} hittades.`,
          }
        }

        case 'get_my_payment_history': {
          const year = typeof toolInput.year === 'number' ? toolInput.year : null
          const where: {
            tenantId: string
            status: 'PAID'
            paidAt?: { gte: Date; lt: Date }
          } = { tenantId, status: 'PAID' }
          if (year) {
            where.paidAt = {
              gte: new Date(Date.UTC(year, 0, 1)),
              lt: new Date(Date.UTC(year + 1, 0, 1)),
            }
          }
          const paid = await this.prisma.invoice.findMany({
            where,
            orderBy: { paidAt: 'desc' },
            take: 50,
            select: {
              invoiceNumber: true,
              total: true,
              dueDate: true,
              paidAt: true,
              type: true,
            },
          })
          const totalPaid = paid.reduce((s, i) => s + Number(i.total), 0)
          return {
            success: true,
            data: {
              count: paid.length,
              totalPaid,
              ...(year ? { year } : {}),
              invoices: paid.map((i) => ({ ...i, total: Number(i.total) })),
            },
            message: `${paid.length} betalda fakturor${year ? ` under ${year}` : ''}, totalt ${formatAmount(totalPaid)} kr.`,
          }
        }

        case 'get_my_documents': {
          const documents = await this.prisma.document.findMany({
            where: { tenantId, NOT: { category: 'INVOICE' } },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              name: true,
              category: true,
              createdAt: true,
              fileSize: true,
              mimeType: true,
            },
          })
          return {
            success: true,
            data: documents,
            message: `${documents.length} dokument hittades. Du kan se dem under Dokument-fliken i portalen.`,
          }
        }

        case 'get_my_property_info': {
          const lease = await this.prisma.lease.findFirst({
            where: { tenantId, status: 'ACTIVE' },
            include: {
              unit: {
                include: {
                  property: {
                    include: {
                      organization: {
                        select: {
                          name: true,
                          email: true,
                          phone: true,
                          street: true,
                          city: true,
                          postalCode: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          })
          if (!lease) {
            return {
              success: true,
              data: null,
              message: 'Inget aktivt hyresavtal hittades.',
            }
          }
          return {
            success: true,
            data: {
              property: {
                name: lease.unit.property.name,
                type: lease.unit.property.type,
                street: lease.unit.property.street,
                city: lease.unit.property.city,
                postalCode: lease.unit.property.postalCode,
              },
              landlord: {
                name: lease.unit.property.organization.name,
                email: lease.unit.property.organization.email,
                phone: lease.unit.property.organization.phone,
              },
            },
            message: `Du bor i ${lease.unit.property.name}, ${lease.unit.property.street}, ${lease.unit.property.city}. Hyresvärd: ${lease.unit.property.organization.name}.`,
          }
        }

        case 'get_my_maintenance_tickets': {
          const tickets = await this.prisma.maintenanceTicket.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: 30,
            select: {
              id: true,
              ticketNumber: true,
              title: true,
              status: true,
              priority: true,
              category: true,
              createdAt: true,
              scheduledDate: true,
              completedAt: true,
            },
          })
          return {
            success: true,
            data: tickets,
            message: `${tickets.length} felanmälningar hittades.`,
          }
        }

        // ── ACTIONS ───────────────────────────────────────────────────────

        case 'create_maintenance_ticket': {
          const title = String(toolInput.title ?? '').trim()
          const description = String(toolInput.description ?? '').trim()
          if (title.length < 3 || description.length < 10) {
            return {
              success: false,
              message:
                'Titel (minst 3 tecken) och beskrivning (minst 10 tecken) krävs för en felanmälan.',
            }
          }
          const lease = await this.prisma.lease.findFirst({
            where: { tenantId, status: 'ACTIVE' },
            include: {
              unit: { include: { property: true } },
              tenant: true,
            },
          })
          if (!lease) {
            throw new BadRequestException('Inget aktivt hyresavtal — kan inte skapa felanmälan.')
          }
          const category =
            typeof toolInput.category === 'string'
              ? (toolInput.category as MaintenanceCategory)
              : MaintenanceCategory.OTHER
          const priority =
            typeof toolInput.priority === 'string'
              ? (toolInput.priority as MaintenancePriority)
              : MaintenancePriority.NORMAL

          const ticket = await this.maintenanceService.create(
            {
              title,
              description,
              propertyId: lease.unit.property.id,
              unitId: lease.unitId,
              tenantId,
              category,
              priority,
            },
            organizationId,
            '',
          )

          const tenantName = lease.tenant.firstName
            ? `${lease.tenant.firstName} ${lease.tenant.lastName ?? ''}`.trim()
            : (lease.tenant.companyName ?? lease.tenant.email)

          void this.notificationsService
            .createForAllOrgUsers(
              organizationId,
              'MAINTENANCE_NEW',
              '🔔 Ny felanmälan från hyresgäst',
              `${tenantName} har anmält: ${title}`,
              '/maintenance',
            )
            .catch(() => undefined)

          return {
            success: true,
            data: { id: ticket.id, ticketNumber: ticket.ticketNumber },
            message: `Felanmälan skapad (#${ticket.ticketNumber}). Hyresvärden har fått en notifiering och hör av sig så snart som möjligt.`,
            nextSteps: [
              'Du kan följa ärendet under Felanmälan-fliken',
              'Lägg till bilder eller kommentarer där om något ändras',
            ],
          }
        }

        case 'request_termination': {
          const requestedEndDate = String(toolInput.requestedEndDate ?? '')
          const reason =
            typeof toolInput.reason === 'string' && toolInput.reason.trim().length > 0
              ? toolInput.reason.trim()
              : null
          if (!requestedEndDate) {
            return {
              success: false,
              message: 'Önskat avflyttningsdatum (requestedEndDate) krävs.',
            }
          }
          const endDate = new Date(requestedEndDate)
          if (isNaN(endDate.getTime())) {
            return {
              success: false,
              message: `Ogiltigt datum: ${requestedEndDate}. Ange ett datum i format YYYY-MM-DD.`,
            }
          }
          if (endDate.getTime() < Date.now()) {
            return {
              success: false,
              message: 'Önskat avflyttningsdatum måste ligga i framtiden.',
            }
          }
          const lease = await this.prisma.lease.findFirst({
            where: { tenantId, status: 'ACTIVE' },
            include: { tenant: true },
          })
          if (!lease) {
            throw new BadRequestException('Du har inget aktivt hyresavtal som kan sägas upp.')
          }
          // Förhindra dubblerade pågående begäran
          const existing = await this.prisma.terminationRequest.findFirst({
            where: { leaseId: lease.id, status: 'PENDING' },
          })
          if (existing) {
            return {
              success: false,
              message:
                'Du har redan en pågående uppsägningsbegäran. Kontakta hyresvärden direkt för status.',
            }
          }

          const request = await this.prisma.terminationRequest.create({
            data: {
              organizationId,
              tenantId,
              leaseId: lease.id,
              requestedEndDate: endDate,
              ...(reason ? { reason } : {}),
            },
          })

          const tenantName = lease.tenant.firstName
            ? `${lease.tenant.firstName} ${lease.tenant.lastName ?? ''}`.trim()
            : (lease.tenant.companyName ?? lease.tenant.email)

          void this.notificationsService
            .createForAllOrgUsers(
              organizationId,
              'SYSTEM',
              '📤 Uppsägningsbegäran från hyresgäst',
              `${tenantName} har begärt uppsägning per ${endDate.toISOString().slice(0, 10)}.`,
              '/leases',
            )
            .catch(() => undefined)

          return {
            success: true,
            data: { id: request.id, requestedEndDate: endDate.toISOString().slice(0, 10) },
            message: `Din uppsägningsbegäran har skickats till hyresvärden. Begäran är PRELIMINÄR — uppsägningen är giltig först när hyresvärden bekräftat den enligt Hyreslagen 12 kap. JB.`,
            nextSteps: [
              'Hyresvärden hör av sig för att bekräfta',
              'Vid frågor — kontakta hyresvärden direkt',
            ],
          }
        }

        default:
          return { success: false, message: `Okänt verktyg: ${toolName}` }
      }
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException) throw err
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        message: `Något gick fel: ${msg}. Försök igen senare eller kontakta din hyresvärd.`,
      }
    }
  }
}
