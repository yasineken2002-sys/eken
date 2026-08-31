/**
 * HISTORIKREGISTRET — den DEKLARERADE mängden domänkällor.
 *
 * ── VARFÖR ETT REGISTER OCH INTE EN SÖKNING ─────────────────────────────────
 *
 * Historiken sammanställs vid läsning ur domäntabellerna; det finns ingen egen
 * händelsetabell och ingen dubbelskrivning (planens Del 8). Priset för det
 * valet är EN risk: en domän som producerar historik men som ingen kopplade in.
 * Den luckan syns inte i utdata — historiken ser komplett ut, bara kortare.
 *
 * Registret är den primära mekanismen mot det. Vakten
 * `check-history-registry.mjs` kräver att VARJE relation på `model Tenant` står
 * antingen här eller i `history-sources.ack.json` med ett skäl. En ny relation
 * i schemat kan alltså inte glida förbi: den fäller bygget tills någon tar
 * ställning till om den bär historik.
 *
 * Regeln är på FORMEN — "varje relation på Tenant" — inte en uppräkning av
 * kända källor. Det är skillnaden mot en lista någon underhåller, och skälet
 * står i planens Del 10: en namnlista kan bara fälla det någon redan tänkt på.
 *
 * ── `relation` ÄR VAKTENS NYCKEL ────────────────────────────────────────────
 *
 * Varje post bär fältnamnet PÅ `model Tenant` som den täcker. Det är det enda
 * fältet vakten läser, och det måste stavas exakt som i `schema.prisma` —
 * annars matchar inte mängderna och vakten fäller, vilket är rätt utfall.
 */
import type { PrismaClient, UserRole } from '@prisma/client'
import {
  ACTOR_UNKNOWN,
  actorFromEventActorType,
  humanOrUnknown,
  toAmount,
  type HistoryEvent,
} from './history-event'

/** Vad varje laddare får veta. Scopat på organisationen som allt annat. */
export interface HistoryQuery {
  prisma: PrismaClient
  organizationId: string
  tenantId: string
}

export interface HistorySourceDefinition {
  /** Stabil nyckel för källan. Används i felmeddelanden och i tester. */
  key: string
  /** Fältnamnet på `model Tenant` som posten täcker. Vaktens nyckel. */
  relation: string
  /** Prisma-modellen som raderna kommer ur (kan skilja sig från relationens typ). */
  table: string
  /**
   * Roller som får se källan. `undefined` = alla org-inloggade roller.
   *
   * ── VARFÖR DEN HÄR RADEN FINNS ─────────────────────────────────────────────
   *
   * ETT AGGREGAT FÅR INTE VIDGA ÅTKOMST. Historiken samlar femton källor, och
   * två av dem har en SNÄVARE grind än de övriga någon annanstans i API:t:
   *
   *   /ai-usage · /ai/usage        ACCOUNTANT, ADMIN, OWNER
   *   POST /tenants/:id/anonymize  OWNER
   *
   * Utan den här begränsningen hade en VIEWER kunnat läsa AI-körningar och
   * GDPR-raderingar via historiken som hen inte kommer åt någon annanstans —
   * en behörighetsgräns som flyttats av misstag, upptäckt av att
   * `authz-surface`-golden fällde. Det är precis den defekten som beskrivs i
   * golden-filens eget huvud: två läckor 2026-08-14 på endpoints vars rollgräns
   * var HELT KORREKT, men vars SVARSYTA bar mer än anropsytan prövade.
   *
   * Begränsningen står DEKLARERAD på källan i stället för som ett villkor inne
   * i sammanställningen, av samma skäl som registret är deklarerat: en `if` i
   * en läsväg skyddar bara den läsvägen, och nästa läsväg ärver ingenting.
   */
  restrictedToRoles?: readonly UserRole[]
  load: (q: HistoryQuery) => Promise<HistoryEvent[]>
}

// ── Källorna ────────────────────────────────────────────────────────────────

