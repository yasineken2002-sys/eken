import { get, post, patch } from '@/lib/api'
import type { Meter, MeterStatus, CreateMeterInput, UpdateMeterInput } from '@eken/shared'

// Tunna helpers mot /v1/consumption/meters. Per subdomän (meters/tariffs/
// readings/charges) så att senare frontend-PR:er (1.3/1.4/1.5) inte krockar i
// en gemensam fil. Rör aldrig debiterings-/bokföringskedjan — bara läs + CRUD
// av själva mätaren.

export interface MeterFilters {
  unitId?: string
  status?: MeterStatus
}

export function fetchMeters(filters?: MeterFilters): Promise<Meter[]> {
  return get<Meter[]>('/consumption/meters', filters as Record<string, unknown> | undefined)
}

export function fetchMeter(id: string): Promise<Meter> {
  return get<Meter>(`/consumption/meters/${id}`)
}

export function createMeter(dto: CreateMeterInput): Promise<Meter> {
  return post<Meter>('/consumption/meters', dto)
}

export function updateMeter(id: string, dto: UpdateMeterInput): Promise<Meter> {
  return patch<Meter>(`/consumption/meters/${id}`, dto)
}
