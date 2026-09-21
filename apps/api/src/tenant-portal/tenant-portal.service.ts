import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import type {
  MaintenanceCategory,
  MaintenancePriority,
  MaintenanceStatus,
  Prisma,
  Tenant,
} from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { MaintenanceService } from '../maintenance/maintenance.service'
import { NotificationsService } from '../notifications/notifications.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { rentNoticeOutstanding } from '../avisering/rent-debt.service'
import { computeInvoiceDebt } from '../invoices/invoice-debt'
import { readTenantWithCredentials } from './tenant-credential-read'
import { anonymizeTenantWithin } from '../common/gdpr/anonymize-tenant'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { StorageService } from '../storage/storage.service'
import { InspectionsService } from '../inspections/inspections.service'
import { InspectionImageIntegrityService } from '../inspections/inspection-image-integrity.service'

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

/**
 * ── BESIKTNINGSPROTOKOLLET, SÅ MYCKET SOM HYRESGÄSTEN FÅR SE ────────────────
 *
 * Allow-list, inte deny-list, av samma skäl som `SAFE_TICKET_SELECT`: ett nytt
 * fält på modellen hamnar utanför tills någon aktivt släpper in det.
 *
 * EXPLICIT EXKLUDERADE — LÄGG ALDRIG TILL:
 *  - `organizationId`, `propertyId`, `unitId`, `leaseId`, `tenantId` (interna
 *    nycklar; hyresgästen behöver ingen av dem för att läsa sitt protokoll)
 *  - `inspectedById`, `correctedById` (användar-id inom hyresvärdens org)
 *  - `actorKind` (internt spår om människa/agent)
 *  - `tenantSignature`, `landlordSignature`, `signedContentHash` (livscykel-
 *    och bevisfält som inte betyder något i portalen och som inbjuder till
 *    feltolkning — en hash är inte en underskrift)
 *  - `InspectionImage.storageKey` / `storageUrl` (intern R2-nyckel; bilden nås
 *    via en presignerad URL från en egen endpoint, precis som dokument)
 *
 * ── `notes` OCH `overallCondition` ÄR MED, OCH DET ÄR ETT VAL ──────────────
 *
 * Modellen har INGET fält för interna anteckningar på besiktningen — till
 * skillnad från `MaintenanceComment.isInternal`, som portalen filtrerar på.
 * Att ändå dölja `notes` hade varit att uppfinna en gräns datan inte bär, och
 * att dölja fel sak: anteckningen är själva motiveringen till en skadepost, och
 * det är den hyresgästen måste kunna läsa för att kunna invända mot ett
 * depositionsavdrag. Protokollets PDF — som hyresgästen redan får — innehåller
 * samma text.
 *
 * VAD SOM SKULLE ÄNDRA BESLUTET: att ett `isInternal`-fält införs på
 * besiktningen. Då är frågan vilka rader som är interna, inte om texten ska
 * visas. Det är en egen ändring och står som känd gräns i leveransen.
 */
export const SAFE_PORTAL_INSPECTION_SELECT = {
  id: true,
  type: true,
  status: true,
  scheduledDate: true,
  completedAt: true,
  signedAt: true,
  overallCondition: true,
  notes: true,
  version: true,
  correctionOfId: true,
  correctionReason: true,
  correctedAt: true,
  createdAt: true,
  items: {
    select: {
      id: true,
      room: true,
      item: true,
      condition: true,
      notes: true,
      repairCost: true,
    },
  },
  images: {
    select: {
      id: true,
      filename: true,
      caption: true,
      room: true,
      size: true,
      createdAt: true,
    },
  },
  unit: {
    select: {
      ...SAFE_PORTAL_UNIT_SELECT,
      property: { select: SAFE_PORTAL_PROPERTY_SELECT },
    },
  },
} as const satisfies Prisma.InspectionSelect

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

/**
 * ── #344: VYNS SELECT ÄR INTE EXPORTENS ──────────────────────────────────────
 *
 * Restskulden kräver `type`, `interestAccruedAmount` och `payments`. De fälten
 * fick INTE läggas i `SAFE_PORTAL_RENT_NOTICE_SELECT`, för den används RAW av
 * GDPR-exporten (`exportTenantData` returnerar `tenant.rentNotices` utan
 * mapper) — allt som selekteras där hamnar i exportfilen.
 *
 * Första försöket la dem i den delade selecten och läckte dem rakt in i
 * exporten. Läcktestet fångade det. Vyn har därför en EGEN select ovanpå den
 * säkra; exportens är orörd.
 */
