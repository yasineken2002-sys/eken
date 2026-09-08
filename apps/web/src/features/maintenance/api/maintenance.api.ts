import type { UpdateTicketInput } from '@eken/shared'
import { get, post, patch, del } from '@/lib/api'
import type {
  AddTicketCommentInput,
  CreateTicketInput,
  MaintenanceCategoryValue,
} from '@eken/shared'

export type MaintenanceStatus =
  | 'NEW'
  | 'IN_PROGRESS'
  | 'SCHEDULED'
  | 'COMPLETED'
  | 'CLOSED'
  | 'CANCELLED'
export type MaintenancePriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
/**
 * Kategorierna kommer nu ur `@eken/shared`, som är bunden till Prismas enum av
 * `maintenance-enum-source.spec.ts`. Här stod en egen uppräkning av samma elva
 * värden — rätt när den skrevs, men en tredje kopia (Prisma, den här, och
 * hyresgästverktygets, som hade glidit till sju värden varav tre påhittade).
 */
export type MaintenanceCategory = MaintenanceCategoryValue

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
  // Teknisk förvaltning (Spår A): debiterbar post genererad från ärendet. chargeId
  // = MaintenanceTicket.chargeId (skalär). leaseId = härlett aktivt avtal för
  // enheten (backend findOne) — krävs för "Debitera & bokför". Båda endast på
  // detalj-svaret (findOne), inte i listan.
  chargeId?: string | null
  leaseId?: string | null
  estimatedCost?: number | null
  actualCost?: number | null
  scheduledDate?: string | null
  completedAt?: string | null
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
  images: {
    id: string
    filename: string
    storageKey: string
    storageUrl: string
    size: number
    createdAt: string
  }[]
  comments: MaintenanceComment[]
  // Tilldelad hantverkare (etapp 10). Endast på detalj-svaret, som chargeId
  // ovan. `assignedToId` finns kvar i databasen men är utfasad och läses inte
  // här — se TODO vid fältet i schema.prisma.
  assignedContractor?: {
    id: string
    name: string
    email: string | null
    phone: string | null
    categories: string[]
  } | null
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

export type { UpdateTicketInput } from '@eken/shared'

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

export const addComment = (id: string, content: string, isInternal: boolean) => {
  const kropp: AddTicketCommentInput = { content, isInternal }
  return post<MaintenanceTicket>(`/maintenance/${id}/comments`, kropp)
}

export const deleteTicket = (id: string) => del(`/maintenance/${id}`)

export type { CreateTicketInput }
