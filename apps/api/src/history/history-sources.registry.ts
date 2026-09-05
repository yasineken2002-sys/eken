/**
 * HISTORIKREGISTRET — den DEKLARERADE mängden domänkällor, i TRE dimensioner.
 *
 * ── VARFÖR ETT REGISTER OCH INTE EN SÖKNING ─────────────────────────────────
 *
 * Historiken sammanställs vid läsning ur domäntabellerna; det finns ingen egen
 * händelsetabell och ingen dubbelskrivning (planens Del 8). Priset för det
 * valet är EN risk: en domän som producerar historik men som ingen kopplade in.
 * Den luckan syns inte i utdata — historiken ser komplett ut, bara kortare.
 *
 * Registret är den primära mekanismen mot det. Vakten
 * `check-history-registry.mjs` kräver att VARJE relation på `model Tenant`,
 * `model Unit` och `model Property` står antingen här eller i
 * `history-sources.ack.json` med ett skäl. En ny relation i schemat kan alltså
 * inte glida förbi: den fäller bygget tills någon tar ställning.
 *
 * ── EN KÄLLA, TRE DIMENSIONER — INTE TRE REGISTER ───────────────────────────
 *
 * Samma domänkälla (t.ex. felanmälan) är historik för hyresgästen, lägenheten
 * OCH fastigheten. Hade var dimension haft sitt eget register hade en rättelse
 * i en mappning behövt göras tre gånger, och glömts minst en. Varje post bär i
 * stället `relations` — fältnamnet på respektive modell som posten täcker —
 * och `load` väljer villkor efter subjektets dimension. Saknas dimensionen i
 * `relations` deltar källan inte där, och ett anrop ändå är ett FEL, inte en
 * tom lista.
 *
 * ── PERSONDATA I OBJEKTDIMENSIONERNA ────────────────────────────────────────
 *
 * En lägenhets historik spänner över alla hyresgäster som bott där, även
 * tidigare. Två regler bär det:
 *
 *   1. INGEN mappning läser personfält ur `Tenant` (namn, e-post, telefon,
 *      personnummer). Identiteten bärs som id-referenser (lease-id, tenant-id i
 *      source-pekare) — samma åtkomst som redan finns via GET /leases.
 *   2. Sammanställning vid läsning har INGEN andra kopia. Det anonymiseringen
 *      nollar (`anonymize-tenant.ts`) är borta ur svaret i samma ögonblick —
 *      det finns ingen historiktabell att glömma att skrubba. Prövas i
 *      object-history.db.spec.ts mot den RIKTIGA anonymiseringsfunktionen.
 *
 * Kvarstående, ÄRVD yta (inte introducerad här): fritextfält som
 * anonymiseringen medvetet inte rör — `Lease.terminationReason`, ärendetexter,
 * dokumentnamn. De syns redan i /leases, /maintenance och /documents för samma
 * roller, och deras skrubbning är anonymiseringsvägens öppna fråga, inte
 * historikens.
 */
import type { PrismaClient, UserRole } from '@prisma/client'
import {
  ACTOR_UNKNOWN,
  actorFromEventActorType,
  humanOrUnknown,
  toAmount,
  type HistoryEvent,
} from './history-event'
import type { HistorySubjectRef } from './history-subject'

/** Vad varje laddare får veta. Scopat på organisationen som allt annat. */
export interface HistoryQuery {
  prisma: PrismaClient
  organizationId: string
  subject: HistorySubjectRef
}

type DimensionKey = 'tenant' | 'unit' | 'property'