export const PORTAL_RENT_NOTICE_VIEW_SELECT = {
  ...SAFE_PORTAL_RENT_NOTICE_SELECT,
  type: true,
  interestAccruedAmount: true,
  payments: { select: { amount: true } },
  // #518 — samma skäl som `payments`: utan krediteringarna visar portalen
  // bruttot för en avi som satts ned, alltså ett krav hyresgästen inte har.
  // Ligger i VYNS select och inte i den delade — exporten är orörd (#344).
  credits: { select: { amount: true } },
} as const satisfies Prisma.RentNoticeSelect

type PortalRentNoticeRow = Prisma.RentNoticeGetPayload<{
  select: typeof PORTAL_RENT_NOTICE_VIEW_SELECT
}>

/**
 * Explicit mapper (lager 2) → exakt portal-kontraktet (PortalRentNotice). Bygger
 * DTO:n fält för fält så interna fält aldrig kan följa med, även om selecten
 * skulle driva.
 */
export function mapRentNotice(notice: PortalRentNoticeRow) {
  const { payable, nominalTotal, paid, credited } = rentNoticeOutstanding(notice)
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
    // ── #344: RESTSKULDEN, INTE BRUTTOT ────────────────────────────────────
    //
    // `payableTotal` bar avins bruttobelopp. Efter den här ändringen bär den
    // samma tal som påminnelsebrevet och dess PDF — vilket var hela poängen:
    // en hyresgäst som betalat 4 000 av 9 000 ska se 5 000 överallt.
    //
    // NAMNET BEHÅLLS. `payableTotal` betyder "vad hyresgästen ska betala", och
    // det är precis vad det är nu — till skillnad från fakturasidans
    // `originalTotal`, som blev falskt när innebörden ändrades. Kontraktet mot
    // portalen är oförändrat; bara talet är sant nu.
    payableTotal: payable,
    // Avins NOMINELLA OCR-belopp — motsvarigheten till `invoice.total` på
    // fakturasidan. Portalens "Kvar av X" behöver ett tal som ALDRIG är klampat:
    // räknade gränssnittet i stället ut `payableTotal + paid` blev X lika med
    // det inbetalda beloppet vid en överbetalning, dvs. en avi på 8 810 påstods
    // ha varit på 10 000. Samma felklass som #342:s must-fix, i motsatt riktning.
    nominalTotal,
    // `paid` LÄSES UR ALLOKERINGARNA, aldrig som brutto − restskuld: den
    // härledningen gömmer en överbetalning (#342:s must-fix).
    paid,
    // #518 — nedsatt belopp, som EGET fält bredvid `paid`. Utan det sjunker
    // `payableTotal` under `nominalTotal` utan att hyresgästen kan se varför:
    // "Kvar av X" hade inte gått ihop, och en oförklarad differens i ett
    // betalningsunderlag är precis vad som genererar ett supportärende. Samma
    // skäl som gör `credited` till en egen avdragsrad i påminnelsebrevet.
    credited,
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

/**
 * Safe Prisma SELECT för Invoice mot hyresgästportalen (defense-in-depth).
 *
 * Lager 1 (allow-list) som komplement till mapInvoice (lager 2, fanns redan).
 * `include: { lease: { include: { unit: { include: { property: true } } } } }`
 * drog tidigare hela property-raden (fireSafetyNotes/monthlyRent/organizationId)
 * till minnet trots att mapInvoice strippade svaret. `lines` hämtades men användes
 * aldrig av mapInvoice — droppas här. property/unit återbrukar 5a:s SAFE_PORTAL_*.
 *
 * Innehåller exakt de Invoice-skalärer + lease.unit.name/property.name som
 * mapInvoice läser → output förblir BYTE-IDENTISK.
 */
export const SAFE_PORTAL_INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  type: true,
  status: true,
  total: true,
  // ── #342: RESTSKULDEN GÅR INTE ATT RÄKNA UTAN ALLOKERINGARNA ─────────────
  //
  // Efter #329 bär påminnelsebreven restskulden. Portalen visade fortfarande
  // fakturans nominella total — så en hyresgäst som betalat 8 000 av 10 000 såg
  // 2 000 i brevet och 10 000 i portalen. Samma person, samma skuld, två tal.
  //
  // BARA `amount` LÄSES. Allokeringens id, datum, källa och bank-koppling är
  // internt och har inget i ett hyresgäst-svar att göra (samma disciplin som
  // portal-läcktätningen #156–#160). `mapInvoice` bygger dessutom DTO:n fält
  // för fält, så raden kan inte följa med ut även om selecten skulle drifta.
  payments: { select: { amount: true } },
  creditNotes: { select: { total: true } },
  dueDate: true,
  issueDate: true,
  paidAt: true,
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
} as const satisfies Prisma.InvoiceSelect

type PortalInvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof SAFE_PORTAL_INVOICE_SELECT }>

/**
 * Safe Prisma SELECT för Invoice i GDPR Art. 15-exporten (GET /portal/me/export).
 *
 * Egen från SAFE_PORTAL_INVOICE_SELECT (som är minimal för portalens listvy):
 * exporten får legitimt MER av hyresgästens egen fakturadata — subtotal/vatTotal,
 * reference/ocrNumber/notes samt lines (de egna debiterade raderna, kärnan i Art. 15).
 * Ersätter `invoices: { include: { lines: true } }` som drog HELA Invoice-raden rått
 * (inkl. trackingToken/collectionExportKey/kravtrappa-fält) och returnerade den
 * oförändrad. Allow-list (lager 1) — framtida interna Invoice-fält kan inte auto-läcka.
 *
 * EXPLICIT EXKLUDERADE — LÄGG ALDRIG TILL (interna/infra/kravtrappa/relationer):
 *  - organizationId, tenantId, customerId, leaseId (scope-interna FK:er)
 *  - trackingToken (bearer-liknande; @Public POST /track/view/:token accepterar den)
 *  - collectionExportKey (rå R2-nyckel, delad zipKey över hela inkasso-batchen →
 *    cross-tenant PII om nyckeln någonsin blir hämtningsbar)
 *  - sendError (e-post-infra-fel)
 *  - remindersPaused(At/Reason), sentToCollectionAt (kravtrappa — hyresvärdens interna)
 *  - createdAt, updatedAt (interna record-timestamps)
 *  - events, bankTransactions, deposit, paymentReminders, consumptionCharges (relationer,
 *    drar in interna objekt — hör inte hemma i hyresgästens fakturakopia)
 *  - lines.invoiceId (redundant FK; raden själv är Art. 15-data, FK:n är intern)
 */
export const SAFE_PORTAL_EXPORT_INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  type: true,
  status: true,
  subtotal: true,
  vatTotal: true,
  total: true,
  dueDate: true,
  issueDate: true,
  paidAt: true,
  reference: true,
  ocrNumber: true,
  notes: true,
  lines: {
    select: {
      id: true,
      description: true,
      quantity: true,
      unitPrice: true,
      vatRate: true,
      total: true,
    },
  },
} as const satisfies Prisma.InvoiceSelect

type PortalExportInvoiceRow = Prisma.InvoiceGetPayload<{
  select: typeof SAFE_PORTAL_EXPORT_INVOICE_SELECT
}>

/**
 * Explicit mapper (lager 2) för fakturor i GDPR-exporten. invoices är den enda
 * export-grenen som annars låg närmast bearer-liknande trackingToken +
 * cross-tenant collectionExportKey, så den får dubbelt skydd (select + mapper)
 * även om övriga export-syskon (leases/rentNotices/tickets/documents) bara har
 * select. Bygger DTO:n fält-för-fält; Decimal→number, datum→ISO.
 */
export function mapExportInvoice(inv: PortalExportInvoiceRow) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    type: inv.type,
    status: inv.status,
    subtotal: Number(inv.subtotal),
    vatTotal: Number(inv.vatTotal),
    total: Number(inv.total),
    dueDate: inv.dueDate.toISOString(),
    issueDate: inv.issueDate.toISOString(),
    paidAt: inv.paidAt?.toISOString() ?? null,
    reference: inv.reference,
    ocrNumber: inv.ocrNumber,
    notes: inv.notes,
    lines: inv.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      vatRate: line.vatRate,
      total: Number(line.total),
    })),
  }
}

