import { get, post, patch, del } from '@/lib/api'

export type MaintenanceStatus =
  | 'NEW'
  | 'IN_PROGRESS'
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'CLOSED'
  | 'CANCELLED'
export type MaintenancePriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
export type MaintenanceCategory =
  | 'PLUMBING'
  | 'ELECTRICAL'
  | 'HEATING'
  | 'APPLIANCES'
  | 'WINDOWS_DOORS'
  | 'LOCKS'
  | 'FACADE'
  | 'ROOF'
  | 'COMMON_AREAS'
  | 'CLEANING'
  | 'OTHER'

export interface MaintenanceComment {
  id: string
  ticketId: string
  userId?: string | null
  content: string
  isInternal: boolean
  createdAt: string
}

export interface MaintenanceTicket {
  id: string
  ticketNumber: string
  organizationId: string
  propertyId: string
  unitId?: string | null
  tenantId?: string | null
  title: string
  description: string
  category: MaintenanceCategory
  priority: MaintenancePriority
  status: MaintenanceStatus
  estimatedCost?: number | null
  actualCost?: number | null
  scheduledDate?: string | null
  completedAt?: string | null
  tenantToken?: string | null
  tenantNotified: boolean
  property: { id: string; name: string; city: string }
  unit?: { id: string; name: string; unitNumber: string } | null
  tenant?: {
    id: string
    firstName?: string | null
    lastName?: string | null
    companyName?: string | null
    type: string
    email: string
  } | null
  images: { id: string; filename: string; path: string; size: number; createdAt: string }[]
  comments: MaintenanceComment[]
  createdAt: string
  updatedAt: string
}

export interface MaintenanceStats {
  total: number
  byStatus: Partial<Record<MaintenanceStatus, number>>
  byPriority: Partial<Record<MaintenancePriority, number>>
  byCategory: Partial<Record<MaintenanceCategory, number>>
  urgent: number
  openCosts: number
}

export interface CreateTicketInput {
  title: string
  description: string
  propertyId: string
  unitId?: string
  tenantId?: string
  category?: MaintenanceCategory
  priority?: MaintenancePriority
  scheduledDate?: string
  estimatedCost?: number
}

export interface UpdateTicketInput {
  title?: string
  description?: string
  unitId?: string
  tenantId?: string
  category?: MaintenanceCategory
  priority?: MaintenancePriority
  status?: MaintenanceStatus
  scheduledDate?: string
  estimatedCost?: number
  actualCost?: number
  tenantNotified?: boolean
}

export interface TicketFilters {
  status?: MaintenanceStatus
  priority?: MaintenancePriority
  category?: MaintenanceCategory
  propertyId?: string
  unitId?: string
}

export const fetchTickets = (filters?: TicketFilters) => {
  const params = new URLSearchParams()
  if (filters?.status) params.set('status', filters.status)
  if (filters?.priority) params.set('priority', filters.priority)
  if (filters?.category) params.set('category', filters.category)
  if (filters?.propertyId) params.set('propertyId', filters.propertyId)
  if (filters?.unitId) params.set('unitId', filters.unitId)
  const qs = params.toString()
  return get<MaintenanceTicket[]>(`/maintenance${qs ? `?${qs}` : ''}`)
}

export const fetchStats = () => get<MaintenanceStats>('/maintenance/stats')

export const fetchTicket = (id: string) => get<MaintenanceTicket>(`/maintenance/${id}`)

export const createTicket = (dto: CreateTicketInput) => post<MaintenanceTicket>('/maintenance', dto)

export const updateTicket = (id: string, dto: UpdateTicketInput) =>
  patch<MaintenanceTicket>(`/maintenance/${id}`, dto)

export const addComment = (id: string, content: string, isInternal: boolean) =>
  post<MaintenanceTicket>(`/maintenance/${id}/comments`, { content, isInternal })

export const deleteTicket = (id: string) => del(`/maintenance/${id}`)
