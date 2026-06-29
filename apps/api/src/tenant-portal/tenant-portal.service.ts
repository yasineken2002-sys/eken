import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import type {
  Invoice,
  Lease,
  MaintenanceCategory,
  MaintenancePriority,
  MaintenanceStatus,
  Prisma,
  Property,
  Unit,
} from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { NotificationsService } from '../notifications/notifications.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { rentNoticePayableTotal } from '../common/utils/rent-notice-total.util'

type InvoiceWithLease = Invoice & {
  lease?: (Lease & { unit: Unit & { property: Property } }) | null
}

/**
 * Safe Prisma SELECT för MaintenanceTicket som exponeras mot hyresgästportalen.
 *
 * Spegel av SAFE_TENANT_SELECT (tenants.service.ts): allow-list på DB-nivå så de
 * interna fälten ALDRIG ens lämnar Postgres (lager 1). Tillsammans med mapTicket
 * (explicit mapper nedan, lager 2) ger detta dubbelt fält-skydd.
 *
 * EXPLICIT EXKLUDERADE — LÄGG ALDRIG TILL. Dessa läcker hyresvärdens ekonomi/
 * credentials till hyresgästen (PR 5a säkerhetsfix):
 *  - organizationId   tenant-isolationens scope-nyckel
 *  - estimatedCost    hyresvärdens interna kostnadsuppskattning
 *  - actualCost       hyresvärdens faktiska kostnad
 *  - reportedById     internt user-id
 *  - assignedToId     internt user-id (vem som tilldelats ärendet)
 *  - tenantToken      @unique, credential-liknande ärende-token
 *  - chargeId         intern FK → MiscCharge
 *  - tenantNotified   intern utskicksflagga
 *
 * Nästlade property/unit har EGNA allow-lists (aldrig `include: true`) så
 * fireSafetyNotes, consumptionBillingMode, monthlyRent, voluntaryTaxLiability och
 * organizationId aldrig följer med.
 */
export const SAFE_TICKET_SELECT = {
  id: true,
  ticketNumber: true,
  title: true,
  description: true,
  category: true,
  priority: true,
  status: true,
  scheduledDate: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  property: { select: { id: true, name: true, street: true, city: true, postalCode: true } },
  unit: { select: { id: true, name: true, unitNumber: true, floor: true } },
  comments: {
    where: { isInternal: false },
    orderBy: { createdAt: 'asc' },
    select: { id: true, content: true, isInternal: true, createdAt: true },
  },
} as const satisfies Prisma.MaintenanceTicketSelect

/**
 * Minsta gemensamma form som mapTicket läser. Både SAFE_TICKET_SELECT-rader och
 * MaintenanceService.create()-payloaden (property/unit/tenant redan select:ade,
 * men rot-skalärerna fulla) är strukturellt kompatibla med denna — så mapTicket
 * strippar de interna rot-fälten oavsett varifrån ärendet kom (lager 2).
 */
interface MappableTicket {
  id: string
  ticketNumber: string
  title: string
  description: string
  category: MaintenanceCategory
  priority: MaintenancePriority
  status: MaintenanceStatus
  scheduledDate: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  property: { name: string } | null
  unit: { name: string } | null
  comments: Array<{ id: string; content: string; createdAt: Date; isInternal: boolean }>
}

/**
 * Explicit mapper (lager 2). Bygger hyresgäst-DTO:n fält för fält så att även om
 * en framtida `select` skulle dra in ett internt fält, når det aldrig svaret.
 */
function mapTicket(t: MappableTicket) {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    title: t.title,
    description: t.description,
    category: t.category,
    priority: t.priority,
    status: t.status,
    scheduledDate: t.scheduledDate?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    property: t.property ? { name: t.property.name } : null,
    unit: t.unit ? { name: t.unit.name } : null,
    comments: t.comments.map((c) => ({
      id: c.id,
      content: c.content,
      isInternal: c.isInternal,
      createdAt: c.createdAt.toISOString(),
    })),
  }
}