export interface HistorySourceDefinition {
  /** Stabil nyckel för källan. Används i felmeddelanden och i tester. */
  key: string
  /** Prisma-modellen som raderna kommer ur (kan skilja sig från relationens typ). */
  table: string
  /**
   * Fältnamnet på respektive modell som posten täcker. VAKTENS nycklar: varje
   * relation på Tenant/Unit/Property måste täckas av någon posts `relations`
   * eller kvitteras i ack-filen. En dimension som saknas här betyder att källan
   * inte deltar i den dimensionens historik — ett deklarerat beslut, inte en
   * tystnad.
   */
  relations: Partial<Record<DimensionKey, string>>
  /**
   * Roller som får se källan. `undefined` = alla org-inloggade roller.
   *
   * ETT AGGREGAT FÅR INTE VIDGA ÅTKOMST (planens Del 8, uppmätt i #589): en
   * källa med snävare grind någon annanstans i API:t behåller den grinden här.
   * Uppmätt 2026-08-31 för objektdimensionerna: samtliga käll-GET:ar
   * (maintenance-plans, news, consumption/meters/readings, keys, documents,
   * inspections) ligger i authz-surface-goldens hink "öppen för VARJE roll",
   * så unit-/property-historiken bär inga begränsade källor. De två snäva
   * (AI-körningar, GDPR-radering) finns bara i hyresgästdimensionen.
   */
  restrictedToRoles?: readonly UserRole[]
  load: (q: HistoryQuery) => Promise<HistoryEvent[]>
}

/**
 * Villkor per dimension. Att anropa en källa i en dimension den inte deklarerat
 * är ett programmeringsfel och ska smälla — en tyst tom lista hade sett ut som
 * "inget hände", vilket är exakt den förväxling registret finns för att hindra.
 */
function villkorFör<T>(q: HistoryQuery, per: Partial<Record<DimensionKey, T>>, källa: string): T {
  const nyckel = q.subject.kind.toLowerCase() as DimensionKey
  const v = per[nyckel]
  if (v === undefined) {
    throw new Error(`historikkällan ${källa} stödjer inte dimensionen ${q.subject.kind}`)
  }
  return v
}

// ── Källorna ────────────────────────────────────────────────────────────────

