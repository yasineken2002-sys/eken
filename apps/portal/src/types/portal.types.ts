export interface PortalTenant {
  id: string
  type: 'INDIVIDUAL' | 'COMPANY'
  firstName?: string
  lastName?: string
  companyName?: string
  email: string
  phone?: string
}

export interface PortalUnit {
  id: string
  name: string
  unitNumber: string
  area: number
  floor: number | null
  rooms: number | null
}

export interface PortalProperty {
  id: string
  name: string
  street: string
  city: string
  postalCode: string
}

export interface PortalLease {
  id: string
  status: 'DRAFT' | 'ACTIVE' | 'TERMINATED' | 'EXPIRED'
  startDate: string
  endDate: string | null
  monthlyRent: number
  depositAmount: number
  noticePeriodMonths: number
  unit: PortalUnit
  property: PortalProperty
}

export interface PortalDashboard {
  tenant: PortalTenant
  activeLease: PortalLease | null
  overdueInvoices: number
  upcomingInvoice: PortalInvoice | null
  openMaintenanceTickets: number
  unreadNotices: number
}

export interface PortalInvoice {
  id: string
  invoiceNumber: string
  type: string
  status: 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID'
  /** Fakturans nominella belopp, som den utfärdades. */
  total: number
  /** #342 — summan av registrerade betalningar. 0 när inget är betalt. */
  paid: number
  /** #342 — vad som återstår att betala. Samma tal som påminnelsebrevet visar. */
  outstanding: number
  dueDate: string
  issueDate: string
  paidAt: string | null
  propertyName: string
  unitName: string
}

export interface PortalRentNotice {
  id: string
  noticeNumber: string
  ocrNumber: string
  month: number
  year: number
  amount: number
  vatAmount: number
  // consumptionAmount = förbrukning (IMD); miscChargeAmount = övrig debitering
  // (skada/nyckel); totalAmount = hyran. Visa payableTotal, aldrig totalAmount.
  consumptionAmount: number
  miscChargeAmount: number
  totalAmount: number
  /**
   * #344 — vad hyresgästen ska betala NU: hyra + förbrukning + övrig debitering
   * + ev. påminnelseavgift, MINUS redan registrerade betalningar. Samma tal som
   * påminnelsebrevet och dess PDF visar. Bar tidigare bruttot.
   */
  payableTotal: number
  /**
   * #344 — avins NOMINELLA belopp (motsvarigheten till `invoice.total`). Aldrig
   * klampat. `payableTotal + paid` hade gett fel tal vid överbetalning.
   */
  nominalTotal: number
  /** #344 — redan registrerad betalning (Σ allokeringar). 0 när inget betalts. */
  paid: number
  dueDate: string
  paidAt: string | null
  status: 'PENDING' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'FAILED'
  sentAt: string | null
  propertyName: string
  unitName: string
}

export interface PortalMaintenanceComment {
  id: string
  content: string
  createdAt: string
  isInternal: boolean
}

export interface PortalMaintenanceTicket {
  id: string
  ticketNumber: string
  title: string
  description: string
  status: 'NEW' | 'IN_PROGRESS' | 'SCHEDULED' | 'COMPLETED' | 'CLOSED' | 'CANCELLED'
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  category: string
  createdAt: string
  scheduledDate: string | null
  property: { name: string }
  unit: { name: string } | null
  comments: PortalMaintenanceComment[]
}

export interface PortalNotice {
  id: string
  title: string
  body: string
  publishedAt: string
  expiresAt: string | null
  isRead: boolean
}

export interface PortalNews {
  id: string
  title: string
  body: string
  publishedAt: string
  imageUrl: string | null
  organizationName: string | null
  authorName: string | null
}

export interface PortalDocument {
  id: string
  name: string
  description: string | null
  mimeType: string
  fileSize: number
  category: string
  createdAt: string
}

// Hyresgästens egna förbrukningsposter (IMD). Speglar backendens hårt scopade,
// fält-begränsade svar — inga interna ekonomi-/infrafält (pris/marginal, moms-
// status, leverans, mätar-/lease-/unit-id). Belopp redan number (Decimal mappad).
export interface PortalConsumptionCharge {
  id: string
  meterType: 'ELECTRICITY' | 'WATER_COLD' | 'WATER_HOT' | 'HEATING'
  periodStart: string
  periodEnd: string
  quantity: number
  netAmount: number
  vatAmount: number
  totalAmount: number
}

// Hyresgästens egna övriga debiteringar (MiscCharge: skada/nyckel/ersättningskrav,
// teknisk förvaltning). Speglar backendens hårt scopade, fält-begränsade svar —
// inga interna fält (momsstatus/-sats, status, källa, scope-id, timestamps).
// Belopp redan number (Decimal mappad). description = hyresvärdens egen text.
export interface PortalMiscCharge {
  id: string
  description: string
  incidentDate: string
  netAmount: number
  vatAmount: number
  totalAmount: number
}

export interface PortalAuthResult {
  sessionToken: string
  tenant: PortalTenant
  expiresAt: string
}

// ── BankID (#745 PR 4) ───────────────────────────────────────────────────────