/**
 * Explicit mapper (lager 2) för GET /portal/me. Lager 1 finns redan:
 * `request.tenant` kommer från validateSession som använder SAFE_PORTAL_TENANT_SELECT
 * (inga credentials/token-hashar). Denna mapper bygger hyresgästens egen profil
 * fält-för-fält så interna/redundanta fält inte når svaret.
 *
 * VISA (hyresgästens EGNA uppgifter om sig själv):
 *   id, type, firstName, lastName, companyName, email, phone, personalNumber,
 *   orgNumber, contactPerson, street, city, postalCode, country, portalActivated,
 *   portalActivatedAt, ocrNumber (eget betalnings-OCR), organization.name (hyresvärden).
 *
 * DÖLJ:
 *   organizationId (rå intern scope-nyckel), organization.id (intern nyckel — bara
 *   namnet har värde för hyresgästen), activationReminderSentAt (intern ops-flagga),
 *   createdAt, updatedAt (interna record-timestamps).
 *   credentials (passwordHash/*TokenHash/*TokenExpiresAt) finns inte ens — lager 1.
 */
export function mapMe(
  tenant: Tenant & { organization: { id: string; name: string } },
  personalNumber: string | null,
) {
  return {
    id: tenant.id,
    type: tenant.type,
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    companyName: tenant.companyName,
    email: tenant.email,
    phone: tenant.phone,
    personalNumber,
    orgNumber: tenant.orgNumber,
    contactPerson: tenant.contactPerson,
    street: tenant.street,
    city: tenant.city,
    postalCode: tenant.postalCode,
    country: tenant.country,
    portalActivated: tenant.portalActivated,
    portalActivatedAt: tenant.portalActivatedAt?.toISOString() ?? null,
    ocrNumber: tenant.ocrNumber,
    organization: { name: tenant.organization.name },
  }
}