/**
 * Safe Prisma SELECT:ar för Unit/Property/Document mot hyresgästportalen (PR 5a).
 *
 * Samma allow-list-princip som SAFE_TICKET_SELECT: portalen får BARA de fält den
 * faktiskt visar (matchar PortalUnit/PortalProperty/PortalDocument i apps/portal).
 * `include: true` på dessa relationer läckte tidigare interna fält till
 * hyresgästen via getLease/getDocuments/exportTenantData.
 *
 * EXPLICIT EXKLUDERADE — LÄGG ALDRIG TILL:
 *  - Unit: monthlyRent, voluntaryTaxLiability (intern moms-konfig)
 *  - Property: fireSafetyNotes, commonAreasNotes, garbageDisposalRules,
 *    consumptionBillingMode, organizationId
 *  - Document: storageKey (intern R2-nyckel), uploadedById, signedFromIp,
 *    signedUserAgent, contentHash, templateInputHash, organizationId
 */
export const SAFE_PORTAL_UNIT_SELECT = {
  id: true,
  name: true,
  unitNumber: true,
  area: true,
  floor: true,
  rooms: true,
} as const satisfies Prisma.UnitSelect

export const SAFE_PORTAL_PROPERTY_SELECT = {
  id: true,
  name: true,
  street: true,
  city: true,
  postalCode: true,
} as const satisfies Prisma.PropertySelect

export const SAFE_PORTAL_DOCUMENT_SELECT = {
  id: true,
  name: true,
  description: true,
  mimeType: true,
  fileSize: true,
  category: true,
  createdAt: true,
} as const satisfies Prisma.DocumentSelect

/**
 * GDPR Art. 15-export: dokumentets egna metadata PLUS hyresgästens egna
 * signeringsspår (signedFromIp/UserAgent/signatureName = data OM hyresgästen),
 * men ALDRIG intern R2-nyckel (storageKey/storageUrl), uppladdare eller hashar.
 * Delas av BÅDE leases.documents och top-level documents i exportTenantData.
 */
export const SAFE_PORTAL_EXPORT_DOCUMENT_SELECT = {
  id: true,
  name: true,
  description: true,
  mimeType: true,
  fileSize: true,
  category: true,
  signedAt: true,
  signedFromIp: true,
  signedUserAgent: true,
  signatureName: true,
  createdAt: true,
} as const satisfies Prisma.DocumentSelect

/**
 * Safe portal-fält för MaintenanceImage (PR 5a). Hyresgästen ser sina egna
 * uppladdade bilder men ALDRIG den interna R2-nyckeln (storageKey).
 */
export const SAFE_PORTAL_IMAGE_SELECT = {
  id: true,
  filename: true,
  storageUrl: true,
  size: true,
  createdAt: true,
} as const satisfies Prisma.MaintenanceImageSelect

/**
 * Explicit mapper för MaintenanceImage-rader som redan skapats (t.ex. svaret från
 * MaintenanceService.addImages, som returnerar HELA raden inkl. intern R2-nyckel).
 * Strippar storageKey/ticketId innan bilden når hyresgästen (lager 2).
 */
export function mapPortalImage(img: {
  id: string
  filename: string
  storageUrl: string
  size: number
  createdAt: Date
}) {
  return {
    id: img.id,
    filename: img.filename,
    storageUrl: img.storageUrl,
    size: img.size,
    createdAt: img.createdAt,
  }
}

/**
 * Safe Prisma SELECT för RentNotice (hyresavi) mot hyresgästportalen.
 *
 * Allow-list (lager 1) + mapRentNotice (lager 2) — spegel av SAFE_TICKET_SELECT.
 * Ersätter det tidigare `omit`-mönstret (blocklist): med en allow-list kan
 * framtida interna RentNotice-fält inte auto-läcka. property/unit återbrukar 5a:s
 * SAFE_PORTAL_*_SELECT (för propertyName/unitName).
 *
 * reminderFeeAmount tas med ENBART för att rentNoticePayableTotal ska kunna räkna
 * (exponeras aldrig som eget fält VIA mapRentNotice; i GDPR Art. 15-exporten, som
 * returnerar select-raderna utan mapper, ingår den däremot — korrekt, det är
 * hyresgästens egna debiterade avgift).
 *
 * EXPLICIT EXKLUDERADE — LÄGG ALDRIG TILL (interna/kravtrappa/infra):
 *  - organizationId, tenantId, leaseId
 *  - sendError, sentTo (leveransinfra), paidAmount, paymentMethod
 *  - reminderPdfStorageKey (R2-nyckel), reminderMessageId
 *  - collectionStage, remindedAt, collectionReadyAt, writtenOffAt, probableLossAt
 *  - interestAccruedAmount, interestAccruedThrough
 *  - type, periodStart, periodEnd, daysCharged, totalDays, isProrated
 */