const leases: HistorySourceDefinition = {
  key: 'lease',
  relation: 'leases',
  table: 'Lease',
  // Ett avtal producerar FLERA händelser: det skapades, det aktiverades, det
  // sades upp. Att bara visa `createdAt` hade dolt hela livscykeln.
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.lease.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        activatedAt: true,
        terminatedAt: true,
        terminationReason: true,
        monthlyRent: true,
        contractNumber: true,
        unitId: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'LEASE' as const, id: r.id, label: r.contractNumber }
      out.push({
        at: r.createdAt,
        type: 'LEASE_CREATED',
        actor: ACTOR_UNKNOWN,
        subject,
        description: 'Hyresavtal upprättat',
        amount: toAmount(r.monthlyRent),
        severity: 'INFO',
        source: { table: 'Lease', id: r.id },
      })
      if (r.activatedAt) {
        out.push({
          at: r.activatedAt,
          type: 'LEASE_ACTIVATED',
          actor: ACTOR_UNKNOWN,
          subject,
          description: 'Hyresavtal aktiverat — tillträde',
          amount: null,
          severity: 'NOTICE',
          source: { table: 'Lease', id: r.id },
        })
      }
      if (r.terminatedAt) {
        out.push({
          at: r.terminatedAt,
          type: 'LEASE_TERMINATED',
          actor: ACTOR_UNKNOWN,
          subject,
          description: r.terminationReason
            ? `Hyresavtal upphörde: ${r.terminationReason}`
            : 'Hyresavtal upphörde',
          amount: null,
          severity: 'NOTICE',
          source: { table: 'Lease', id: r.id },
        })
      }
    }
    return out
  },
}

const invoices: HistorySourceDefinition = {
  key: 'invoice-event',
  relation: 'invoices',
  table: 'InvoiceEvent',
  // Fakturans historik läses ur den APPEND-ONLY händelseloggen, inte ur
  // fakturans nuvarande status. Statusen säger var den är NU; loggen säger vad
  // som hände — och den bär dessutom `actorType`, alltså en riktig aktör.
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.invoiceEvent.findMany({
      where: { invoice: { organizationId, tenantId } },
      select: {
        id: true,
        createdAt: true,
        type: true,
        actorType: true,
        actorId: true,
        actorLabel: true,
        invoiceId: true,
        invoice: { select: { invoiceNumber: true, total: true } },
      },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: `INVOICE_${r.type}`,
      actor: actorFromEventActorType(r.actorType, r.actorId, r.actorLabel),
      subject: { kind: 'INVOICE' as const, id: r.invoiceId, label: r.invoice.invoiceNumber },
      description: `Faktura ${r.invoice.invoiceNumber}: ${r.type}`,
      amount: toAmount(r.invoice.total),
      severity: r.type === 'OVERDUE' ? ('WARNING' as const) : ('INFO' as const),
      source: { table: 'InvoiceEvent', id: r.id },
    }))
  },
}

const rentNotices: HistorySourceDefinition = {
  key: 'rent-notice-event',
  relation: 'rentNotices',
  table: 'RentNoticeEvent',
  // Samma skäl som fakturan: händelseloggen, inte nuvarande status.
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.rentNoticeEvent.findMany({
      where: { rentNotice: { organizationId, tenantId } },
      select: {
        id: true,
        createdAt: true,
        type: true,
        actorType: true,
        actorId: true,
        actorLabel: true,
        rentNoticeId: true,
        rentNotice: { select: { noticeNumber: true, totalAmount: true } },
      },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: `RENT_NOTICE_${r.type}`,
      actor: actorFromEventActorType(r.actorType, r.actorId, r.actorLabel),
      subject: {
        kind: 'RENT_NOTICE' as const,
        id: r.rentNoticeId,
        label: r.rentNotice.noticeNumber,
      },
      description: `Hyresavi ${r.rentNotice.noticeNumber}: ${r.type}`,
      amount: toAmount(r.rentNotice.totalAmount),
      severity: severityForRentNoticeEvent(r.type),
      source: { table: 'RentNoticeEvent', id: r.id },
    }))
  },
}

/** Kravtrappans steg är olika allvarliga — det är hela poängen med trappan. */
function severityForRentNoticeEvent(type: string): HistoryEvent['severity'] {
  if (type.includes('WRITTEN_OFF') || type.includes('COLLECTION')) return 'CRITICAL'
  if (type.includes('REMIND') || type.includes('OVERDUE') || type.includes('INTEREST')) {
    return 'WARNING'
  }
  return 'INFO'
}