const leases: HistorySourceDefinition = {
  key: 'lease',
  table: 'Lease',
  relations: { tenant: 'leases', unit: 'leases' },
  // Ett avtal producerar FLERA händelser: det skapades, det aktiverades, det
  // sades upp. Att bara visa `createdAt` hade dolt hela livscykeln.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        tenant: { organizationId, tenantId: q.subject.id },
        unit: { organizationId, unitId: q.subject.id },
      },
      'lease',
    )
    const rows = await prisma.lease.findMany({
      where,
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
  table: 'InvoiceEvent',
  relations: { tenant: 'invoices' },
  // Fakturans historik läses ur den APPEND-ONLY händelseloggen, inte ur
  // fakturans nuvarande status. Statusen säger var den är NU; loggen säger vad
  // som hände — och den bär dessutom `actorType`, alltså en riktig aktör.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { invoice: { organizationId, tenantId: q.subject.id } } },
      'invoice-event',
    )
    const rows = await prisma.invoiceEvent.findMany({
      where,
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
  table: 'RentNoticeEvent',
  relations: { tenant: 'rentNotices' },
  // Samma skäl som fakturan: händelseloggen, inte nuvarande status.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { rentNotice: { organizationId, tenantId: q.subject.id } } },
      'rent-notice-event',
    )
    const rows = await prisma.rentNoticeEvent.findMany({
      where,
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

/**
 * Kravtrappans steg är olika allvarliga — det är hela poängen med trappan.
 *
 * ── MISSLYCKANDENA SAKNADES, OCH DET VAR TYST ───────────────────────────────
 *
 * Regeln matchade bara på `WRITTEN_OFF`, `COLLECTION`, `REMIND`, `OVERDUE` och
 * `INTEREST`. Uppmätt genom att köra ALLA 17 typerna genom funktionen (#648):
 *
 *     SEND_FAILED            INFO
 *     EMAIL_BOUNCED          INFO   ← hårdstoppar hela kravtrappan (INV-B)
 *     NOTICE_EMAIL_BOUNCED   INFO
 *
 * En studsad påminnelse ritades alltså med grå prick i den enda vy som visade
 * den. Det är samma tystnad som #648 finns för att ta bort, en vy bort.
 *
 * ── FEL-TYPERNA RÄKNAS UPP, DE MATCHAS INTE PÅ DELSTRÄNG ────────────────────
 *
 * En delsträngsregel för misslyckanden hade fångat `FAIL` och `BOUNCE` i dag och
 * tyst missat nästa typ som heter något annat. En uppräkning som fattas syns i
 * en diff; en delsträng som inte matchar syns inte alls.
 */
const MISSLYCKANDEN = new Set(['SEND_FAILED', 'EMAIL_BOUNCED', 'NOTICE_EMAIL_BOUNCED'])

export function severityForRentNoticeEvent(type: string): HistoryEvent['severity'] {
  if (MISSLYCKANDEN.has(type)) return 'CRITICAL'
  if (type.includes('WRITTEN_OFF') || type.includes('COLLECTION')) return 'CRITICAL'
  if (type.includes('REMIND') || type.includes('OVERDUE') || type.includes('INTEREST')) {
    return 'WARNING'
  }
  return 'INFO'
}

const maintenanceTickets: HistorySourceDefinition = {
  key: 'maintenance-ticket',
  table: 'MaintenanceTicket',
  relations: {
    tenant: 'maintenanceTickets',
    unit: 'maintenanceTickets',
    property: 'maintenanceTickets',
  },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        tenant: { organizationId, tenantId: q.subject.id },
        unit: { organizationId, unitId: q.subject.id },
        property: { organizationId, propertyId: q.subject.id },
      },
      'maintenance-ticket',
    )
    const rows = await prisma.maintenanceTicket.findMany({
      where,
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
  table: 'Inspection',
  relations: { tenant: 'inspections', unit: 'inspections', property: 'inspections' },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        tenant: { organizationId, tenantId: q.subject.id },
        unit: { organizationId, unitId: q.subject.id },
        property: { organizationId, propertyId: q.subject.id },
      },
      'inspection',
    )
    const rows = await prisma.inspection.findMany({
      where,
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
  table: 'KeyHandover',
  relations: { tenant: 'keyHandovers', unit: 'keyHandovers' },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        tenant: { organizationId, tenantId: q.subject.id },
        unit: { organizationId, unitId: q.subject.id },
      },
      'key-handover',
    )
    const rows = await prisma.keyHandover.findMany({
      where,
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
  table: 'Deposit',
  relations: { tenant: 'deposits' },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(q, { tenant: { organizationId, tenantId: q.subject.id } }, 'deposit')
    const rows = await prisma.deposit.findMany({
      where,
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
  table: 'TerminationRequest',
  relations: { tenant: 'terminationRequests' },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, tenantId: q.subject.id } },
      'termination-request',
    )
    const rows = await prisma.terminationRequest.findMany({
      where,
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
  table: 'Document',
  relations: { tenant: 'documents', unit: 'documents', property: 'documents' },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        tenant: { organizationId, tenantId: q.subject.id },
        unit: { organizationId, unitId: q.subject.id },
        property: { organizationId, propertyId: q.subject.id },
      },
      'document',
    )
    const rows = await prisma.document.findMany({
      where,
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
  table: 'Document',
  relations: { tenant: 'signedDocuments' },
  // EGEN post, inte en gren i `document`: `signedByTenantId` är en ANNAN
  // relation på Tenant än `tenantId`. En hyresgäst kan signera ett dokument som
  // hör till någon annan, och den signeringen är hens historik.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, signedByTenantId: q.subject.id, signedAt: { not: null } } },
      'document-signed',
    )
    const rows = await prisma.document.findMany({
      where,
      select: { id: true, signedAt: true, name: true },
    })
    return rows.map((r) => ({
      // `signedAt` är filtrerad som icke-null ovan; non-null-assertion är därför
      // en avläsning av filtret, inte ett antagande.
      at: r.signedAt as Date,
      type: 'DOCUMENT_SIGNED',
      actor: { kind: 'HUMAN' as const, id: q.subject.id, label: null },
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
  table: 'SentMessage',
  relations: { tenant: 'sentMessages' },
  // ENDAST hyresgästdimensionen, med flit: `SentMessage.subject/.content` är
  // anonymiseringens uttryckliga undantag (bevisfunktion, anonymize-tenant.ts).
  // Att lyfta ämnesraden till objektnivå vore att sprida just det fält vars
  // skrubbning är en öppen juridisk fråga. Unit/Property har heller ingen
  // relation till SentMessage i schemat.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, tenantId: q.subject.id } },
      'sent-message',
    )
    const rows = await prisma.sentMessage.findMany({
      where,
      select: { id: true, createdAt: true, subject: true, status: true, sentById: true },
    })
    return rows.map((r) => ({
      at: r.createdAt,
      type: 'MESSAGE_SENT',
      actor: humanOrUnknown(r.sentById),
      subject: { kind: 'TENANT' as const, id: q.subject.id, label: null },
      description: `Meddelande skickat: ${r.subject}`,
      amount: null,
      severity: r.status === 'FAILED' ? ('WARNING' as const) : ('INFO' as const),
      source: { table: 'SentMessage', id: r.id },
    }))
  },
}

const consumptionCharges: HistorySourceDefinition = {
  key: 'consumption-charge',
  table: 'ConsumptionCharge',
  relations: { tenant: 'consumptionCharges' },
  // IMD-motorn skapar dessa maskinellt ur mätaravläsningar — därför SYSTEM,
  // och det är ett påstående som stämmer: ingen människa knappar in dem.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, tenantId: q.subject.id } },
      'consumption-charge',
    )
    const rows = await prisma.consumptionCharge.findMany({
      where,
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
  table: 'MiscCharge',
  relations: { tenant: 'miscCharges' },
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, tenantId: q.subject.id } },
      'misc-charge',
    )
    const rows = await prisma.miscCharge.findMany({
      where,
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
  table: 'TenantAnonymizationLog',
  relations: { tenant: 'anonymizationLogs' },
  // Speglar `POST /tenants/:id/anonymize`, som är OWNER-only.
  restrictedToRoles: ['OWNER'],
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, tenantId: q.subject.id } },
      'anonymization',
    )
    const rows = await prisma.tenantAnonymizationLog.findMany({
      where,
      select: { id: true, performedAt: true, performedById: true, reason: true },
    })
    return rows.map((r) => ({
      at: r.performedAt,
      type: 'TENANT_ANONYMIZED',
      actor: humanOrUnknown(r.performedById),
      subject: { kind: 'TENANT' as const, id: q.subject.id, label: null },
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
  table: 'AiToolExecution',
  relations: { tenant: 'aiToolExecutions' },
  // AGENTSPÅRET. Planens Del 8: agentens arbete ska synas i SAMMA flöde som
  // allt annat. Bara hyresgästdimensionen: AiToolExecution bär tenantId men
  // varken unitId eller propertyId — det finns ingen relation att täcka där.
  // Speglar `/ai-usage` och `/ai/usage`, som är ACCOUNTANT, ADMIN, OWNER.
  restrictedToRoles: ['ACCOUNTANT', 'ADMIN', 'OWNER'],
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { tenant: { organizationId, tenantId: q.subject.id } },
      'ai-tool-execution',
    )
    const rows = await prisma.aiToolExecution.findMany({
      where,
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
      subject: { kind: 'TENANT' as const, id: q.subject.id, label: null },
      description: r.success
        ? `AI utförde ${r.toolName}${r.confirmedAt ? ' (bekräftad)' : ''}`
        : `AI misslyckades med ${r.toolName}`,
      amount: null,
      severity: r.success ? ('INFO' as const) : ('WARNING' as const),
      source: { table: 'AiToolExecution', id: r.id },
    }))
  },
}

const aiAssignments: HistorySourceDefinition = {
  key: 'ai-assignment',
  table: 'AiAssignment',
  relations: { tenant: 'aiAssignments', unit: 'aiAssignments', property: 'aiAssignments' },
  // UPPDRAGSKÖN I SAMMA FLÖDE SOM ALLT ANNAT (planens etapp 4). `AiToolExecution`
  // bär vad agenten GJORDE; den här källan bär vad den BAD OM ATT FÅ GÖRA och
  // vad människan svarade. Utan den är "uppdrag från 03:00 finns 09:00" sant i
  // databasen och osynligt för hyresvärden.
  //
  // Speglar läsytan `GET /ai/assignments`, som är OWNER, ADMIN, MANAGER
  // (`ai-assignments.controller.ts`). ETT AGGREGAT FÅR INTE VIDGA ÅTKOMST.
  restrictedToRoles: ['OWNER', 'ADMIN', 'MANAGER'],
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        tenant: { organizationId, tenantId: q.subject.id },
        unit: { organizationId, unitId: q.subject.id },
        property: { organizationId, propertyId: q.subject.id },
      },
      'ai-assignment',
    )
    const rows = await prisma.aiAssignment.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        toolName: true,
        title: true,
        status: true,
        statusReason: true,
        deadline: true,
        decidedAt: true,
        decidedByUserId: true,
      },
    })

    const subject = { kind: q.subject.kind, id: q.subject.id, label: null } as const
    const händelser: HistoryEvent[] = []

    for (const r of rows) {
      // ── 1. SKAPAT — alltid, för varje uppdrag ────────────────────────────
      //
      // AKTÖREN ÄR `AGENT`, OCH DET ÄR ETT MÄTT PÅSTÅENDE, INTE EN GISSNING.
      // `AiAssignmentsController` har inget `POST` — det står utskrivet i dess
      // egen docblock — och `AiAssignmentsService` refereras utanför sin katalog
      // bara av `ai.module.ts` som provider. Det finns alltså ingen väg för en
      // människa att lägga en rad i den här tabellen. En uppdragsrad ÄR ett
      // agentförslag; det är hela tabellens skäl att finnas.
      //
      // `id: null` med flit: vid skapandet finns ingen `AiToolExecution` att
      // peka på (`aiToolExecutionId` fylls först av utföraren, etapp 8-9). Att
      // skriva in mottagaren eller beslutsfattaren där hade varit att låta
      // `actor.id` betyda en människa i en rad vars `kind` säger AGENT.
      händelser.push({
        at: r.createdAt,
        type: 'AI_ASSIGNMENT_CREATED',
        actor: { kind: 'AGENT', id: null, label: r.toolName },
        subject,
        description: `AI föreslog: ${r.title}`,
        amount: null,
        severity: 'INFO',
        source: { table: 'AiAssignment', id: r.id },
      })

      // ── 2. UTFALLET — noll eller en rad till, aldrig fler ────────────────
      //
      // FYRA TILLSTÅND, INTE FEM ELLER SEX. `AiAssignmentStatus` har
      // `AWAITING_APPROVAL | APPROVED | REJECTED | EXPIRED`, och schemat säger
      // uttryckligen att `EXECUTED` och `FAILED` läggs till av den PR som bygger
      // utföraren, TILLSAMMANS MED DET SOM SKRIVER DEM. Att skriva en
      // "utförd"-händelse här hade gett läsytan en rad som aldrig kan uppstå —
      // en vokabulär som ser ut som en mekanism.
      //
      // `AWAITING_APPROVAL` ger ingen andra rad. Ett uppdrag som väntar HAR inte
      // haft ett utfall, och en rad om det hade varit en händelse utan
      // tidpunkt.
      if (r.status === 'APPROVED' || r.status === 'REJECTED') {
        // AKTÖREN ÄR `HUMAN`, och det är belagt på samma sätt som ovan:
        // `besluta()` anropas bara från `@Patch(':id/decision')` med `user.sub`
        // ur JWT:n. Det finns ingen AI-verktygsväg dit. Det här är alltså ETT AV
        // FÅ ställen i historiken där `HUMAN` går att säga utan att gissa — jfr
        // `humanOrUnknown`, som måste svara UNKNOWN därför att dess kolumner
        // skrivs av både människa och assistent.
        const godkänt = r.status === 'APPROVED'
        händelser.push({
          // `decidedAt` sätts i samma `updateMany` som statusen och kan därför
          // inte saknas här. Fallbacken finns för typens skull, inte för ett
          // känt fall.
          at: r.decidedAt ?? r.createdAt,
          type: godkänt ? 'AI_ASSIGNMENT_APPROVED' : 'AI_ASSIGNMENT_REJECTED',
          actor: { kind: 'HUMAN', id: r.decidedByUserId, label: null },
          subject,
          description: godkänt
            ? `Uppdrag godkänt: ${r.title}`
            : `Uppdrag avslaget: ${r.title}${r.statusReason ? ` — ${r.statusReason}` : ''}`,
          amount: null,
          // Ett godkännande är ett tillstånd att utföra, inte en utförd effekt.
          // Ett avslag är en människas nej. Båda är värda att märka i flödet,
          // ingetdera är en varning.
          severity: 'NOTICE',
          source: { table: 'AiAssignment', id: r.id },
        })
      } else if (r.status === 'EXPIRED') {
        // ── VARFÖR `deadline` OCH INTE `updatedAt` ────────────────────────
        //
        // Modellen bär ingen stängningstidpunkt: `decidedAt` är null vid
        // förfall, och `updatedAt` är en teknisk kolumn vars betydelse vilar på
        // invarianten "ingenting rör en EXPIRED-rad efteråt". Den invarianten
        // är sann i dag och är exakt den sorts premiss som ruttnar tyst när
        // utföraren landar.
        //
        // `deadline` är i stället DATA: satt vid skapandet, och den är själva
        // faktumet händelsen handlar om. Priset står här så att ingen behöver
        // gissa det: ligger utgångscronen nere ett dygn säger raden fortfarande
        // att gränsen passerade när den passerade — inte när passet råkade
        // upptäcka det.
        //
        // Aktören är `SYSTEM`: cronen `ai-assignment-expiry` stängde raden.
        // Ingen människa var inblandad, och det är hela poängen med det
        // synliga förfallet (planens Del 12).
        händelser.push({
          at: r.deadline,
          type: 'AI_ASSIGNMENT_EXPIRED',
          actor: { kind: 'SYSTEM', id: null, label: null },
          subject,
          description: `Uppdrag förföll utan beslut: ${r.title}${
            r.statusReason ? ` — ${r.statusReason}` : ''
          }`,
          amount: null,
          // WARNING och inte INFO: ett uppdrag som förföll är något som INTE
          // hände fast det var tänkt att hända. Ett tyst förfall är förbjudet.
          severity: 'WARNING',
          source: { table: 'AiAssignment', id: r.id },
        })
      }
    }

    return händelser
  },
}

