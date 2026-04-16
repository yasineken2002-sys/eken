import { get, post, patch, del } from '@/lib/api'
import type { Lease, Tenant, Unit, Property } from '@eken/shared'

export type LeaseDetail = Lease & {
  unit: Unit & { property: Property }
  tenant: Tenant
}

export interface CreateLeaseInput {
  unitId: string
  tenantId: string
  startDate: string
  endDate?: string
  monthlyRent: number
  depositAmount?: number
}

export function fetchLeases(): Promise<LeaseDetail[]> {
  return get<LeaseDetail[]>('/leases')
}

export function fetchLease(id: string): Promise<LeaseDetail> {
  return get<LeaseDetail>(`/leases/${id}`)
}

export function createLease(dto: CreateLeaseInput): Promise<LeaseDetail> {
  return post<LeaseDetail>('/leases', dto)
}

export function updateLease(id: string, dto: Partial<CreateLeaseInput>): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}`, dto)
}

export function transitionLeaseStatus(id: string, status: string): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/status`, { status })
}

export function deleteLease(id: string): Promise<void> {
  return del(`/leases/${id}`)
}

export interface CreateLeaseWithTenantInput {
  unitId: string
  existingTenantId?: string
  newTenant?: {
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName?: string
    lastName?: string
    companyName?: string
    email: string
    phone?: string
  }
  monthlyRent: number
  depositAmount?: number
  startDate: string
  endDate?: string
}

export function createLeaseWithTenant(dto: CreateLeaseWithTenantInput): Promise<LeaseDetail> {
  return post<LeaseDetail>('/leases/with-tenant', dto)
}