const maintenanceTickets: HistorySourceDefinition = {
  key: 'maintenance-ticket',
  relation: 'maintenanceTickets',
  table: 'MaintenanceTicket',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.maintenanceTicket.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        completedAt: true,
        ticketNumber: true,
        title: true,
        priority: true,
        actualCost: true,
        reportedById: true,
        unitId: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'UNIT' as const, id: r.unitId, label: r.ticketNumber }
      out.push({
        at: r.createdAt,
        type: 'MAINTENANCE_REPORTED',
        actor: humanOrUnknown(r.reportedById),
        subject,
        description: `Felanmälan ${r.ticketNumber}: ${r.title}`,
        amount: null,
        severity: r.priority === 'URGENT' ? 'CRITICAL' : r.priority === 'HIGH' ? 'WARNING' : 'INFO',
        source: { table: 'MaintenanceTicket', id: r.id },
      })
      if (r.completedAt) {
        out.push({
          at: r.completedAt,
          type: 'MAINTENANCE_COMPLETED',
          actor: ACTOR_UNKNOWN,
          subject,
          description: `Felanmälan ${r.ticketNumber} åtgärdad`,
          amount: toAmount(r.actualCost),
          severity: 'INFO',
          source: { table: 'MaintenanceTicket', id: r.id },
        })
      }
    }
    return out
  },
}

const inspections: HistorySourceDefinition = {
  key: 'inspection',
  relation: 'inspections',
  table: 'Inspection',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.inspection.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        completedAt: true,
        type: true,
        unitId: true,
        inspectedById: true,
        overallCondition: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'UNIT' as const, id: r.unitId, label: null }
      out.push({
        at: r.createdAt,
        type: 'INSPECTION_SCHEDULED',
        actor: humanOrUnknown(r.inspectedById),
        subject,
        description: `Besiktning planerad (${r.type})`,
        amount: null,
        severity: 'INFO',
        source: { table: 'Inspection', id: r.id },
      })
      if (r.completedAt) {
        out.push({
          at: r.completedAt,
          type: 'INSPECTION_COMPLETED',
          actor: humanOrUnknown(r.inspectedById),
          subject,
          description: r.overallCondition
            ? `Besiktning utförd — skick: ${r.overallCondition}`
            : 'Besiktning utförd',
          amount: null,
          severity: 'INFO',
          source: { table: 'Inspection', id: r.id },
        })
      }
    }
    return out
  },
}

const keyHandovers: HistorySourceDefinition = {
  key: 'key-handover',
  relation: 'keyHandovers',
  table: 'KeyHandover',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.keyHandover.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        issuedAt: true,
        returnedAt: true,
        type: true,
        label: true,
        issuedById: true,
        receivedById: true,
        unitId: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'UNIT' as const, id: r.unitId, label: r.label }
      out.push({
        at: r.issuedAt,
        type: 'KEY_ISSUED',
        actor: humanOrUnknown(r.issuedById),
        subject,
        description: `Nyckel utlämnad (${r.type})`,
        amount: null,
        severity: 'INFO',
        source: { table: 'KeyHandover', id: r.id },
      })
      if (r.returnedAt) {
        out.push({
          at: r.returnedAt,
          type: 'KEY_RETURNED',
          actor: humanOrUnknown(r.receivedById),
          subject,
          description: `Nyckel återlämnad (${r.type})`,
          amount: null,
          severity: 'INFO',
          source: { table: 'KeyHandover', id: r.id },
        })
      }
    }
    return out
  },
}

const deposits: HistorySourceDefinition = {
  key: 'deposit',
  relation: 'deposits',
  table: 'Deposit',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.deposit.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        paidAt: true,
        refundedAt: true,
        amount: true,
        refundAmount: true,
        leaseId: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'LEASE' as const, id: r.leaseId, label: null }
      out.push({
        at: r.createdAt,
        type: 'DEPOSIT_CREATED',
        actor: ACTOR_UNKNOWN,
        subject,
        description: 'Deposition registrerad',
        amount: toAmount(r.amount),
        severity: 'INFO',
        source: { table: 'Deposit', id: r.id },
      })
      if (r.paidAt) {
        out.push({
          at: r.paidAt,
          type: 'DEPOSIT_PAID',
          actor: ACTOR_UNKNOWN,
          subject,
          description: 'Deposition betald',
          amount: toAmount(r.amount),
          severity: 'INFO',
          source: { table: 'Deposit', id: r.id },
        })
      }
      if (r.refundedAt) {
        out.push({
          at: r.refundedAt,
          type: 'DEPOSIT_REFUNDED',
          actor: ACTOR_UNKNOWN,
          subject,
          description: 'Deposition återbetald',
          amount: toAmount(r.refundAmount),
          severity: 'NOTICE',
          source: { table: 'Deposit', id: r.id },
        })
      }
    }
    return out
  },
}