const meters: HistorySourceDefinition = {
  key: 'meter',
  table: 'Meter',
  relations: { unit: 'meters' },
  // NY i objektdimensionen: mätare hör till lägenheten, inte hyresgästen.
  // En mätare producerar installations-/borttagningshändelser OCH sina
  // avläsningar — avläsningen är planens eget exempel på lägenhetens historik.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(q, { unit: { organizationId, unitId: q.subject.id } }, 'meter')
    const rows = await prisma.meter.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        installedAt: true,
        removedAt: true,
        type: true,
        unitOfMeasure: true,
        readings: {
          select: { id: true, readingDate: true, value: true, source: true, registeredById: true },
        },
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'UNIT' as const, id: q.subject.id, label: null }
      out.push({
        // `installedAt` när den finns — det är då mätaren kom på plats.
        // `createdAt` är bara när någon hann registrera den.
        at: r.installedAt ?? r.createdAt,
        type: 'METER_INSTALLED',
        actor: ACTOR_UNKNOWN,
        subject,
        description: `Mätare installerad (${r.type})`,
        amount: null,
        severity: 'INFO',
        source: { table: 'Meter', id: r.id },
      })
      if (r.removedAt) {
        out.push({
          at: r.removedAt,
          type: 'METER_REMOVED',
          actor: ACTOR_UNKNOWN,
          subject,
          description: `Mätare borttagen (${r.type})`,
          amount: null,
          severity: 'NOTICE',
          source: { table: 'Meter', id: r.id },
        })
      }
      for (const läsning of r.readings) {
        out.push({
          at: läsning.readingDate,
          type: 'METER_READING',
          // MANUAL bär den som knappade in; IMPORT/API är maskinens väg.
          actor:
            läsning.source === 'MANUAL'
              ? humanOrUnknown(läsning.registeredById)
              : { kind: 'SYSTEM' as const, id: null, label: null },
          subject,
          description: `Avläsning (${r.type}): ${läsning.value} ${r.unitOfMeasure}`,
          amount: null,
          severity: 'INFO',
          source: { table: 'MeterReading', id: läsning.id },
        })
      }
    }
    return out
  },
}

