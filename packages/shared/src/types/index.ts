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

export interface Organization {
  id: string
  name: string
  orgNumber: string // Swedish org nr (556xxx-xxxx)
  vatNumber?: string
  email: string
  phone?: string
  address: Address
  logoUrl?: string
  bankgiro?: string
  paymentTermsDays?: number
  invoiceColor?: string
  invoiceTemplate?: string
  morningReportEnabled?: boolean
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
  createdAt: string
  updatedAt: string
}

// ─── Leases (Hyresavtal) ──────────────────────────────────────────────────────

export type LeaseStatus = 'DRAFT' | 'ACTIVE' | 'TERMINATED' | 'EXPIRED'

export interface Lease {
  id: string
  organizationId: string
  unitId: string
  tenantId: string
  status: LeaseStatus
  startDate: string
  endDate?: string // null = open-ended
  monthlyRent: number
  depositAmount: number
  noticePeriodMonths: number
  indexClause: boolean
  signedAt?: string
  terminatedAt?: string
  terminationReason?: string
  createdAt: string
  updatedAt: string
}

// ─── Invoices (Fakturor) ──────────────────────────────────────────────────────

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID'
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
  tenantId: string
  leaseId?: string
  lines: InvoiceLine[]
  subtotal: number
  vatTotal: number
  total: number
  dueDate: string
  issueDate: string
  paidAt?: string
  reference?: string // OCR/Referensnummer
  notes?: string
  trackingToken: string
  createdAt: string
  updatedAt: string
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
}

export interface ReconciliationStats {
  total: number
  matched: number
  unmatched: number
  ignored: number
  totalAmount: number
  matchedAmount: number
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
