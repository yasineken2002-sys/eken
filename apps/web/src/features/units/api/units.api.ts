import { get, post, patch, del } from '@/lib/api'
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

export interface CreateUnitInput {
  propertyId: string
  name: string
  unitNumber: string
  type: UnitType
  status?: UnitStatus
  area: number
  floor?: number
  rooms?: number
  monthlyRent: number
}

export function fetchUnits(propertyId?: string): Promise<UnitWithProperty[]> {
  return get<UnitWithProperty[]>('/units', propertyId ? { propertyId } : undefined)
}

export function fetchUnit(id: string): Promise<UnitDetail> {
  return get<UnitDetail>(`/units/${id}`)
}

export function createUnit(dto: CreateUnitInput): Promise<UnitWithProperty> {
  return post<UnitWithProperty>('/units', dto)
}

export function updateUnit(id: string, dto: Partial<CreateUnitInput>): Promise<UnitWithProperty> {
  return patch<UnitWithProperty>(`/units/${id}`, dto)
}

export function deleteUnit(id: string): Promise<void> {
  return del(`/units/${id}`)
}