const maintenancePlans: HistorySourceDefinition = {
  key: 'maintenance-plan',
  table: 'MaintenancePlan',
  relations: { property: 'maintenancePlans' },
  // NY i fastighetsdimensionen. Planens intervall är dessutom den enda
  // konfigurerade återkommande förväntan i systemet — luckberäkningen läser
  // samma rader.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { property: { organizationId, propertyId: q.subject.id } },
      'maintenance-plan',
    )
    const rows = await prisma.maintenancePlan.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        completedAt: true,
        title: true,
        estimatedCost: true,
        actualCost: true,
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = { kind: 'PROPERTY' as const, id: q.subject.id, label: r.title }
      out.push({
        at: r.createdAt,
        type: 'MAINTENANCE_PLAN_CREATED',
        actor: ACTOR_UNKNOWN,
        subject,
        description: `Underhållsplan upprättad: ${r.title}`,
        amount: toAmount(r.estimatedCost),
        severity: 'INFO',
        source: { table: 'MaintenancePlan', id: r.id },
      })
      if (r.completedAt) {
        out.push({
          at: r.completedAt,
          type: 'MAINTENANCE_PLAN_COMPLETED',
          actor: ACTOR_UNKNOWN,
          subject,
          description: `Underhållsplan utförd: ${r.title}`,
          amount: toAmount(r.actualCost),
          severity: 'NOTICE',
          source: { table: 'MaintenancePlan', id: r.id },
        })
      }
    }
    return out
  },
}