export interface PortalBankIdStart {
  orderRef: string
  /** Startar BankID-appen på samma enhet. Saknas hos vissa brokers. */
  autoStartToken?: string
  /** Innehållet i QR-koden för identifiering på annan enhet. */
  qrData?: string
}

/**
 * Ett hyresförhållande identifieringen matchade.
 *
 * `address` finns därför att orgnamnet ensamt sällan räcker: en hyresgäst känner
 * igen sin adress, inte alltid fastighetsbolagets juridiska namn. `null` när
 * hyresgästen saknar aktivt kontrakt.
 */
export interface PortalBankIdCandidate {
  tenantId: string
  organizationName: string
  address: string | null
}

export type PortalBankIdCollect =
  | { status: 'pending'; hintCode?: string }
  | { status: 'failed'; reason: string }
  | { status: 'complete'; sessionToken: string; expiresAt: string; tenant: PortalTenant }
  | { status: 'choose'; chooseToken: string; candidates: PortalBankIdCandidate[] }

export interface PortalActivationInfo {
  tenant: {
    id: string
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName: string | null
    lastName: string | null
    companyName: string | null
    email: string
  }
  organization: { id: string; name: string }
  lease: PortalActivationLease | null
}

export interface PortalActivationLease {
  id: string
  status: 'DRAFT' | 'ACTIVE' | 'TERMINATED' | 'EXPIRED'
  startDate: string
  endDate: string | null
  monthlyRent: number
  depositAmount: number
  noticePeriodMonths: number
  leaseType: 'FIXED_TERM' | 'INDEFINITE'
  unit: {
    id: string
    name: string
    unitNumber: string
    property: {
      name: string
      street: string
      city: string
      postalCode: string
    }
  }
}

// ── Besiktning och deposition ────────────────────────────────────────────────
//
// Formerna speglar `SAFE_PORTAL_INSPECTION_SELECT` och `getDeposits` i API:et.
// Fält som med flit INTE finns där finns inte heller här: ingen lagringsnyckel,
// ingen organisation, ingen besiktningsman, ingen innehållshash.

export type PortalInspectionCondition = 'GOOD' | 'ACCEPTABLE' | 'DAMAGED' | 'MISSING'
export type PortalInspectionType = 'MOVE_IN' | 'MOVE_OUT' | 'PERIODIC' | 'DAMAGE'

export interface PortalInspectionItem {
  id: string
  room: string
  item: string
  condition: PortalInspectionCondition
  notes: string | null
  repairCost: string | number | null
}

export interface PortalInspectionImage {
  id: string
  filename: string
  caption: string | null
  room: string | null
  size: number
  createdAt: string
}

/** En länk i rättelsehistoriken, så som hyresgästen får se den. */
export interface PortalInspectionVersion {
  id: string
  version: number
  arGallande: boolean
  correctionReason: string | null
  correctedAt: string | null
  signedAt: string | null
  completedAt: string | null
}

export interface PortalInspectionListItem {
  id: string
  type: PortalInspectionType
  status: string
  scheduledDate: string
  completedAt: string | null
  signedAt: string | null
  version: number
  antalVersioner: number
  harRattelser: boolean
  unit: { id: string; name: string; unitNumber: string; property: { name: string } }
}

export interface PortalInspection extends Omit<
  PortalInspectionListItem,
  'antalVersioner' | 'harRattelser'
> {
  overallCondition: string | null
  notes: string | null
  correctionReason: string | null
  correctedAt: string | null
  items: PortalInspectionItem[]
  images: PortalInspectionImage[]
  versioner: PortalInspectionVersion[]
  arGallande: boolean
}

/**
 * Fyra utfall, inte två. `VERIFIERAD` betyder att bilagans innehåll lästes
 * tillbaka och stämde; de tre andra är skilda sorters okunskap och får aldrig
 * ritas som ett godkännande.
 */
export type PortalBildkontrollUtfall = 'VERIFIERAD' | 'AVVIKANDE' | 'SAKNAS' | 'DIGEST_SAKNAS'

export interface PortalBildkontroll {
  inspectionId: string
  sammanfattning: PortalBildkontrollUtfall | 'INGA_BILDER'
  kontrolleradAt: string
  bilder: { imageId: string; filename: string; utfall: PortalBildkontrollUtfall }[]
}

export interface PortalDeposit {
  id: string
  belopp: number
  status: string
  lease: {
    id: string
    startDate: string
    endDate: string | null
    unit: { id: string; name: string; unitNumber: string; property: { name: string } }
  } | null
  /** Null = depositionen är inte registrerad som betald. */
  mottagenBetalning: { registreradAt: string } | null
  avdrag: { anledning: string; belopp: number }[]
  avdragSumma: number
  /** Hyresvärdens BESLUT om återbetalning. Inte detsamma som en utbetalning. */
  beslutadAterbetalning: { belopp: number; beslutadAt: string | null } | null
  /**
   * `kalla` är ALLTID null: det finns ingen källa i systemet som bekräftar att
   * pengarna lämnat hyresvärdens konto. Fältet finns just för att tystnaden ska
   * gå att visa i stället för att gissas.
   */
  genomfordUtbetalning: { kalla: null; kommentar: string }
}