const terminationRequests: HistorySourceDefinition = {
  key: 'termination-request',
  relation: 'terminationRequests',
  table: 'TerminationRequest',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.terminationRequest.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        reviewedAt: true,
        reviewedById: true,
        status: true,
        requestedEndDate: true,
        leaseId: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'LEASE' as const, id: r.leaseId, label: null }
      out.push({
        at: r.createdAt,
        type: 'TERMINATION_REQUESTED',
        actor: ACTOR_UNKNOWN,
        subject,
        description: 'Uppsägning begärd av hyresgäst',
        amount: null,
        severity: 'NOTICE',
        source: { table: 'TerminationRequest', id: r.id },
      })
      if (r.reviewedAt) {
        out.push({
          at: r.reviewedAt,
          type: 'TERMINATION_REVIEWED',
          actor: humanOrUnknown(r.reviewedById),
          subject,
          description: `Uppsägning behandlad: ${r.status}`,
          amount: null,
          severity: 'NOTICE',
          source: { table: 'TerminationRequest', id: r.id },
        })
      }
    }
    return out
  },
}

const documents: HistorySourceDefinition = {
  key: 'document',
  relation: 'documents',
  table: 'Document',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.document.findMany({
      where: { organizationId, tenantId },
      select: { id: true, createdAt: true, name: true, category: true, uploadedById: true },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: 'DOCUMENT_ADDED',
      actor: humanOrUnknown(r.uploadedById),
      subject: { kind: 'DOCUMENT' as const, id: r.id, label: r.name },
      description: `Dokument tillagt: ${r.name} (${r.category})`,
      amount: null,
      severity: 'INFO' as const,
      source: { table: 'Document', id: r.id },
    }))
  },
}

const signedDocuments: HistorySourceDefinition = {
  key: 'document-signed',
  relation: 'signedDocuments',
  table: 'Document',
  // EGEN post, inte en gren i `document`: `signedByTenantId` är en ANNAN
  // relation på Tenant än `tenantId`. En hyresgäst kan signera ett dokument som
  // hör till någon annan, och den signeringen är hens historik.
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.document.findMany({
      where: { organizationId, signedByTenantId: tenantId, signedAt: { not: null } },
      select: { id: true, signedAt: true, name: true },
    })
    return rows.map((r) => ({
      // `signedAt` är filtrerad som icke-null ovan; non-null-assertion är därför
      // en avläsning av filtret, inte ett antagande.
      at: r.signedAt as Date,
      type: 'DOCUMENT_SIGNED',
      actor: { kind: 'HUMAN' as const, id: tenantId, label: null },
      subject: { kind: 'DOCUMENT' as const, id: r.id, label: r.name },
      description: `Dokument signerat: ${r.name}`,
      amount: null,
      severity: 'NOTICE' as const,
      source: { table: 'Document', id: r.id },
    }))
  },
}

const sentMessages: HistorySourceDefinition = {
  key: 'sent-message',
  relation: 'sentMessages',
  table: 'SentMessage',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.sentMessage.findMany({
      where: { organizationId, tenantId },
      select: { id: true, createdAt: true, subject: true, status: true, sentById: true },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: 'MESSAGE_SENT',
      actor: humanOrUnknown(r.sentById),
      subject: { kind: 'TENANT' as const, id: tenantId, label: null },
      description: `Meddelande skickat: ${r.subject}`,
      amount: null,
      severity: r.status === 'FAILED' ? ('WARNING' as const) : ('INFO' as const),
      source: { table: 'SentMessage', id: r.id },
    }))
  },
}

const consumptionCharges: HistorySourceDefinition = {
  key: 'consumption-charge',
  relation: 'consumptionCharges',
  table: 'ConsumptionCharge',
  // IMD-motorn skapar dessa maskinellt ur mätaravläsningar — därför SYSTEM,
  // och det är ett påstående som stämmer: ingen människa knappar in dem.
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.consumptionCharge.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        meterType: true,
        totalAmount: true,
        periodStart: true,
        periodEnd: true,
        leaseId: true,
      },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: 'CONSUMPTION_CHARGED',
      actor: { kind: 'SYSTEM' as const, id: null, label: null },
      subject: { kind: 'LEASE' as const, id: r.leaseId, label: null },
      description: `Förbrukningsdebitering (${r.meterType})`,
      amount: toAmount(r.totalAmount),
      severity: 'INFO' as const,
      source: { table: 'ConsumptionCharge', id: r.id },
    }))
  },
}

