import { get, post } from '@/lib/api'
import type { ConsumptionTariff, MeterType, TariffScope, CreateTariffInput } from '@eken/shared'

// Tunna helpers mot /v1/consumption/tariffs. Egen subdomän-fil (inte gemensam)
// så 1.4/1.5 inte krockar. Backend exponerar bara GET (lista) + POST (skapa) —
// tariffer uppdateras aldrig in-place: en prisändring är en ny rad som stänger
// föregående (historik). Rör aldrig debiterings-/bokföringskedjan.

export interface TariffFilters {
  meterType?: MeterType
  scope?: TariffScope
}

export function fetchTariffs(filters?: TariffFilters): Promise<ConsumptionTariff[]> {
  return get<ConsumptionTariff[]>(
    '/consumption/tariffs',
    filters as Record<string, unknown> | undefined,
  )
}

export function createTariff(dto: CreateTariffInput): Promise<ConsumptionTariff> {
  return post<ConsumptionTariff>('/consumption/tariffs', dto)
}