@Injectable()
export class TenantPortalService {
  private readonly logger = new Logger(TenantPortalService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pn: PersonalNumberService,
    private readonly maintenanceService: MaintenanceService,
    private readonly notificationsService: NotificationsService,
    private readonly inspections: InspectionsService,
    private readonly bildkontroll: InspectionImageIntegrityService,
    private readonly storage: StorageService,
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
        // SECURITY (defense-in-depth): samma allow-list-select som getInvoices —
        // matar samma mapInvoice, stänger samma in-memory property-läsning.
        select: SAFE_PORTAL_INVOICE_SELECT,
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
      where: {
        tenantId,
        // SECURITY / T1.4 (hyresjurist): visa BARA avier hyresvärden faktiskt
        // skickat/markerat — aldrig PENDING/CANCELLED. Samma filter som
        // getRentNotices. Kritiskt för bakdaterad debitering (#44): en
        // efterdebiterad avi vilar i PENDING tills en människa aktivt släpper
        // in den; utan detta filter skulle den synas för hyresgästen direkt vid
        // skapandet, förbi det bindande kommunikationsbeslutet.
        status: { in: ['SENT', 'PAID', 'OVERDUE'] },
      },
      select: PORTAL_RENT_NOTICE_VIEW_SELECT,
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
      // SECURITY (defense-in-depth): allow-list-select (lager 1) i stället för
      // `include: { property: true }` som drog property-interna fält till minnet.
      // `lines` användes aldrig av mapInvoice — droppas. Output byte-identisk.
      select: SAFE_PORTAL_INVOICE_SELECT,
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
      select: PORTAL_RENT_NOTICE_VIEW_SELECT,
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

    // MaintenanceService äger skapandenotisen även för den manuella vägen.
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

  private mapInvoice(inv: PortalInvoiceRow) {
    const debt = computeInvoiceDebt({
      total: inv.total,
      allocations: inv.payments.map((p) => p.amount),
      // #517 — hyresgästen ser sin egen skuld här. En krediterad faktura som
      // fortsatte visa fullt belopp vore ett krav mot fel person.
      credits: inv.creditNotes.map((c) => c.total),
    })
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      type: inv.type,
      status: inv.status,
      // NOMINELL TOTAL — fakturans belopp som det utfärdades. FAR: korrekt på
      // ett fakturadokument och ska INTE ersättas här.
      total: Number(inv.total),
      // #342 — vad som faktiskt återstår, ur `invoiceOutstanding` (delad sedan
      // #329). Ingen fjärde beräkning: breven, vyerna, inkassoexporten och
      // portalen läser nu samma uttryck.
      //
      // `paid` följer med som DISKRIMINATOR: gränssnittet visar det andra talet
      // bara när något faktiskt är betalt. Utan delbetalningar är `outstanding`
      // identisk med `total`, och två likadana siffror förklarar ingenting —
      // de förvirrar.
      // BÅDA UR SAMMA BERÄKNING. Först stod `paid: total − outstanding` — men
      // `outstanding` är KLAMPAT vid 0, så en överbetalning på 12 000 mot en
      // faktura på 10 000 rapporterades som "10 000 betalt". De extra 2 000
      // försvann tyst ur det hyresgästen ser, trots att allokeringen finns.
      // Samma klass av tyst fel siffra som #342 finns för att stänga — i den
      // kod som skulle stänga den. (Fångat av BÅDA granskarna.)
      paid: debt.paid.toNumber(),
      outstanding: debt.outstanding.toNumber(),
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
    // Credential-bärande med avsikt: exporten dekrypterar hyresgästens EGET
    // personnummer (Art. 15) ur personalNumberEnc. Går därför genom den enda
    // tillåtna vägen — svaret byggs sedan fält för fält nedan, inte genom att
    // raden serialiseras.
    const tenant = await readTenantWithCredentials(this.prisma, {
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
        // SECURITY (defense-in-depth, sista hålet av klassen): `include: { lines: true }`
        // drog HELA Invoice-raden rått till minnet — trackingToken (bearer-liknande),
        // collectionExportKey (delad R2-nyckel → cross-tenant PII), sendError,
        // kravtrappa-fält och organizationId — och returnerades oförändrad nedan.
        // Allow-list-select + mapExportInvoice (lager 2), samma mönster som syskonen.
        invoices: { select: SAFE_PORTAL_EXPORT_INVOICE_SELECT },
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
        personalNumber: this.pn.reveal(tenant.personalNumberEnc),
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
      invoices: tenant.invoices.map(mapExportInvoice),
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
  /**
   * Hyresgästens EGEN radering via portalen (GDPR Art. 17).
   *
   * Skrubben ligger i `anonymizeTenantWithin`, delad med operatörsvägen
   * (`TenantsService.anonymize`). Fältlistan låg tidigare inline här; två kopior
   * divergerar första gången någon lägger till en kolumn, och den divergensen
   * syns inte i något test som bara kör en av vägarna.
   *
   * `performedById: null` betyder i loggen att hyresgästen verkställde själv —
   * det finns ingen `User` att peka på här.
   */
  async deleteTenantAccount(tenantId: string, meta?: { ipAddress?: string; userAgent?: string }) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { organizationId: true },
    })
    return this.prisma.$transaction(
      async (tx) =>
        anonymizeTenantWithin(tx, tenantId, tenant.organizationId, {
          performedById: null,
          ...(meta?.ipAddress ? { ipAddress: meta.ipAddress } : {}),
          ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
        }),
      PRISMA_DEFAULT_TX_LIMITS,
    )
  }

  // ══ BESIKTNING OCH DEPOSITION ═════════════════════════════════════════════

  /**
   * VILKA PROTOKOLL SOM ÄR HYRESGÄSTENS — OCH VARFÖR `unitId` INTE STÅR HÄR.
   *
   * Bostaden är den enda kopplingen som ÖVERLEVER hyresförhållandet. Matchade
   * vi på `unitId` hade nästa hyresgäst i samma lägenhet fått läsa den förras
   * utflyttningsbesiktning — med skador, belopp och anteckningar om en annan
   * människa. Det är ett läckage som ser ut som en rimlig join.
   *
   * Villkoret är därför HYRESFÖRHÅLLANDET: protokollet pekar antingen direkt på
   * hyresgästen (`tenantId`) eller på ett avtal hyresgästen har eller har haft
   * (`leaseId`). Båda är bundna till personen, inte till väggarna.
   *
   * Organisationen står med som ett eget villkor och inte bara implicit via
   * avtalet: en `tenantId` räcker inte som org-bevis i en fråga som också har
   * ett `OR`, och en grind som vilar på att den andra grenen råkar vara scopad
   * är ingen grind.
   */
  private async besiktningsVillkor(tenantId: string): Promise<Prisma.InspectionWhereInput> {
    const hyresgast = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, organizationId: true },
    })
    if (!hyresgast) throw new NotFoundException('Hyresgästen hittades inte')

    const avtal = await this.prisma.lease.findMany({
      where: { tenantId, organizationId: hyresgast.organizationId },
      select: { id: true },
    })
    const avtalsIdn = avtal.map((a) => a.id)

    return {
      organizationId: hyresgast.organizationId,
      OR: [{ tenantId }, ...(avtalsIdn.length > 0 ? [{ leaseId: { in: avtalsIdn } }] : [])],
      // ── BARA SLUTFÖRDA PROTOKOLL ──────────────────────────────────────
      //
      // Ett utkast — inklusive en pågående rättelse — är inte tillgängliggjort.
      // Att visa det hade betytt att hyresgästen läser halvfärdiga
      // skadebedömningar och belopp som ännu kan ändras fritt av hyresvärden,
      // och som inte gäller.
      //
      // Villkoret är SAMMA tre som `arSlutford` (inspection-versions.ts) prövar,
      // och av samma skäl: `status` och `signedAt` kan gå isär i rader som
      // skrevs innan F025:s spärr fanns. Det står som SQL här och inte som ett
      // anrop därför att filtreringen måste ske i databasen — ett filter i
      // minnet hade krävt att alla rader först hämtas, och en `findFirst` på
      // ett enskilt id hade inte filtrerat alls.
      //
      // Bindningen mellan de två är provet "ett PÅGÅENDE protokoll är inte
      // tillgängliggjort" i `tenant-portal.inspection-deposit.db.spec.ts`.
      AND: [{ OR: [{ status: 'COMPLETED' }, { status: 'SIGNED' }, { NOT: { signedAt: null } }] }],
    }
  }

  /**
   * Hyresgästens protokoll — EN rad per kedja, den version som gäller.
   *
   * Kedjorna grupperas i minnet ur den redan hämtade mängden, inte med en
   * fråga per rad. Det fungerar därför att alla SLUTFÖRDA versioner av en kedja
   * tillhör samma hyresförhållande och alltså ligger i samma svar; ett utkast
   * saknas ur mängden, vilket är rätt — ett utkast gäller aldrig.
   */
  async getInspections(tenantId: string) {
    const rader = await this.prisma.inspection.findMany({
      where: await this.besiktningsVillkor(tenantId),
      select: SAFE_PORTAL_INSPECTION_SELECT,
      orderBy: { scheduledDate: 'desc' },
    })

    const idn = new Set(rader.map((r) => r.id))
    const efterfoljare = new Map<string, (typeof rader)[number]>()
    for (const rad of rader) {
      if (rad.correctionOfId) efterfoljare.set(rad.correctionOfId, rad)
    }

    // Kedjans rot i den här mängden: raden vars föregångare inte finns med.
    const rotter = rader.filter((r) => !r.correctionOfId || !idn.has(r.correctionOfId))

    return rotter.map((rot) => {
      const kedja = [rot]
      let nuvarande = rot
      const sedda = new Set([rot.id])
      for (;;) {
        const nasta = efterfoljare.get(nuvarande.id)
        if (!nasta || sedda.has(nasta.id)) break
        sedda.add(nasta.id)
        kedja.push(nasta)
        nuvarande = nasta
      }
      const gallande = kedja[kedja.length - 1]!
      return {
        ...gallande,
        antalVersioner: kedja.length,
        harRattelser: kedja.length > 1,
      }
    })
  }

  /**
   * Ett protokoll med dess rättelsehistorik.
   *
   * Historiken byggs av `InspectionsService.hamtaVersioner` — SAMMA härledning
   * som hyresvärdens vy använder. Två uträkningar av "vilken version gäller"
   * hade varit två tillfällen att ge hyresvärden och hyresgästen olika svar på
   * exakt den fråga som avgör vilket underlag ett depositionsavdrag vilar på.
   *
   * Utkast filtreras bort EFTER härledningen, inte före: ett utkast ska inte
   * synas, men det ska inte heller kunna flytta vilken version som gäller.
   */
  async getInspection(tenantId: string, inspectionId: string) {
    const villkor = await this.besiktningsVillkor(tenantId)
    const besiktning = await this.prisma.inspection.findFirst({
      where: { AND: [{ id: inspectionId }, villkor] },
      select: { ...SAFE_PORTAL_INSPECTION_SELECT, organizationId: true },
    })
    if (!besiktning) throw new NotFoundException('Besiktningsprotokollet hittades inte')

    const { organizationId, ...synligt } = besiktning
    const kedja = await this.inspections.hamtaVersioner(inspectionId, organizationId)

    return {
      ...synligt,
      versioner: kedja
        .filter((v) => !v.arUtkast)
        .map((v) => ({
          id: v.id,
          version: v.version,
          arGallande: v.arGallande,
          correctionReason: v.correctionReason,
          correctedAt: v.correctedAt,
          signedAt: v.signedAt,
          completedAt: v.completedAt,
        })),
      arGallande: kedja.find((v) => v.id === inspectionId)?.arGallande ?? false,
    }
  }

  /**
   * Behörighetskontrollen som de tre direktlänkarna (PDF, bild, bildkontroll)
   * delar.
   *
   * EN funktion och inte tre kopior: tre egna `findFirst` med var sitt `where`
   * är tre tillfällen att glömma ett villkor, och den som glöms syns inte —
   * endpointen svarar precis som förut, bara för fler.
   */
  private async hamtaAgdBesiktning(tenantId: string, inspectionId: string) {
    const villkor = await this.besiktningsVillkor(tenantId)
    const besiktning = await this.prisma.inspection.findFirst({
      where: { AND: [{ id: inspectionId }, villkor] },
      select: { id: true, organizationId: true },
    })
    if (!besiktning) throw new NotFoundException('Besiktningsprotokollet hittades inte')
    return besiktning
  }

  /** Protokollets PDF. Samma rendering som hyresvärdens, samma innehåll. */
  async getInspectionPdf(tenantId: string, inspectionId: string): Promise<Buffer> {
    const besiktning = await this.hamtaAgdBesiktning(tenantId, inspectionId)
    return this.inspections.generateProtocolPdf(besiktning.id, besiktning.organizationId)
  }

  /**
   * En presignerad URL till EN bilaga.
   *
   * `storageKey` lämnar aldrig servern — samma mönster som dokumentvägen.
   * Bilden måste tillhöra det protokoll som anges i URL:en OCH det protokollet
   * måste vara hyresgästens; att bara kontrollera bild-id hade varit samma
   * IDOR som `updateItem` en gång hade.
   */
  async getInspectionImageUrl(tenantId: string, inspectionId: string, imageId: string) {
    const besiktning = await this.hamtaAgdBesiktning(tenantId, inspectionId)
    const bild = await this.prisma.inspectionImage.findFirst({
      where: { id: imageId, inspectionId: besiktning.id },
      select: { id: true, filename: true, storageKey: true },
    })
    if (!bild) throw new NotFoundException('Bilagan hittades inte')
    return { url: await this.storageUrl(bild.storageKey), filename: bild.filename }
  }

  /**
   * FAKTISK kontroll av bilagornas innehåll, på hyresgästens begäran.
   *
   * Samma tjänst som hyresvärdens vy använder. Hyresgästen får alltså exakt
   * samma fyra utfall — inte en förenklad "OK/inte OK", som hade gjort ett
   * `DIGEST_SAKNAS` till ett godkännande eller ett underkännande. Digesterna
   * själva följer inte med: de säger hyresgästen ingenting och är interna spår.
   */
  async getInspectionImageCheck(tenantId: string, inspectionId: string) {
    const besiktning = await this.hamtaAgdBesiktning(tenantId, inspectionId)
    const bilder = await this.prisma.inspectionImage.findMany({
      where: { inspectionId: besiktning.id },
      select: { id: true, filename: true, storageKey: true, contentSha256: true },
    })
    const utfall = await this.bildkontroll.kontrolleraBilder(bilder)
    return {
      inspectionId: besiktning.id,
      sammanfattning: this.bildkontroll.sammanfatta(utfall),
      kontrolleradAt: new Date(),
      bilder: utfall.map((u) => ({
        imageId: u.imageId,
        filename: u.filename,
        utfall: u.utfall,
      })),
    }
  }

  /**
   * DEPOSITIONEN — UR VERKLIGA KÄLLOR, OCH MED TYSTNADEN UTSKRIVEN.
   *
   * Varje tal nedan läses ur `Deposit`. Ingen omräkning sker här: avdragen är
   * bokförda tillsammans med ett verifikat (`createJournalEntryForDepositRefund`),
   * och en portal som räknade om dem hade byggt ett andra ekonomisystem vars
   * enda uppgift vore att förr eller senare säga något annat än bokföringen.
   *
   * ── TRE SKILDA UPPGIFTER SOM INTE FÅR SLÅS IHOP ───────────────────────────
   *
   *   `mottagenBetalning`   — `paidAt`. Hyresvärden har registrerat att
   *                           depositionen kommit in.
   *   `beslutadAterbetalning` — `refundAmount` + `refundedAt`. Hyresvärden har
   *                           BESLUTAT och bokfört återbetalningen.
   *   `genomfordUtbetalning` — ALLTID okänd. Se nedan.
   *
   * ── VARFÖR DEN TREDJE ALLTID ÄR OKÄND ─────────────────────────────────────
   *
   * Mätt i kodbasen: det finns ingen källa som bekräftar att pengarna lämnat
   * hyresvärdens konto. `refundedAt` sätts i samma transaktion som beslutet och
   * verifikatet — den beskriver alltså beslutet, inte banken. Att visa den som
   * "utbetald" hade varit att låta hyresgästen tro att en betalning är
   * bekräftad av en part som aldrig tillfrågats.
   *
   * Fältet returneras därför med `kalla: null` i stället för att utelämnas.
   * Ett utelämnat fält läses som "inte tillämpligt"; ett `null` med en
   * förklaring läses som "vi vet inte", vilket är sanningen.
   */
  async getDeposits(tenantId: string) {
    const hyresgast = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { organizationId: true },
    })
    if (!hyresgast) throw new NotFoundException('Hyresgästen hittades inte')

    const depositioner = await this.prisma.deposit.findMany({
      where: { tenantId, organizationId: hyresgast.organizationId },
      select: {
        id: true,
        amount: true,
        status: true,
        paidAt: true,
        refundAmount: true,
        refundedAt: true,
        deductions: true,
        createdAt: true,
        lease: {
          select: {
            id: true,
            startDate: true,
            endDate: true,
            unit: {
              select: {
                ...SAFE_PORTAL_UNIT_SELECT,
                property: { select: SAFE_PORTAL_PROPERTY_SELECT },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return depositioner.map((d) => {
      const avdrag = Array.isArray(d.deductions)
        ? (d.deductions as { reason?: unknown; amount?: unknown }[])
            .filter((rad) => rad && typeof rad === 'object')
            .map((rad) => ({
              anledning: typeof rad.reason === 'string' ? rad.reason : 'Ej angiven',
              belopp: Number(rad.amount ?? 0),
            }))
        : []

      return {
        id: d.id,
        belopp: Number(d.amount),
        status: d.status,
        lease: d.lease,

        mottagenBetalning: d.paidAt
          ? { registreradAt: d.paidAt }
          : // Null och inte `{ registreradAt: null }`: depositionen är
            // fakturerad men inte registrerad som betald, och det är en annan
            // uppgift än ett saknat datum på en betald deposition.
            null,

        avdrag,
        avdragSumma: avdrag.reduce((summa, rad) => summa + rad.belopp, 0),

        beslutadAterbetalning:
          d.refundAmount !== null
            ? { belopp: Number(d.refundAmount), beslutadAt: d.refundedAt }
            : null,

        genomfordUtbetalning: {
          kalla: null,
          kommentar:
            'Eveno har ingen källa som bekräftar att pengarna lämnat hyresvärdens konto. ' +
            'Uppgiften ovan är hyresvärdens beslut och bokföring, inte en bankbekräftelse.',
        },
      }
    })
  }

  /** Presignerad URL. Bryts ut så att bildvägen inte känner till lagringen. */
  private async storageUrl(key: string): Promise<string> {
    return this.storage.getPresignedUrl(key, 300)
  }
}