const miscCharges: HistorySourceDefinition = {
  key: 'misc-charge',
  relation: 'miscCharges',
  table: 'MiscCharge',
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.miscCharge.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        incidentDate: true,
        description: true,
        totalAmount: true,
        sourceType: true,
        leaseId: true,
      },
    })
    return rows.map((r) => ({
      // `incidentDate` och inte `createdAt`: historiken ska visa när det HÄNDE,
      // inte när någon hann registrera det.
      at: r.incidentDate,
      type: 'MISC_CHARGED',
      actor: ACTOR_UNKNOWN,
      subject: { kind: 'LEASE' as const, id: r.leaseId, label: null },
      description: `Övrig debitering (${r.sourceType}): ${r.description}`,
      amount: toAmount(r.totalAmount),
      severity: 'INFO' as const,
      source: { table: 'MiscCharge', id: r.id },
    }))
  },
}

const anonymizationLogs: HistorySourceDefinition = {
  key: 'anonymization',
  relation: 'anonymizationLogs',
  table: 'TenantAnonymizationLog',
  // Speglar `POST /tenants/:id/anonymize`, som är OWNER-only.
  restrictedToRoles: ['OWNER'],
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.tenantAnonymizationLog.findMany({
      where: { organizationId, tenantId },
      select: { id: true, performedAt: true, performedById: true, reason: true },
    })
    return rows.map((r) => ({
      at: r.performedAt,
      type: 'TENANT_ANONYMIZED',
      actor: humanOrUnknown(r.performedById),
      subject: { kind: 'TENANT' as const, id: tenantId, label: null },
      description: r.reason
        ? `Personuppgifter anonymiserade: ${r.reason}`
        : 'Personuppgifter anonymiserade',
      amount: null,
      severity: 'CRITICAL' as const,
      source: { table: 'TenantAnonymizationLog', id: r.id },
    }))
  },
}

const aiToolExecutions: HistorySourceDefinition = {
  key: 'ai-tool-execution',
  relation: 'aiToolExecutions',
  table: 'AiToolExecution',
  // Speglar `/ai-usage` och `/ai/usage`, som är ACCOUNTANT, ADMIN, OWNER.
  restrictedToRoles: ['ACCOUNTANT', 'ADMIN', 'OWNER'],
  // AGENTSPÅRET. Planens Del 8: agentens arbete ska synas i SAMMA flöde som
  // allt annat, inte i en separat vy. Fältet och källan finns därför från dag
  // ett, även innan någon agent existerar — byggs det in i efterhand blir det
  // fel, och en historik som saknar maskinens handlingar är inte ett spår.
  async load({ prisma, organizationId, tenantId }) {
    const rows = await prisma.aiToolExecution.findMany({
      where: { organizationId, tenantId },
      select: {
        id: true,
        createdAt: true,
        toolName: true,
        success: true,
        userId: true,
        confirmedAt: true,
      },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: `AI_TOOL_${r.success ? 'EXECUTED' : 'FAILED'}`,
      // `userId` bär människan som bad om det — AI:n agerar aldrig av sig själv.
      actor: { kind: 'AGENT' as const, id: r.userId, label: r.toolName },
      subject: { kind: 'TENANT' as const, id: tenantId, label: null },
      description: r.success
        ? `AI utförde ${r.toolName}${r.confirmedAt ? ' (bekräftad)' : ''}`
        : `AI misslyckades med ${r.toolName}`,
      amount: null,
      severity: r.success ? ('INFO' as const) : ('WARNING' as const),
      source: { table: 'AiToolExecution', id: r.id },
    }))
  },
}

/**
 * REGISTRET. Vakten läser `relation` ur varje post och jämför mot
 * `model Tenant` i `schema.prisma`.
 */
export const HISTORY_SOURCES: readonly HistorySourceDefinition[] = [
  leases,
  invoices,
  rentNotices,
  maintenanceTickets,
  inspections,
  keyHandovers,
  deposits,
  terminationRequests,
  documents,
  signedDocuments,
  sentMessages,
  consumptionCharges,
  miscCharges,
  anonymizationLogs,
  aiToolExecutions,
]
