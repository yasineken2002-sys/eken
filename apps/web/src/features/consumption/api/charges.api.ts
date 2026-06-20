import { get, patch } from '@/lib/api'
import type { ConsumptionCharge, ConsumptionChargeStatus } from '@eken/shared'

// Tunna helpers mot /v1/consumption/charges. Egen subdomän-fil. Backend
// exponerar GET (lista + enskild) + PATCH :id/confirm. Frontend bygger INGEN
// bokföringslogik och räknar INGA belopp — confirm anropar bara den befintliga
// endpointen som skapar verifikatet.

export interface ChargeFilters {
  status?: ConsumptionChargeStatus
  leaseId?: string
}

export function fetchCharges(filters?: ChargeFilters): Promise<ConsumptionCharge[]> {
  return get<ConsumptionCharge[]>(
    '/consumption/charges',
    filters as Record<string, unknown> | undefined,
  )
}

export function fetchCharge(id: string): Promise<ConsumptionCharge> {
  return get<ConsumptionCharge>(`/consumption/charges/${id}`)
}

// DRAFT → CONFIRMED. Detta är en BOKFÖRINGSÅTGÄRD: backend skapar ett periodiserat
// verifikat (1510-fordran + intäkt). Ingen body.
export function confirmCharge(id: string): Promise<ConsumptionCharge> {
  return patch<ConsumptionCharge>(`/consumption/charges/${id}/confirm`)
}