const newsPosts: HistorySourceDefinition = {
  key: 'news-post',
  table: 'NewsPost',
  relations: { property: 'newsPosts' },
  // Bara PUBLICERADE nyheter: ett utkast har inte hänt fastigheten ännu.
  // Filtret är deklarerat här och speglas i acceptanstestets facit — en
  // uppräkning som krymper av ett filter måste bära filtret synligt.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      { property: { organizationId, propertyId: q.subject.id, publishedAt: { not: null } } },
      'news-post',
    )
    const rows = await prisma.newsPost.findMany({
      where,
      select: { id: true, publishedAt: true, title: true, createdById: true },
    })
    return rows.map((r) => ({
      at: r.publishedAt as Date,
      type: 'NEWS_PUBLISHED',
      actor: humanOrUnknown(r.createdById),
      subject: { kind: 'PROPERTY' as const, id: q.subject.id, label: null },
      description: `Nyhet publicerad: ${r.title}`,
      amount: null,
      severity: 'INFO' as const,
      source: { table: 'NewsPost', id: r.id },
    }))
  },
}

const equipment: HistorySourceDefinition = {
  key: 'equipment',
  table: 'UnitEquipment',
  relations: { unit: 'equipment', property: 'equipment' },
  // ── UTRUSTNINGEN OCH DESS BYTEN (etapp 1b) ─────────────────────────────────
  //
  // Svarar på "vad byttes och när". Saken själv ger INSTALLED/REMOVED; kedjan
  // `replacedById` ger EQUIPMENT_REPLACED — det påstående om SAMBAND som två
  // lösa rader med sammanfallande datum inte kan göra.
  //
  // Dimensionerna skiljer sig: lägenheten visar det som sitter i den,
  // fastigheten visar ALLT som hör till huset — inklusive det som sitter i en
  // lägenhet. En hiss (unitId = null) syns bara på fastigheten; ett kylskåp
  // syns på båda. Det är avsiktligt: fastighetsägaren som frågar "vad har vi
  // bytt i huset" vill ha med lägenheternas vitvaror.
  async load(q) {
    const { prisma, organizationId } = q
    const where = villkorFör(
      q,
      {
        unit: { organizationId, unitId: q.subject.id },
        property: { organizationId, propertyId: q.subject.id },
      },
      'equipment',
    )
    const rows = await prisma.unitEquipment.findMany({
      where,
      select: {
        id: true,
        kind: true,
        label: true,
        installedAt: true,
        removedAt: true,
        unitId: true,
        replacedById: true,
        replacedBy: { select: { id: true, kind: true, label: true, installedAt: true } },
      },
    })
    const out: HistoryEvent[] = []
    for (const r of rows) {
      const subject = {
        kind: (r.unitId ? 'UNIT' : 'PROPERTY') as 'UNIT' | 'PROPERTY',
        id: r.unitId ?? q.subject.id,
        label: r.label,
      }
      const namn = r.label ? `${r.kind} (${r.label})` : String(r.kind)
      out.push({
        at: r.installedAt,
        type: 'EQUIPMENT_INSTALLED',
        actor: ACTOR_UNKNOWN,
        subject,
        description: `Utrustning installerad: ${namn}`,
        amount: null,
        severity: 'INFO',
        source: { table: 'UnitEquipment', id: r.id },
      })
      if (r.removedAt) {
        // BYTE eller ren BORTTAGNING — skillnaden är om en efterträdare finns.
        // Att alltid säga "borttagen" hade dolt bytet; att alltid säga "bytt"
        // hade påstått ett samband som inte finns.
        if (r.replacedBy) {
          const efterNamn = r.replacedBy.label
            ? `${r.replacedBy.kind} (${r.replacedBy.label})`
            : String(r.replacedBy.kind)
          out.push({
            at: r.removedAt,
            type: 'EQUIPMENT_REPLACED',
            actor: ACTOR_UNKNOWN,
            subject,
            description: `Utrustning byttes: ${namn} → ${efterNamn}`,
            amount: null,
            severity: 'NOTICE',
            source: { table: 'UnitEquipment', id: r.id },
          })
        } else {
          out.push({
            at: r.removedAt,
            type: 'EQUIPMENT_REMOVED',
            actor: ACTOR_UNKNOWN,
            subject,
            description: `Utrustning borttagen: ${namn}`,
            amount: null,
            severity: 'NOTICE',
            source: { table: 'UnitEquipment', id: r.id },
          })
        }
      }
    }
    return out
  },
}

