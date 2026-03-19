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
  lines: JournalEntryLine[]
  createdById: string
  createdAt: string
}

export interface JournalEntryLine {
  id: string
  accountId: string
  accountNumber: number
  accountName: string
  debit?: number
  credit?: number
  description?: string
}
