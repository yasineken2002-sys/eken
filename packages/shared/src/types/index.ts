// ─── Pagination ──────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface PaginatedResponse<T> {
  data: T[]
  meta: PaginationMeta
}

// ─── API Response envelope ────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: true
  data: T
}

export interface ApiError {
  success: false
  error: {
    code: string
    message: string
    details?: Record<string, string[]>
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string
  email: string
  organizationId: string
  role: UserRole
  // Sätts true när användaren skapats via invite/customer-create. Frontend
  // tvingar redirect till /change-password tills detta blir false.
  mustChangePassword?: boolean
  iat?: number
  exp?: number
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

// ─── Users & Auth ─────────────────────────────────────────────────────────────

export type UserRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER'

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  role: UserRole
  organizationId: string
  avatarUrl?: string
  isActive?: boolean
  mustChangePassword?: boolean
  lastLoginAt?: string | null
  createdAt: string
  updatedAt: string
}

// ─── Organization (multi-tenant) ──────────────────────────────────────────────

// Måste hållas synkad med Prismas CompanyForm-enum (samma strängvärden).
export type CompanyForm = 'AB' | 'ENSKILD_FIRMA' | 'HB' | 'KB' | 'FORENING' | 'STIFTELSE'

export interface Organization {
  id: string
  name: string
  // Kort, plattformsglobalt och permanent kundnummer (K-100001 …). Stabil
  // läsbar identifierare att söka/slå upp på, till skillnad från det interna
  // id:t. Optionellt på typen tills backfill gjort fältet NOT NULL i DB.
  customerNumber?: string
  orgNumber: string // Swedish org nr (556xxx-xxxx) eller personnr för EF
  // Juridisk företagsform — sätts vid registrering, kan inte ändras av
  // användaren själv (kräver supportkontakt eftersom kontoplanen och
  // kontraktstexterna beror på den).
  companyForm: CompanyForm
  vatNumber?: string
  // F-skatt: skrivs ut som "Godkänd för F-skatt" på faktura-PDF
  // (lagkrav 11 kap. 8 § ML). Kan ändras i Inställningar när Skatteverket
  // godkänner ansökan.
  hasFSkatt?: boolean
  fSkattApprovedDate?: string | null
  email: string
  phone?: string
  address: Address
  logoStorageKey?: string
  logoStorageUrl?: string
  bankgiro?: string
  paymentTermsDays?: number
  invoiceColor?: string
  invoiceTemplate?: string
  // PDF-/dokumentvarumärke (Steg 3, PR 1). Läses inte av någon renderare ännu.
  // brandFont speglar Prisma-enumet BrandFont (se BRAND_FONTS i constants).
  brandFont?: string
  brandSecondaryColor?: string | null
  morningReportEnabled?: boolean
  remindersEnabled?: boolean
  reminderFeeSek?: number
  reminderFormalDay?: number
  reminderCollectionDay?: number
  collectionAgencyName?: string
  createdAt: string
  updatedAt: string
}

// ─── Address ─────────────────────────────────────────────────────────────────

export interface Address {
  street: string
  city: string
  postalCode: string
  country: string
}

// ─── Properties (Fastigheter) ─────────────────────────────────────────────────

export type PropertyType = 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED' | 'INDUSTRIAL' | 'LAND'

export interface Property {
  id: string
  organizationId: string
  name: string
  propertyDesignation: string // Fastighetsbeteckning
  type: PropertyType
  address: Address
  totalArea: number // m²
  yearBuilt?: number
  units: Unit[]
  createdAt: string
  updatedAt: string
}

// ─── Units (Lägenheter/Lokaler) ───────────────────────────────────────────────

export type UnitType = 'APARTMENT' | 'OFFICE' | 'RETAIL' | 'STORAGE' | 'PARKING' | 'OTHER'
export type UnitStatus = 'VACANT' | 'OCCUPIED' | 'UNDER_RENOVATION' | 'RESERVED'

export interface Unit {
  id: string
  propertyId: string
  name: string
  unitNumber: string
  type: UnitType
  status: UnitStatus
  area: number // m²
  floor?: number
  rooms?: number
  monthlyRent: number // SEK
  createdAt: string
  updatedAt: string
}

// ─── Tenants (Hyresgäster) ────────────────────────────────────────────────────

export type TenantType = 'INDIVIDUAL' | 'COMPANY'

export interface Tenant {
  id: string
  organizationId: string
  type: TenantType
  // Individual
  firstName?: string
  lastName?: string
  personalNumber?: string // Personnummer
  // Company
  companyName?: string
  orgNumber?: string
  contactPerson?: string
  // Common
  email: string
  phone?: string
  address?: Address
  // Portal-aktivering — sätts när hyresgästen aktiverat sitt konto via
  // välkomstmejlets aktiveringslänk och valt eget lösenord.
  portalActivated?: boolean
  portalActivatedAt?: string | null
  createdAt: string
  updatedAt: string
}

// ─── Leases (Hyresavtal) ──────────────────────────────────────────────────────

export type LeaseStatus = 'DRAFT' | 'ACTIVE' | 'TERMINATED' | 'EXPIRED'
export type LeaseType = 'FIXED_TERM' | 'INDEFINITE'

export interface Lease {
  id: string
  organizationId: string
  unitId: string
  tenantId: string
  status: LeaseStatus
  leaseType: LeaseType
  renewalPeriodMonths?: number
  startDate: string
  endDate?: string // null = open-ended (gäller INDEFINITE-kontrakt)
  monthlyRent: number
  depositAmount: number
  noticePeriodMonths: number
  indexClause: boolean
  signedAt?: string
  terminatedAt?: string
  terminationReason?: string
  // Kontraktsmall 2.0: fortlöpande nummer (KONT-2026-00042) som tilldelas
  // vid DRAFT → ACTIVE. Null så länge kontraktet är i DRAFT.
  contractNumber?: string | null
  // Kontraktsmall 2.0: fritext som hyresvärden lägger till som "övriga
  // villkor & särskilda bestämmelser" i kontraktet.
  specialTerms?: string | null
  createdAt: string
  updatedAt: string
}

// ─── Invoices (Fakturor) ──────────────────────────────────────────────────────

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'PARTIAL'
  | 'PAID'
  | 'OVERDUE'
  | 'VOID'
  | 'SENT_TO_COLLECTION'
export type InvoiceType = 'RENT' | 'DEPOSIT' | 'SERVICE' | 'UTILITY' | 'OTHER'

export interface InvoiceLine {
  id: string
  description: string
  quantity: number
  unitPrice: number
  vatRate: number // 0, 6, 12, or 25
  total: number
}

export interface Invoice {
  id: string
  organizationId: string
  invoiceNumber: string
  type: InvoiceType
  status: InvoiceStatus
  // tenantId/customerId är XOR i Prisma — hyresavtalsbaserade fakturor har
  // tenantId, externa kundfakturor har customerId. Båda är nullable här.
  tenantId?: string
  customerId?: string
  leaseId?: string
  lines: InvoiceLine[]
  subtotal: number
  vatTotal: number
  total: number
  dueDate: string
  issueDate: string
  paidAt?: string
  ocrNumber?: string // Auto-genererat Luhn-validerat OCR
  reference?: string // OCR/Referensnummer
  notes?: string
  // Synligt fel vid misslyckat e-postutskick. Sätts av processInvoiceSendJob,
  // nollställs vid lyckat utskick. Statusen förblir DRAFT — fältet (inte en
  // FAILED-status) bär felet, samma mönster som RentNotice.sendError.
  sendError?: string | null
  trackingToken: string
  createdAt: string
  updatedAt: string
  // Matchade banktransaktioner — fylls bara av invoice-detail/list-svar.
  bankTransactions?: Array<{
    id: string
    date: string
    amount: number
    description: string
    rawOcr?: string | null
  }>
}

// ─── Invoice Events (Fakturahistorik) ────────────────────────────────────────
// Append-only audit log – samma mönster som Fortnox, Visma och Stripe.
// Invoice-raden håller materialiserad aktuell status.
// InvoiceEvent-rader är immutabla och skrivs aldrig om.

export type InvoiceEventType =
  // Livscykel
  | 'invoice.created'
  | 'invoice.updated'
  // Utskick
  | 'invoice.sent'
  | 'invoice.send_failed'
  // E-postleverans (via provider-webhook, t.ex. Postmark)
  | 'invoice.email_queued'
  | 'invoice.email_delivered'
  | 'invoice.email_bounced'
  | 'invoice.email_spam'
  // Mottagaraktivitet (tracking-pixel / PDF-länk)
  | 'invoice.email_opened'
  | 'invoice.pdf_viewed'
  // Betalning
  | 'invoice.payment_received'
  | 'invoice.payment_partial'
  | 'invoice.payment_reversed'
  // Förfallen-flöde
  | 'invoice.overdue'
  | 'invoice.reminder_sent'
  | 'invoice.debt_collection'
  // Korrigeringar
  | 'invoice.voided'
  | 'invoice.credit_note_created'
  // Administrativt
  | 'invoice.note_added'
  | 'invoice.viewed_by_user'

export type EventActorType = 'USER' | 'SYSTEM' | 'WEBHOOK'

export interface InvoiceEvent {
  id: string
  invoiceId: string
  type: InvoiceEventType
  // Vem/vad som utlöste händelsen
  actorType: EventActorType
  actorId?: string
  actorLabel?: string // Denormaliserat för historikvisning (t.ex. "Anna Svensson")
  // Händelsespecifik data (e-postleverans, betalningsinfo, etc.)
  payload: Record<string, unknown>
  // E-postspårning
  ipAddress?: string
  userAgent?: string
  // Immutabel – ingen updatedAt
  createdAt: string
}

// ─── Bank Reconciliation (Bankavstämning) ─────────────────────────────────────

export type BankTransactionStatus = 'UNMATCHED' | 'MATCHED' | 'IGNORED'

export interface BankTransaction {
  id: string
  organizationId: string
  date: string
  description: string
  amount: number
  balance?: number
  reference?: string
  rawOcr?: string
  status: BankTransactionStatus
  invoiceId?: string
  matchedAt?: string
  matchedBy?: string
  createdAt: string
  invoice?: { id: string; invoiceNumber: string; status: string }
}

export interface ImportResult {
  imported: number
  duplicates: number
  autoMatched: number
  unmatched: number
  errors: string[]
  bank?: 'GENERIC' | 'HANDELSBANKEN' | 'SEB' | 'SWEDBANK'
}

export interface ReconciliationStats {
  total: number
  matched: number
  unmatched: number
  ignored: number
  totalAmount: number
  matchedAmount: number
}

// ─── Deposits (Depositioner) ──────────────────────────────────────────────────

export type DepositStatus =
  | 'PENDING'
  | 'PAID'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'FORFEITED'

export interface DepositDeduction {
  reason: string
  amount: number
}

export interface Deposit {
  id: string
  organizationId: string
  leaseId: string
  tenantId: string
  amount: number
  status: DepositStatus
  invoiceId?: string
  paidAt?: string
  refundedAt?: string
  refundAmount?: number
  deductions?: DepositDeduction[]
  notes?: string
  createdAt: string
  updatedAt: string
}

// ─── KeyHandover (Nyckelkvittens) ─────────────────────────────────────────────

export type KeyType =
  | 'APARTMENT'
  | 'ENTRANCE'
  | 'MAILBOX'
  | 'LAUNDRY_TAG'
  | 'GARAGE'
  | 'STORAGE'
  | 'FOB_TAG'
  | 'OTHER'

export type KeyStatus = 'ISSUED' | 'RETURNED' | 'LOST' | 'REPLACED'

export interface KeyHandover {
  id: string
  organizationId: string
  leaseId: string
  unitId: string
  tenantId: string
  type: KeyType
  label?: string
  status: KeyStatus
  issuedAt: string
  issuedToName?: string
  issuedById?: string
  returnedAt?: string
  receivedById?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

// ─── RentIncrease (Hyreshöjning) ──────────────────────────────────────────────

export type RentIncreaseStatus =
  | 'DRAFT'
  | 'NOTICE_SENT'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'APPLIED'

export interface RentIncrease {
  id: string
  organizationId: string
  leaseId: string
  currentRent: number
  newRent: number
  increasePercent: number
  reason: string
  noticeDate?: string
  effectiveDate: string
  status: RentIncreaseStatus
  respondedAt?: string
  rejectionReason?: string
  createdAt: string
  updatedAt: string
}

// ─── Accounting (Bokföring) ───────────────────────────────────────────────────

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'

export interface Account {
  id: string
  organizationId: string
  number: number // BAS-kontoplan (1000-9999)
  name: string
  type: AccountType
  parentId?: string
  isActive: boolean
}

export interface JournalEntry {
  id: string
  organizationId: string
  date: string
  description: string
  reference?: string
  source?: string
  sourceId?: string | null
  lines: JournalEntryLine[]
  createdById: string
  createdAt: string
}

export interface JournalEntryLine {
  id: string
  accountId: string
  account: Account
  debit?: number | null
  credit?: number | null
  description?: string | null
}

// ─── Finansiella rapporter ────────────────────────────────────────────────────
// Svar från /accounting/reports/*. Beräknas i AccountingService (en
// sanningskälla, delas med AI-verktygen).

export interface ReportAccountAmount {
  number: number
  name: string
  amount: number
}

export interface ReportAccountBalance {
  number: number
  name: string
  balance: number
}

export interface VatReport {
  period: { from: string; to: string }
  outgoing: { vat25: number; vat12: number; vat6: number; total: number }
  incoming: { total: number }
  netToPay: number
  direction: 'BETALA' | 'ÅTERBÄRING'
}

export interface ProfitLossReport {
  period: { from: string; to: string }
  propertyFilter?: string
  note?: string
  revenue: { total: number; accounts: ReportAccountAmount[] }
  costs: {
    operating: { total: number; accounts: ReportAccountAmount[] }
    admin: { total: number; accounts: ReportAccountAmount[] }
    personnel: { total: number; accounts: ReportAccountAmount[] }
    depreciation: { total: number; accounts: ReportAccountAmount[] }
    financial: { total: number; accounts: ReportAccountAmount[] }
    total: number
  }
  result: number
}

export interface BalanceSheet {
  asOf: string
  assets: { total: number; accounts: ReportAccountBalance[] }
  liabilitiesAndEquity: { total: number; accounts: ReportAccountBalance[] }
  difference: number
}

// ─── Förbrukning / IMD (Mätare, avläsningar, tariffer, charges) ───────────────
// Individuell mätning och debitering (el/vatten/värme). Motorn (backend) är
// källagnostisk; Etapp 1-frontenden är presentation ovanpå de färdiga
// endpoints:en — den rör aldrig debiterings-/bokföringskedjan.

// Speglar Prisma-enumet MeterType. El/värme bokförs mot 3920, vatten mot 3970.
export type MeterType = 'ELECTRICITY' | 'WATER_COLD' | 'WATER_HOT' | 'HEATING'

// Speglar Prisma-enumet MeterStatus. REMOVED behåller historiken (readings
// bevaras som räkenskapsinformation, BFL 7 år) — mätaren raderas aldrig.
export type MeterStatus = 'ACTIVE' | 'INACTIVE' | 'REMOVED'

export interface Meter {
  id: string
  organizationId: string
  unitId: string
  type: MeterType
  // Fri text, källagnostisk: "kWh" | "m³" | "MWh".
  unitOfMeasure: string
  serialNumber: string | null
  status: MeterStatus
  // Källagnostik: extern koppling för framtida leverantörs-API (Etapp 2).
  provider: string | null
  externalId: string | null
  installedAt: string | null
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

// ─── Förbrukning / IMD — Tariffer ─────────────────────────────────────────────
// Pris per förbrukningsenhet (kr/kWh, kr/m³) som avläsningarna räknar mot.
// Historik: validTo = null är gällande tariff; en prisändring stänger föregående
// rad (validTo) och skapar en ny — priset uppdateras aldrig in-place.

export type TariffScope = 'ORGANIZATION' | 'PROPERTY' | 'UNIT'

export interface ConsumptionTariff {
  id: string
  organizationId: string
  scope: TariffScope
  // Polymorft scope-mål: PROPERTY → propertyId satt, UNIT → unitId satt,
  // ORGANIZATION → båda null (plain strings, ingen relation).
  propertyId: string | null
  unitId: string | null
  meterType: MeterType
  // Decimal i DB → kan serialiseras som sträng; coercera med Number() vid visning.
  pricePerUnit: number | string
  fixedMonthlyFee: number | string | null
  validFrom: string
  validTo: string | null
  createdAt: string
  updatedAt: string
}

// ─── Förbrukning / IMD — Avläsningar ──────────────────────────────────────────
// Append-only mätunderlag (BFL 5:5 — rättning = ny rad, aldrig UPDATE/DELETE).
// Källagnostisk: MANUAL/IMPORT/API delar samma väg in (recordReading).

export type ReadingType = 'CUMULATIVE' | 'PERIOD_VOLUME'
export type ReadingSource = 'MANUAL' | 'IMPORT' | 'API'

export interface MeterReading {
  id: string
  organizationId: string
  meterId: string
  // Historisk ögonblicksbild (plain string, ingen FK) — överlever lease-radering.
  unitId: string
  leaseId: string | null
  // Decimal i DB → kan serialiseras som sträng; coercera med Number() vid visning.
  value: number | string
  readingType: ReadingType
  readingDate: string
  periodStart: string
  periodEnd: string
  source: ReadingSource
  externalId: string | null
  registeredById: string | null
  notes: string | null
  createdAt: string
}

// ─── Förbrukning / IMD — Förbrukningsposter (charges) ─────────────────────────
// En charge är ett bevis: DRAFT (prissatt) → CONFIRMED (periodiserat verifikat +
// 1510-fordran bokförd) → ATTACHED (kopplad till avi/faktura). CANCELLED = rättning
// (raderas aldrig). Belopp är snapshots av verifikatet — frontend räknar ALDRIG om
// dem, läser totalAmount/netAmount/vatAmount direkt (Decimal → serialiseras som
// sträng → coercera med Number() ENBART vid visning).

export type ConsumptionChargeStatus = 'DRAFT' | 'CONFIRMED' | 'ATTACHED' | 'CANCELLED'
export type ConsumptionChargeKind = 'ACTUAL' | 'ESTIMATE' | 'ADJUSTMENT'
export type ConsumptionVatStatus = 'EXEMPT' | 'TAXABLE_25'
// Leveranssätt (snapshot, ren presentation): rad på hyresavi, separat faktura,
// eller ingen debitering. SEPARATE_INVOICE skarp för bostad är utanför Etapp 1.
export type ConsumptionBillingMode = 'RENT_NOTICE_LINE' | 'SEPARATE_INVOICE' | 'NONE'

export interface ConsumptionCharge {
  id: string
  organizationId: string
  leaseId: string
  unitId: string
  tenantId: string
  meterReadingId: string
  meterType: MeterType
  periodStart: string
  periodEnd: string
  // Decimal i DB → serialiseras som sträng. Coercera med Number() vid visning.
  quantity: number | string
  pricePerUnit: number | string
  netAmount: number | string
  vatStatus: ConsumptionVatStatus
  vatRate: number
  vatAmount: number | string
  totalAmount: number | string
  kind: ConsumptionChargeKind
  status: ConsumptionChargeStatus
  deliveryMode: ConsumptionBillingMode
  invoiceId: string | null
  createdAt: string
  updatedAt: string
  // CHARGE_INCLUDE-relationer (alltid med i GET-svaren).
  lease: { id: string }
  tenant: {
    id: string
    firstName: string | null
    lastName: string | null
    companyName: string | null
  }
  meterReading: {
    id: string
    value: number | string
    readingType: ReadingType
    periodStart: string
    periodEnd: string
  }
}