export const SAFE_PORTAL_RENT_NOTICE_SELECT = {
  id: true,
  noticeNumber: true,
  ocrNumber: true,
  month: true,
  year: true,
  amount: true,
  vatAmount: true,
  totalAmount: true,
  consumptionAmount: true,
  miscChargeAmount: true,
  reminderFeeAmount: true,
  dueDate: true,
  paidAt: true,
  status: true,
  sentAt: true,
  lease: {
    select: {
      unit: {
        select: {
          ...SAFE_PORTAL_UNIT_SELECT,
          property: { select: SAFE_PORTAL_PROPERTY_SELECT },
        },
      },
    },
  },
} as const satisfies Prisma.RentNoticeSelect

type PortalRentNoticeRow = Prisma.RentNoticeGetPayload<{
  select: typeof SAFE_PORTAL_RENT_NOTICE_SELECT
}>

/**
 * Explicit mapper (lager 2) → exakt portal-kontraktet (PortalRentNotice). Bygger
 * DTO:n fält för fält så interna fält aldrig kan följa med, även om selecten
 * skulle driva.
 */
export function mapRentNotice(notice: PortalRentNoticeRow) {
  return {
    id: notice.id,
    noticeNumber: notice.noticeNumber,
    ocrNumber: notice.ocrNumber,
    month: notice.month,
    year: notice.year,
    amount: Number(notice.amount),
    vatAmount: Number(notice.vatAmount),
    // consumptionAmount = förbrukning (IMD); miscChargeAmount = övriga debiterbara
    // poster (skada/nyckel); totalAmount = hyra. payableTotal = vad hyresgästen
    // faktiskt ska betala (hyra + förbrukning + övrig debitering + påminnelseavgift).
    consumptionAmount: Number(notice.consumptionAmount),
    miscChargeAmount: Number(notice.miscChargeAmount),
    totalAmount: Number(notice.totalAmount),
    payableTotal: rentNoticePayableTotal(notice),
    dueDate: notice.dueDate.toISOString(),
    paidAt: notice.paidAt?.toISOString() ?? null,
    status: notice.status,
    sentAt: notice.sentAt?.toISOString() ?? null,
    propertyName: notice.lease?.unit?.property?.name ?? '',
    unitName: notice.lease?.unit?.name ?? '',
  }
}

/**
 * Safe Prisma SELECT för MiscCharge (övrig debitering: skada/nyckel, teknisk
 * förvaltning) mot hyresgästportalen.
 *
 * Allow-list (lager 1) + mapMiscCharge (lager 2) — spegel av
 * SAFE_PORTAL_RENT_NOTICE_SELECT. BARA de fält hyresgästen ska se: belopp,
 * beskrivning, datum. Inga relationer.
 *
 * EXPLICIT EXKLUDERADE — LÄGG ALDRIG TILL:
 *  - vatStatus, vatRate     (internt momsbeslut; momsen ligger i vatAmount)
 *  - status                 (filtreras på, exponeras ALDRIG rått — DRAFT/CANCELLED döljs)
 *  - sourceType, sourceRefId (avslöjar intern källa: vilket ärende/inspektion)
 *  - organizationId, leaseId, tenantId (scope-internt)
 *  - createdAt, updatedAt   (interna timestamps)
 *  - maintenanceTicket / rentNoticeLine (relationer drar in interna objekt)
 */
