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
  total: number
  dueDate: string
  issueDate: string
  paidAt: string | null
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

export interface PortalAuthResult {
  sessionToken: string
  tenant: PortalTenant
  expiresAt: string
}

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
