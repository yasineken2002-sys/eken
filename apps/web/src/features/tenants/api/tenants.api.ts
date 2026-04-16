import { get, post, patch, del } from '@/lib/api'
import type { Tenant, Invoice, CreateTenantInput } from '@eken/shared'

export type TenantWithCount = Tenant & { _count: { invoices: number } }
export type TenantDetail = TenantWithCount & { invoices: Invoice[] }

// Maps CreateTenantInput (nested address) → flat fields the backend DTO expects
function flattenDto(dto: CreateTenantInput | Partial<CreateTenantInput>): Record<string, unknown> {
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

export function createTenant(dto: CreateTenantInput): Promise<Tenant> {
  return post<Tenant>('/tenants', flattenDto(dto))
}

export function updateTenant(id: string, dto: Partial<CreateTenantInput>): Promise<Tenant> {
  return patch<Tenant>(`/tenants/${id}`, flattenDto(dto))
}

export function deleteTenant(id: string): Promise<void> {
  return del(`/tenants/${id}`)
}
