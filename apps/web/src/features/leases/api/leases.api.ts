import { get, post, patch, del, api } from '@/lib/api'
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
  leaseType?: 'FIXED_TERM' | 'INDEFINITE'
  renewalPeriodMonths?: number
  noticePeriodMonths?: number
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
  leaseType?: 'FIXED_TERM' | 'INDEFINITE'
  renewalPeriodMonths?: number
  noticePeriodMonths?: number
}

export interface TerminateLeaseInput {
  terminationReason?: string
  effectiveDate?: string
}

export interface RenewLeaseInput {
  newEndDate?: string
  monthlyRent?: number
}

export function terminateLease(id: string, dto: TerminateLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/terminate`, dto)
}

export function renewLease(id: string, dto: RenewLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/renew`, dto)
}

export function createLeaseWithTenant(dto: CreateLeaseWithTenantInput): Promise<LeaseDetail> {
  return post<LeaseDetail>('/leases/with-tenant', dto)
}

export function generateLeaseContract(
  leaseId: string,
): Promise<{ documentId: string; message: string }> {
  return post(`/contracts/generate/${leaseId}`, {})
}

export async function downloadLeaseContract(leaseId: string): Promise<void> {
  const res = await api.get(`/contracts/download/${leaseId}`, { responseType: 'blob' })
  const url = window.URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hyreskontrakt-${leaseId.slice(0, 8)}.pdf`
  a.click()
  window.URL.revokeObjectURL(url)
}
