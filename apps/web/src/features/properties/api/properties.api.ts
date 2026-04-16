import { get, post, patch, del } from '@/lib/api'
import type { Property, CreatePropertyInput, Unit } from '@eken/shared'

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

export function updateProperty(
  id: string,
  dto: Partial<CreatePropertyInput>,
): Promise<PropertyWithCount> {
  return patch<PropertyWithCount>(`/properties/${id}`, dto)
}

export function deleteProperty(id: string): Promise<void> {
  return del(`/properties/${id}`)
}
