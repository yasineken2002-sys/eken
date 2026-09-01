import { randomUUID } from 'node:crypto'
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common'
import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'
import { PrismaService } from '../../common/prisma/prisma.service'
import { runAsAi } from '../../common/ai-origin/ai-origin.context'
import { drainEffects, runWithEffectCollector } from '../../common/ai-effects/ai-effects.context'
import { computeInvoiceDebt } from '../../invoices/invoice-debt'
import { MaintenanceService } from '../../maintenance/maintenance.service'
import { NotificationsService } from '../../notifications/notifications.service'
import { AiAuditService } from '../audit/ai-audit.service'
import { TerminationsService } from '../../terminations/terminations.service'
import { TENANT_ACTION_TOOLS } from './tenant-ai-tools.definition'
import { effectTraceIntegrity } from './effect-idempotency'
import { assertActionToolAuthorized } from './action-authorization'
import type { ActionProof } from './action-authorization'
import { SAFE_TENANT_SELECT } from '../../tenants/tenants.service'
import { redactSensitive } from '../../common/redaction/redact-sensitive'

/**
 * Whitelista vilka fält som är säkra att returnera till hyresgäst-AI:n.
 * Personnummer, lösenordshashar och tokens får ALDRIG hamna i tool-svaret.
 * Defense-in-depth: tool-executor kör även en redact-funktion på all output.
 */

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
    private readonly terminations: TerminationsService,
  ) {}

  async executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    tenantId: string,
    organizationId: string,
    auditContext?: {
      conversationId?: string | null
      confirmedAt?: Date | null
      /** Beviset för ett bindande verktyg. Se action-authorization.ts. */
      actionProof?: ActionProof
    },
  ): Promise<TenantToolResult> {
    // SAMMA INVARIANT SOM ÄGARVÄGEN, på samma plats: först av allt.
    //
    // Hyresgästens exekverare är en EGEN klass, och det är precis därför
    // grinden måste bo i en delad modul i stället för i en loop. Två exekverare
    // som var för sig kommer ihåg att kolla `actionBlock` är två chanser att
    // glömma; ett anrop till samma assertion är en.
    assertActionToolAuthorized(toolName, auditContext?.actionProof)

    // ── UTFALLSKOPPLINGEN, NU OCKSÅ HÄR (steg 3a) ────────────────────────────
    //
    // Hyresgästvägen hade INGET effektspår alls: ingen kollektor, inget
    // AI-ursprung, ingen `effects` till auditraden. Två skrivande verktyg
    // (`create_maintenance_ticket`, `request_termination`) var därmed helt
    // ospårade — en sämre sorts lucka än ägarvägens bäst-möjliga spår, och det
    // är den här vägen en hyresgästagent kommer att köra på.
    //
    // Mekaniken är densamma som ägarvägens, inte en ny: `runWithEffectCollector`
    // + `runAsAi` + `drainEffects`. Prisma-extensionen ser varje skrivning som
    // sker inne i `runAsAi` och noterar den i kollektorn.
    //
    // KOLLEKTORN OMSLUTER HELA KROPPEN, inte bara verktygskörningen. Det är
    // R2-defekten från ägarvägen, ordagrant: låg den bara runt körningen
    // anropades `drainEffects()` utanför AsyncLocalStorage-scopet, där store är
    // undefined och tömningen ALLTID ger en tom lista. Koden kompilerar, kör och
    // bokför noll effekter.
    //
    // Spåret förblir `BÄST_MÖJLIGA` — auditraden skrivs fortfarande efteråt och
    // med `void`. Ett bäst-möjligt spår slår inget spår; att göra det
    // transaktionellt är klass A och ett eget steg.
    return runWithEffectCollector(() =>
      this.executeToolWithAudit(toolName, toolInput, tenantId, organizationId, auditContext),
    )
  }

  private async executeToolWithAudit(
    toolName: string,
    toolInput: Record<string, unknown>,
    tenantId: string,
    organizationId: string,
    auditContext?: {
      conversationId?: string | null
      confirmedAt?: Date | null
      actionProof?: ActionProof
    },
  ): Promise<TenantToolResult> {
    const startedAt = Date.now()
    let result: TenantToolResult
    let thrownError: Error | null = null

    // Loggradens id allokeras FÖRE körningen, av samma skäl som i ägarvägen:
    // något som skapas inne i verktyget måste kunna peka på loggraden, men
    // raden skrivs först efteråt.
    const executionId = randomUUID()

    // Samma tre tillstånd som ägarvägen (steg 3b). DEKLARATIONEN styr, inte
    // exekveraren.
    //
    // MÄNGDERNA ÖVERLAPPAR DELVIS, mätt 2026-09-01: TENANT_ACTION_TOOLS är två
    // verktyg, och `create_maintenance_ticket` står i BÅDA. Det ärver därmed
    // ägarvägens deklaration — vilket är rätt, för det är samma effektform
    // (en rad i MaintenanceTicket) oavsett vem som ber om den.
    //
    // `request_termination` finns bara här och står alltså inte i
    // EFFECT_DECLARATIONS. `effectTraceIntegrity` faller stängt till 'OKÄND' för
    // namn den inte känner, och OKÄND öppnar ingenting: den behåller
    // BÄST_MÖJLIGA tills någon klassificerar den. Att låta den ärva ett
    // "före"-spår den inte deklarerat vore ett påstående ingen mätt.
    const spårform = effectTraceIntegrity(toolName)
    if (spårform === 'FÖRE_EFFEKTEN') {
      await this.audit.beginToolExecution({
        id: executionId,
        organizationId,
        tenantId,
        conversationId: auditContext?.conversationId ?? null,
        toolName,
        toolInput,
        requiredConfirmation: TENANT_ACTION_TOOLS.has(toolName),
        confirmedAt: auditContext?.confirmedAt ?? null,
      })
    }

    try {
      result = await runAsAi(executionId, () =>
        this.executeToolUnsafe(toolName, toolInput, tenantId, organizationId),
      )
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err))
      if (spårform === 'FÖRE_EFFEKTEN') {
        await this.audit.completeToolExecution({
          id: executionId,
          organizationId,
          toolName,
          success: false,
          errorMessage: thrownError.message,
          durationMs: Date.now() - startedAt,
          effects: drainEffects(),
        })
        throw thrownError
      }
      void this.audit.logToolExecution({
        id: executionId,
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
        // ÄVEN VID FEL. Ett verktyg som hann skapa en rad innan det kastade har
        // orsakat en rad — samma regel som ägarvägens R3.
        effects: drainEffects(),
      })
      throw thrownError
    }

    if (result.data !== undefined && result.data !== null) {
      result.data = redactSensitive(result.data)
    }

    if (spårform === 'FÖRE_EFFEKTEN') {
      void this.audit.completeToolExecution({
        id: executionId,
        organizationId,
        toolName,
        toolResult: result.data,
        success: result.success,
        errorMessage: result.success ? null : result.message,
        durationMs: Date.now() - startedAt,
        effects: drainEffects(),
      })
      return result
    }

    void this.audit.logToolExecution({
      id: executionId,
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
      effects: drainEffects(),
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
              // ── #342: TREDJE HYRESGÄST-YTAN ────────────────────────────────
              //
              // Hyresgästens AI-assistent svarar på "vad är min faktura på?" och
              // läste `total` — ursprungsbeloppet. Efter #329 (breven) och
              // #342 (portalen) hade assistenten varit den enda kvarvarande
              // ytan som svarade med ett annat tal än de andra två, och den nås
              // från samma dashboard som den här PR:en ändrar.
              //
              // Bara `amount`: allokeringens id, datum, källa och bank-koppling
              // stannar internt (samma disciplin som portalens mappers).
              payments: { select: { amount: true } },
              creditNotes: { select: { total: true } },
            },
          })
          return {
            success: true,
            data: invoices.map(({ payments, creditNotes, ...i }) => {
              const debt = computeInvoiceDebt({
                total: i.total,
                allocations: payments.map((p) => p.amount),
                // #517 — hyresgästen ska aldrig få se en krediterad post som
                // obetald skuld i portalens AI-svar.
                credits: creditNotes.map((c) => c.total),
              })
              return {
                ...i,
                total: Number(i.total),
                // Modellen ska svara på vad hyresgästen ÄR SKYLDIG, inte vad
                // fakturan ursprungligen löd på.
                paid: debt.paid.toNumber(),
                outstanding: debt.outstanding.toNumber(),
              }
            }),
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
              // Portalens felanmälan behöver hyresgästens namn, inte personnumret.
              tenant: { select: SAFE_TENANT_SELECT },
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
              { relatedEntityType: 'MAINTENANCE_TICKET', relatedEntityId: ticket.id },
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
          // Centraliserad skapande-logik (dubblettskydd + personalnotis) i
          // TerminationsService så att AI-vägen och en framtida portal-knapp
          // delar exakt samma flöde. Kastar BadRequestException om hyresgästen
          // saknar aktivt avtal; returnerar null vid pågående dubblett.
          const created = await this.terminations.createFromTenant(
            organizationId,
            tenantId,
            endDate,
            reason ?? undefined,
          )
          if (!created) {
            return {
              success: false,
              message:
                'Du har redan en pågående uppsägningsbegäran. Kontakta hyresvärden direkt för status.',
            }
          }

          return {
            success: true,
            data: { id: created.id, requestedEndDate: endDate.toISOString().slice(0, 10) },
            message: `Din uppsägningsbegäran har skickats till hyresvärden. Begäran är PRELIMINÄR — uppsägningen är giltig först när hyresvärden bekräftat den enligt hyreslagens regler om uppsägning.`,
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
