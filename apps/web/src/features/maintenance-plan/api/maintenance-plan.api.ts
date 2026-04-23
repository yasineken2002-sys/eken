import { get, post, patch, del } from '@/lib/api'

export type MaintenancePlanStatus =
  | 'PLANNED'
  | 'APPROVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
export type MaintenancePlanCategory =
  | 'ROOF'
  | 'FACADE'
  | 'WINDOWS'
  | 'PLUMBING'
  | 'ELECTRICAL'
  | 'HEATING'
  | 'ELEVATOR'
  | 'COMMON_AREAS'
  | 'PAINTING'
  | 'FLOORING'
  | 'OTHER'

export interface MaintenancePlan {
  id: string
  organizationId: string
  propertyId: string
  title: string
  description: string | null
  category: MaintenancePlanCategory
  status: MaintenancePlanStatus
  plannedYear: number
  estimatedCost: number
  actualCost: number | null
  priority: number
  interval: number | null
  lastDoneYear: number | null
  notes: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  property: { id: string; name: string; street: string; city: string }
}

export interface YearSummary {
  year: number
  plans: MaintenancePlan[]
  totalEstimated: number
  totalActual: number
  count: number
}

export interface MaintenancePlanFilter {
  propertyId?: string
  year?: number
  status?: MaintenancePlanStatus | ''
  category?: MaintenancePlanCategory | ''
}

export interface CreateMaintenancePlanInput {
  title: string
  propertyId: string
  category?: MaintenancePlanCategory
  plannedYear: number
  estimatedCost: number
  priority?: number
  interval?: number
  lastDoneYear?: number
  description?: string
  notes?: string
}

export interface UpdateMaintenancePlanInput {
  title?: string
  category?: MaintenancePlanCategory
  status?: MaintenancePlanStatus
  plannedYear?: number
  estimatedCost?: number
  actualCost?: number
  priority?: number
  interval?: number
  lastDoneYear?: number
  description?: string
  notes?: string
  completedAt?: string
}

export function fetchPlans(filters?: MaintenancePlanFilter) {
  const params = new URLSearchParams()
  if (filters?.propertyId) params.set('propertyId', filters.propertyId)
  if (filters?.year) params.set('year', String(filters.year))
  if (filters?.status) params.set('status', filters.status)
  if (filters?.category) params.set('category', filters.category)
  const q = params.toString()
  return get<MaintenancePlan[]>(`/maintenance-plans${q ? `?${q}` : ''}`)
}

export function fetchYearlySummary(fromYear: number, toYear: number) {
  return get<YearSummary[]>(`/maintenance-plans/summary?fromYear=${fromYear}&toYear=${toYear}`)
}

export function fetchPlan(id: string) {
  return get<MaintenancePlan>(`/maintenance-plans/${id}`)
}

export function createPlan(dto: CreateMaintenancePlanInput) {
  return post<MaintenancePlan>('/maintenance-plans', dto)
}

export function updatePlan(id: string, dto: UpdateMaintenancePlanInput) {
  return patch<MaintenancePlan>(`/maintenance-plans/${id}`, dto)
}

export function deletePlan(id: string) {
  return del(`/maintenance-plans/${id}`)
}
