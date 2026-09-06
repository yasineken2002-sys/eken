import { get, patch, post } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { UpdateTenantSchema, AnonymizeTenantSchema } from '@eken/shared'
import type { UpdateTenantInput, AnonymizeTenantInput } from '@eken/shared'
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

export type AnonymizeResult = {
  /** false = hyresgästen var redan avidentifierad; ingen ny loggpost skrevs. */
  performed: boolean
  anonymizedAt: string
}

export function anonymizeTenant(id: string, reason?: string): Promise<AnonymizeResult> {
  // `reason` är valfritt hela vägen: utelämnat blir en tom kropp, som förut.
  const kropp: AnonymizeTenantInput = reason ? { reason } : {}
  const kontrakt = kontraktsfel(AnonymizeTenantSchema, kropp)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return post<AnonymizeResult>(`/tenants/${id}/anonymize`, kropp)
}

/**
 * DEN LOKALA TYPEN OCH `flattenUpdate` ÄR BORTA.
 *
 * Webben bar en EGEN `UpdateTenantInput` med en NÄSTLAD `address`, och plattade
 * den till `street`/`city`/`postalCode` precis före anropet — för att träffa en
 * DTO som alltid tagit den flata formen. Tre former var alltså i omlopp för
 * samma skrivning (webbens, schemats och DTO:ns), och plattningen dolde att de
 * inte var samma.
 *
 * Typen kommer nu från @eken/shared och är den flata formen — samma som tråden.
 * Anroparen skickar det servern tar emot, och ingen översättning behövs.
 */
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
  const kontrakt = kontraktsfel(UpdateTenantSchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return patch<Tenant>(`/tenants/${id}`, dto)
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
