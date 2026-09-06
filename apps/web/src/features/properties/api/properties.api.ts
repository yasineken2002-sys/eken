import { get, post, patch, del } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { UpdatePropertySchema } from '@eken/shared'
import type { Property, CreatePropertyInput, UpdatePropertyInput, Unit } from '@eken/shared'

export type PropertyWithCount = Omit<Property, 'units'> & { _count: { units: number } }
export type PropertyDetail = Omit<Property, 'units'> & { _count: { units: number }; units: Unit[] }

export function fetchProperties(): Promise<PropertyWithCount[]> {
  return get<PropertyWithCount[]>('/properties')
}

export function fetchProperty(id: string): Promise<PropertyDetail> {
  return get<PropertyDetail>(`/properties/${id}`)
}

export function createProperty(dto: CreatePropertyInput): Promise<PropertyWithCount> {
  return post<PropertyWithCount>('/properties', dto)
}

/**
 * PATCH gick tidigare på `Partial<CreatePropertyInput>` — en form webben hittade
 * på själv. `UpdatePropertySchema` (= `CreatePropertySchema.partial()`) är den
 * form servern faktiskt validerar mot, och den finns redan i @eken/shared.
 *
 * Skillnaden är inte kosmetisk: `Partial<T>` är en TYP och försvinner i runtime,
 * så ett fält med fel VÄRDE (fastighetstyp 'HYRESHUS') passerade webben och blev
 * ett 400 mitt i en redigering. Schemat fångar det före anropet.
 */
export function updateProperty(id: string, dto: UpdatePropertyInput): Promise<PropertyWithCount> {
  const kontrakt = kontraktsfel(UpdatePropertySchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return patch<PropertyWithCount>(`/properties/${id}`, dto)
}

export function deleteProperty(id: string): Promise<void> {
  return del(`/properties/${id}`)
}
