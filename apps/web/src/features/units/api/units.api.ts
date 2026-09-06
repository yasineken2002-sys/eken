import { get, post, patch, del } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { CreateUnitSchema, UpdateUnitSchema } from '@eken/shared'
import type { CreateUnitInput, UpdateUnitInput } from '@eken/shared'
// Vidareexporteras: sidor och formulär importerar typerna härifrån sedan
// tidigare, och det är ingen andra sanning — de kommer ur @eken/shared.
export type { CreateUnitInput, UpdateUnitInput }
import type { UnitType, UnitStatus } from '@eken/shared'

export interface UnitWithProperty {
  id: string
  propertyId: string
  name: string
  unitNumber: string
  type: UnitType
  status: UnitStatus
  area: number
  floor?: number | null
  rooms?: number | null
  monthlyRent: number
  createdAt: string
  updatedAt: string
  property: { id: string; name: string }
  _count: { leases: number }
}

export interface UnitLeaseTenant {
  id: string
  type: string
  firstName?: string | null
  lastName?: string | null
  companyName?: string | null
  email: string
}

export interface UnitLease {
  id: string
  status: string
  startDate: string
  endDate?: string | null
  monthlyRent: number
  tenant: UnitLeaseTenant
}

export type UnitDetail = UnitWithProperty & {
  leases: UnitLease[]
}

/**
 * TYPEN KOMMER NU FRÅN @eken/shared.
 *
 * Webben bar en EGEN `CreateUnitInput` därför att det delade schemat SAKNADE
 * `propertyId` och `status` — utan fastigheten kan ingen lägenhet skapas, så
 * schemat kunde inte beskriva en giltig kropp. Schemat är rättat i samma
 * ändring; den lokala kopian behövs inte längre.
 */
export function fetchUnits(propertyId?: string): Promise<UnitWithProperty[]> {
  return get<UnitWithProperty[]>('/units', propertyId ? { propertyId } : undefined)
}

export function fetchUnit(id: string): Promise<UnitDetail> {
  return get<UnitDetail>(`/units/${id}`)
}

export function createUnit(dto: CreateUnitInput): Promise<UnitWithProperty> {
  const kontrakt = kontraktsfel(CreateUnitSchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return post<UnitWithProperty>('/units', dto)
}

export function updateUnit(id: string, dto: UpdateUnitInput): Promise<UnitWithProperty> {
  const kontrakt = kontraktsfel(UpdateUnitSchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return patch<UnitWithProperty>(`/units/${id}`, dto)
}

export function deleteUnit(id: string): Promise<void> {
  return del(`/units/${id}`)
}