const equipmentEvents: HistorySourceDefinition = {
  key: 'equipment-event',
  table: 'UnitEquipmentEvent',
  // TÄCKER INGEN EGEN RELATION: `UnitEquipmentEvent` hänger på UnitEquipment,
  // inte på Unit/Property. `relations` speglar därför utrustningens egna —
  // vakten prövar relationer på Unit/Property, och den här källan deltar i
  // samma två dimensioner som sin förälder.
  relations: { unit: 'equipment', property: 'equipment' },
  // Service och reparation finns INGEN ANNANSTANS i systemet. Till skillnad
  // från avier och fakturor, som har sina domänrader kvar att jämföra mot, är
  // den här tabellen enda källan — därför är den append-only med databastrigger.
  async load(q) {
    const { prisma, organizationId } = q
    const equipmentWhere = villkorFör(
      q,
      {
        unit: { organizationId, unitId: q.subject.id },
        property: { organizationId, propertyId: q.subject.id },
      },
      'equipment-event',
    )
    const rows = await prisma.unitEquipmentEvent.findMany({
      where: { equipment: equipmentWhere },
      select: {
        id: true,
        type: true,
        occurredAt: true,
        note: true,
        maintenanceTicketId: true,
        equipment: { select: { id: true, kind: true, label: true, unitId: true } },
      },
    })
    return rows.map((r) => {
      const namn = r.equipment.label
        ? `${r.equipment.kind} (${r.equipment.label})`
        : String(r.equipment.kind)
      return {
        at: r.occurredAt,
        type: `EQUIPMENT_${r.type}`,
        actor: ACTOR_UNKNOWN,
        subject: {
          kind: (r.equipment.unitId ? 'UNIT' : 'PROPERTY') as 'UNIT' | 'PROPERTY',
          id: r.equipment.unitId ?? q.subject.id,
          label: r.equipment.label,
        },
        description: r.note ? `${namn}: ${r.note}` : `${namn}: ${r.type}`,
        amount: null,
        severity: r.type === 'REPAIRED' ? ('WARNING' as const) : ('INFO' as const),
        source: { table: 'UnitEquipmentEvent', id: r.id },
      }
    })
  },
}

/**
 * REGISTRET. Vakten läser `relations` ur varje post och jämför mot
 * `model Tenant`, `model Unit` och `model Property` i `schema.prisma`.
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
  aiAssignments,
  meters,
  maintenancePlans,
  newsPosts,
  equipment,
  equipmentEvents,
]
