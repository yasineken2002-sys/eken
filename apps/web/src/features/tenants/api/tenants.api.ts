import { get, patch, post } from '@/lib/api'
import type { Tenant, Invoice, Lease, Unit, Property } from '@eken/shared'

export type LeaseWithUnit = Lease & {
  unit: Unit & { property: Pick<Property, 'id' | 'name' | 'propertyDesignation'> }
}

export type TenantWithCount = Tenant & {
  _count: { invoices: number }
  activeLease: LeaseWithUnit | null
}

export type TenantDetail = TenantWithCount & {
  invoices: Invoice[]
  leases: LeaseWithUnit[]
}

export type UpdateTenantInput = {
  type?: 'INDIVIDUAL' | 'COMPANY'
  firstName?: string
  lastName?: string
  companyName?: string
  email?: string
  phone?: string
  personalNumber?: string
  orgNumber?: string
  address?: { street: string; city: string; postalCode: string }
}

function flattenUpdate(dto: UpdateTenantInput): Record<string, unknown> {
  const { address, ...rest } = dto
  return {
    ...rest,
    ...(address
      ? { street: address.street, city: address.city, postalCode: address.postalCode }
      : {}),
  }
}

export function fetchTenants(search?: string): Promise<TenantWithCount[]> {
  return get<TenantWithCount[]>('/tenants', search ? { search } : undefined)
}

export function fetchTenant(id: string): Promise<TenantDetail> {
  return get<TenantDetail>(`/tenants/${id}`)
}

// OBS: Hyresgäster skapas inte längre fristående – endast via
// LeaseForm/useCreateLeaseWithTenant. createTenant-funktionen är därför
// inte längre exponerad i UI:t.

export function updateTenant(id: string, dto: UpdateTenantInput): Promise<Tenant> {
  return patch<Tenant>(`/tenants/${id}`, flattenUpdate(dto))
}

// ── Portal-aktivering (admin) ────────────────────────────────────────────────

export interface TenantActivationStatus {
  tenantId: string
  email: string
  portalActivated: boolean
  portalActivatedAt: string | null
  activationTokenExpiresAt: string | null
  hasPendingActivationLink: boolean
}

export function fetchActivationStatus(tenantId: string): Promise<TenantActivationStatus> {
  return get<TenantActivationStatus>(`/tenant-portal/admin/activation-status/${tenantId}`)
}

export function resendActivation(tenantId: string): Promise<{ message: string }> {
  return post<{ message: string }>(`/tenant-portal/admin/resend-activation/${tenantId}`)
}