export const SAFE_PORTAL_MISC_CHARGE_SELECT = {
  id: true,
  description: true,
  incidentDate: true,
  netAmount: true,
  vatAmount: true,
  totalAmount: true,
} as const satisfies Prisma.MiscChargeSelect

type PortalMiscChargeRow = Prisma.MiscChargeGetPayload<{
  select: typeof SAFE_PORTAL_MISC_CHARGE_SELECT
}>

/**
 * Explicit mapper (lager 2) → exakt portal-kontraktet (PortalMiscCharge). Belopp
 * coercas från Decimal till number; incidentDate till ISO-sträng.
 */
export function mapMiscCharge(charge: PortalMiscChargeRow) {
  return {
    id: charge.id,
    description: charge.description,
    incidentDate: charge.incidentDate.toISOString(),
    netAmount: Number(charge.netAmount),
    vatAmount: Number(charge.vatAmount),
    totalAmount: Number(charge.totalAmount),
  }
}

@Injectable()
export class TenantPortalService {
  private readonly logger = new Logger(TenantPortalService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenanceService: MaintenanceService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getDashboard(tenantId: string) {
    const [tenant, lease, openTickets, overdueCount, upcomingInvoice] = await Promise.all([
      // SECURITY (audit HIGH #2, uppföljning PR #10): SAFE_TENANT_SELECT så
      // hyresgästens egen dashboard aldrig returnerar passwordHash/token-hashar.
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: SAFE_TENANT_SELECT,
      }),
      this.getActiveLease(tenantId),
      // SECURITY (PR 5a): bara antalet behövs — `count` istället för `findMany`
      // (utan select) som annars drog hela ärenderader med interna kostnader/
      // tenantToken i minnet och var en foot-gun om någon bytte .length mot raderna.
      this.prisma.maintenanceTicket.count({
        where: { tenantId, status: { in: ['NEW', 'IN_PROGRESS', 'SCHEDULED'] } },
      }),
      this.prisma.invoice.count({ where: { tenantId, status: 'OVERDUE' } }),
      this.prisma.invoice.findFirst({
        where: { tenantId, status: { in: ['SENT', 'PARTIAL'] }, dueDate: { gte: new Date() } },
        include: { lease: { include: { unit: { include: { property: true } } } } },
        orderBy: { dueDate: 'asc' },
      }),
    ])

    const activeLease = lease
      ? {
          id: lease.id,
          status: lease.status,
          startDate: lease.startDate.toISOString(),
          endDate: lease.endDate?.toISOString() ?? null,
          monthlyRent: Number(lease.monthlyRent),
          depositAmount: Number(lease.depositAmount),
          noticePeriodMonths: lease.noticePeriodMonths,
          unit: {
            id: lease.unit.id,
            name: lease.unit.name,
            unitNumber: lease.unit.unitNumber,
            area: lease.unit.area,
            floor: lease.unit.floor,
            rooms: lease.unit.rooms,
          },
          property: {
            id: lease.unit.property.id,
            name: lease.unit.property.name,
            street: lease.unit.property.street,
            city: lease.unit.property.city,
            postalCode: lease.unit.property.postalCode,
          },
        }
      : null

    return {
      tenant,
      activeLease,
      overdueInvoices: overdueCount,
      upcomingInvoice: upcomingInvoice ? this.mapInvoice(upcomingInvoice) : null,
      openMaintenanceTickets: openTickets,
      unreadNotices: 0,
    }
  }

  async getNotices(tenantId: string) {
    // SECURITY (RentNotice-läcktätning): tidigare rå `findMany` + `omit` (blocklist)
    // läckte organizationId/sendError/sentTo + kravtrapp-fält (collectionStage,
    // probableLossAt …) + hela property-kedjan (fireSafetyNotes/monthlyRent) till
    // hyresgästen. Allow-list-select + mapper, samma mönster som getRentNotices.
    const rows = await this.prisma.rentNotice.findMany({
      where: { tenantId },
      select: SAFE_PORTAL_RENT_NOTICE_SELECT,
      orderBy: { dueDate: 'desc' },
    })
    return rows.map(mapRentNotice)
  }

  async getInvoices(tenantId: string) {
    // Fakturor (engångar: DEPOSIT, SERVICE, UTILITY, OTHER, samt admin-skapade
    // RENT-fakturor). DRAFT döljs — hyresgästen ska aldrig se utkast som
    // hyresvärden inte hunnit publicera.
    const rows = await this.prisma.invoice.findMany({
      where: { tenantId, status: { not: 'DRAFT' } },
      include: { lines: true, lease: { include: { unit: { include: { property: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((inv) => this.mapInvoice(inv))
  }

  /**
   * Hyresavier (RentNotice) — separat tabell från Invoice. Avier är
   * återkommande månadshyror som genereras av AviseringService, fakturor är
   * engångsbetalningar (deposition, service, m.m.). Att sammanblanda dessa
   * i samma flik var bug:en där en 16 647 kr-faktura visades under "Avier".
   */
  async getRentNotices(tenantId: string) {
    // SECURITY (RentNotice-läcktätning): samma allow-list-select + mapper som
    // getNotices. Stänger även den defense-in-depth-lucka som tidigare `include`
    // gav (hela property/unit lästes till minnet, även om mappern strippade svaret).
    const rows = await this.prisma.rentNotice.findMany({
      where: {
        tenantId,
        // Skicka inte PENDING/CANCELLED till hyresgästen — bara avier som
        // hyresvärden faktiskt skickat eller markerat betalda.
        status: { in: ['SENT', 'PAID', 'OVERDUE'] },
      },
      select: SAFE_PORTAL_RENT_NOTICE_SELECT,
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    })
    return rows.map(mapRentNotice)
  }

  /**
   * Hyresgästens egen förbrukning (IMD). GDPR-känsligt — förbrukningsdata är
   * personuppgift. Säkerhetsbeslut (security-auditor):
   *  - Scope HÅRT på tenantId (kommer från @CurrentTenant i controllern, ALDRIG
   *    från query-param → ingen IDOR; en tidigare boende kan aldrig se nuvarandes).
   *  - Returnera aggregerad ConsumptionCharge (har tenantId) — ALDRIG rå
   *    MeterReading (saknar tenantId, råa mätarställningar = onödig granularitet).
   *  - ENDAST fastställda poster: CONFIRMED/ATTACHED. DRAFT (ej bekräftad) och
   *    CANCELLED (annullerad) döljs.
   *  - Dubbelt fält-skydd: explicit `select` (allow-list) i queryn + explicit
   *    mapper nedan. Interna ekonomi-/infrafält når ALDRIG hyresgästen:
   *    organizationId, leaseId, unitId, tenantId, meterReadingId, deliveryMode,
   *    invoiceId, vatStatus, vatRate, pricePerUnit, kind, status.
   */
  async getConsumption(tenantId: string) {
    const rows = await this.prisma.consumptionCharge.findMany({
      where: { tenantId, status: { in: ['CONFIRMED', 'ATTACHED'] } },
      select: {
        id: true,
        meterType: true,
        periodStart: true,
        periodEnd: true,
        quantity: true,
        netAmount: true,
        vatAmount: true,
        totalAmount: true,
      },
      orderBy: { periodEnd: 'desc' },
    })
    return rows.map((c) => ({
      id: c.id,
      meterType: c.meterType,
      periodStart: c.periodStart.toISOString(),
      periodEnd: c.periodEnd.toISOString(),
      quantity: Number(c.quantity),
      netAmount: Number(c.netAmount),
      vatAmount: Number(c.vatAmount),
      totalAmount: Number(c.totalAmount),
    }))
  }

  /**
   * Hyresgästens egna övriga debiteringar (MiscCharge: skada/nyckel/ersättningskrav,
   * teknisk förvaltning Spår A). Speglar getConsumption EXAKT:
   *  - Scope HÅRT på tenantId (från @CurrentTenant i controllern, ALDRIG query-param
   *    → ingen IDOR; granne A kan aldrig se granne B:s debiteringar).
   *  - ENDAST fastställda poster: BARA CONFIRMED och ATTACHED passerar. DRAFT (ej
   *    bekräftad debitering) och CANCELLED (annullerad) exponeras ALDRIG för
   *    hyresgästen — en hyresgäst får aldrig se en obekräftad eller annullerad post.
   *  - Dubbelt fält-skydd: SAFE_PORTAL_MISC_CHARGE_SELECT (allow-list) + mapMiscCharge.
   *    Interna fält (vatStatus/status/sourceType/sourceRefId/organizationId/leaseId/
   *    tenantId/timestamps/relationer) når ALDRIG hyresgästen.
   */
  async getMiscCharges(tenantId: string) {
    const rows = await this.prisma.miscCharge.findMany({
      where: { tenantId, status: { in: ['CONFIRMED', 'ATTACHED'] } },
      select: SAFE_PORTAL_MISC_CHARGE_SELECT,
      orderBy: { incidentDate: 'desc' },
    })
    return rows.map(mapMiscCharge)
  }

  async getLease(tenantId: string) {
    return this.getActiveLease(tenantId)
  }

  async getDocuments(tenantId: string) {
    // SECURITY (PR 5a): rå `findMany` läckte Document.storageKey (intern R2-nyckel),
    // uploadedById, signedFromIp/UserAgent, contentHash, organizationId till
    // hyresgästen. Allow-list-select matchar PortalDocument. Filnedladdning sker
    // via separat endpoint som genererar presignerad URL — storageKey behövs aldrig.
    return this.prisma.document.findMany({
      where: { tenantId, NOT: { category: 'INVOICE' } },
      select: SAFE_PORTAL_DOCUMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    })
  }

  async getNews(tenantId: string) {
    // Scopa till hyresgästens egen organisation — tidigare saknades detta
    // helt (en hyresgäst kunde i teorin se publicerade nyheter från andra
    // organisationer som hade `targetAll: true`).
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { organizationId: true },
    })
    if (!tenant) return []

    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      include: { unit: { include: { property: true } } },
    })
    const propertyId = lease?.unit?.property?.id

    const posts = await this.prisma.newsPost.findMany({
      where: {
        organizationId: tenant.organizationId,
        publishedAt: { not: null },
        OR: [{ targetAll: true }, ...(propertyId ? [{ propertyId }] : [])],
      },
      include: {
        organization: { select: { name: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    })

    // Mappa till portal-DTO. Kontraktet (`body`, `imageUrl`,
    // `organizationName`) frikopplar portalen från Prisma-modellen så att
    // schemaändringar inte tysta-bryter klienten — vilket var precis vad
    // som hände tidigare när frontend förväntade sig `body` men Prisma
    // returnerade `content`.
    return posts.map((p) => ({
      id: p.id,
      title: p.title,
      body: p.content,
      publishedAt: p.publishedAt,
      imageUrl: null as string | null,
      organizationName: p.organization?.name ?? null,
      authorName: p.createdBy
        ? `${p.createdBy.firstName ?? ''} ${p.createdBy.lastName ?? ''}`.trim() || null
        : null,
    }))
  }

  async submitMaintenanceRequest(
    tenantId: string,
    dto: {
      title: string
      description: string
      category?: MaintenanceCategory
    },
  ) {
    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      include: {
        unit: { include: { property: true } },
        tenant: { select: SAFE_TENANT_SELECT },
      },
    })

    if (!lease) throw new BadRequestException('Inget aktivt hyresavtal hittades')

    const ticket = await this.maintenanceService.create(
      {
        title: dto.title,
        description: dto.description,
        propertyId: lease.unit.property.id,
        unitId: lease.unitId,
        tenantId,
        category: dto.category ?? 'OTHER',
        priority: 'NORMAL',
      },
      lease.organizationId,
      '',
    )

    const tenantName = lease.tenant.firstName
      ? `${lease.tenant.firstName} ${lease.tenant.lastName ?? ''}`.trim()
      : (lease.tenant.companyName ?? lease.tenant.email)

    void this.notificationsService
      .createForAllOrgUsers(
        lease.organizationId,
        'MAINTENANCE_NEW',
        '🔔 Ny felanmälan från hyresgäst',
        `${tenantName} har anmält: ${dto.title}`,
        { relatedEntityType: 'MAINTENANCE_TICKET', relatedEntityId: ticket.id },
      )
      .catch((err) =>
        this.logger.error('Notification error', err instanceof Error ? err.stack : String(err)),
      )

    // SECURITY (PR 5a): MaintenanceService.create() returnerar hela ärenderaden
    // (organizationId, tenantToken, reportedById …). Strippa via mapTicket innan
    // den når hyresgästen.
    return mapTicket(ticket)
  }

  async addMaintenanceComment(tenantId: string, ticketId: string, content: string) {
    const ticket = await this.prisma.maintenanceTicket.findFirst({
      where: { id: ticketId, tenantId },
    })
    if (!ticket) throw new BadRequestException('Ärende hittades inte')

    await this.prisma.maintenanceComment.create({
      data: { ticketId, content, isInternal: false },
    })

    // SECURITY (PR 5a): rot-ärendet var tidigare oselekterat (`findUnique` utan
    // `select`) och läckte estimatedCost/actualCost/tenantToken/chargeId/
    // organizationId. Samma allow-list + mapper som getMaintenanceTickets.
    const updated = await this.prisma.maintenanceTicket.findUnique({
      where: { id: ticketId },
      select: SAFE_TICKET_SELECT,
    })
    if (!updated) throw new BadRequestException('Ärende hittades inte')
    return mapTicket(updated)
  }

  async getMaintenanceTickets(tenantId: string) {
    // SECURITY (PR 5a): allow-list-select + mapper. `include: { property: true,
    // unit: true }` läckte tidigare estimatedCost/actualCost/tenantToken/chargeId/
    // organizationId + property.fireSafetyNotes + unit.monthlyRent till hyresgästen.
    const rows = await this.prisma.maintenanceTicket.findMany({
      where: { tenantId },
      select: SAFE_TICKET_SELECT,
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(mapTicket)
  }

  private mapInvoice(inv: InvoiceWithLease) {
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      type: inv.type,
      status: inv.status,
      total: Number(inv.total),
      dueDate: inv.dueDate.toISOString(),
      issueDate: inv.issueDate.toISOString(),
      paidAt: inv.paidAt?.toISOString() ?? null,
      propertyName: inv.lease?.unit?.property?.name ?? '',
      unitName: inv.lease?.unit?.name ?? '',
    }
  }

  private async getActiveLease(tenantId: string) {
    // SECURITY (PR 5a): `include: { unit: { include: { property: true } },
    // documents: true }` läckte tidigare property.fireSafetyNotes/
    // consumptionBillingMode, unit.monthlyRent/voluntaryTaxLiability och
    // documents.storageKey (intern R2-nyckel) till hyresgästen via GET /portal/lease.
    // Allow-list-select matchar PortalLease (property nästlad under unit, oförändrad
    // form). lease.documents konsumeras inte av portalen och utelämnas.
    return this.prisma.lease.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        monthlyRent: true,
        depositAmount: true,
        noticePeriodMonths: true,
        unit: {
          select: {
            ...SAFE_PORTAL_UNIT_SELECT,
            property: { select: SAFE_PORTAL_PROPERTY_SELECT },
          },
        },
      },
    })
  }

  // ─── GDPR ───────────────────────────────────────────────────────────────────

  /**
   * GDPR Art. 15: maskinläsbar kopia av all hyresgästens data.
   */
  async exportTenantData(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        organization: { select: { id: true, name: true } },
        // SECURITY (PR 5a): lease-kedjan läckte property.fireSafetyNotes och
        // documents.storageKey (intern R2-nyckel) in i GDPR-exporten. Allow-list
        // på unit/property; documents behåller hyresgästens egna signeringsspår
        // (signedFromIp/UserAgent/signatureName = data OM hyresgästen, Art. 15)
        // men utesluter storageKey/uploadedById/contentHash/organizationId.
        leases: {
          include: {
            unit: {
              select: {
                ...SAFE_PORTAL_UNIT_SELECT,
                property: { select: SAFE_PORTAL_PROPERTY_SELECT },
              },
            },
            documents: { select: SAFE_PORTAL_EXPORT_DOCUMENT_SELECT },
          },
        },
        invoices: { include: { lines: true } },
        // SECURITY (RentNotice-läcktätning): `omit` var en blocklist — sendError,
        // kravtrapp-fält och framtida interna fält läckte automatiskt. Byt till
        // SAMMA allow-list-select som getNotices/getRentNotices (allow-list, inte
        // blocklist) så bara hyresgäst-säkra fält ingår i GDPR-exporten.
        rentNotices: { select: SAFE_PORTAL_RENT_NOTICE_SELECT },
        // SECURITY (PR 5a): estimatedCost/actualCost är hyresvärdens interna
        // siffror — INTE hyresgästens personuppgift — och får inte ingå i en
        // GDPR Art. 15-export. SAFE_TICKET_SELECT stänger dem (+ organizationId/
        // tenantToken/chargeId). Hyresgästens egna bilder behålls men utan den
        // interna R2-nyckeln (storageKey).
        maintenanceTickets: {
          select: {
            ...SAFE_TICKET_SELECT,
            images: { select: SAFE_PORTAL_IMAGE_SELECT },
          },
        },
        // SECURITY (PR 5a): top-level `documents: true` läckte storageKey (intern
        // R2-nyckel)/storageUrl/uploadedById/contentHash/organizationId rakt in i
        // GDPR-exporten. Samma allow-list som leases.documents (round-2-fynd).
        documents: { select: SAFE_PORTAL_EXPORT_DOCUMENT_SELECT },
      },
    })
    if (!tenant) throw new BadRequestException('Hyresgäst hittades inte')

    return {
      exportedAt: new Date().toISOString(),
      gdprNotice:
        'Detta är en kopia av personuppgifter som vi behandlar om dig enligt GDPR Art. 15. Begäran om radering kan göras via DELETE /v1/portal/me.',
      tenant: {
        id: tenant.id,
        type: tenant.type,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        companyName: tenant.companyName,
        email: tenant.email,
        phone: tenant.phone,
        personalNumber: tenant.personalNumber,
        orgNumber: tenant.orgNumber,
        street: tenant.street,
        city: tenant.city,
        postalCode: tenant.postalCode,
        portalActivated: tenant.portalActivated,
        portalActivatedAt: tenant.portalActivatedAt,
        createdAt: tenant.createdAt,
      },
      organization: tenant.organization,
      leases: tenant.leases,
      invoices: tenant.invoices,
      rentNotices: tenant.rentNotices,
      maintenanceTickets: tenant.maintenanceTickets,
      documents: tenant.documents,
    }
  }

  /**
   * GDPR Art. 17: anonymisera hyresgästen och radera portal-konto.
   *
   * Vi raderar inte själva tenant-raden eftersom kvarvarande hyresavtal,
   * fakturor och journalposter är räkenskapsmaterial som måste sparas i 7 år
   * enligt Bokföringslagen 7 kap. 2 §. Istället maskerar vi
   * personuppgifterna (namn, e-post, telefon, personnummer) så ingen
   * återidentifiering är möjlig.
   */
  async deleteTenantAccount(tenantId: string) {
    await this.prisma.$transaction(async (tx) => {
      const masked = `gdpr-deleted-${tenantId.slice(0, 8)}`
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          firstName: null,
          lastName: null,
          companyName: 'Raderad hyresgäst',
          email: `${masked}@gdpr.invalid`,
          phone: null,
          personalNumber: null,
          orgNumber: null,
          street: null,
          city: null,
          postalCode: null,
          contactPerson: null,
          passwordHash: null,
          portalActivated: false,
          activationTokenHash: null,
          activationTokenExpiresAt: null,
          activationReminderSentAt: null,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      })
      // Radera alla aktiva sessioner
      await tx.tenantSession.deleteMany({ where: { tenantId } })
    })
  }
}
