import { get, post } from '@/lib/api'
import type { MiscCharge, MiscChargeStatus, MiscChargeSource } from '@eken/shared'

// Tunna helpers mot /v1/misc-charges (teknisk förvaltning, Spår A). Hyresvärds-
// sidan. Frontend bygger INGEN bokföringslogik och räknar INGA belopp — confirm
// anropar bara den befintliga endpointen som skapar verifikatet. Belopp läses
// som fryst snapshot (Decimal → sträng → Number() vid visning).

export interface MiscChargeFilters {
  status?: MiscChargeStatus
  leaseId?: string
  // Källans id (t.ex. ett MaintenanceTicket) — hämta postens status för ett ärende.
  sourceRefId?: string
}

export interface CreateMiscChargeBody {
  leaseId: string
  tenantId: string
  sourceType: MiscChargeSource
  sourceRefId: string
  description: string
  // ISO-datum (YYYY-MM-DD) — bokföringsdatum (när skadan/förlusten konstaterades).
  incidentDate: string
  // Netto. Moms snapshotas i backend (EXEMPT v1). Frontend räknar aldrig om.
  netAmount: number
}

export function fetchMiscCharges(filters?: MiscChargeFilters): Promise<MiscCharge[]> {
  return get<MiscCharge[]>('/misc-charges', filters as Record<string, unknown> | undefined)
}

export function fetchMiscCharge(id: string): Promise<MiscCharge> {
  return get<MiscCharge>(`/misc-charges/${id}`)
}

// DRAFT — skapar posten + fryser momssnapshot i backend.
export function createMiscCharge(body: CreateMiscChargeBody): Promise<MiscCharge> {
  return post<MiscCharge>('/misc-charges', body)
}

// DRAFT → CONFIRMED. BOKFÖRINGSÅTGÄRD: backend skapar verifikatet (1510-fordran +
// 3990-intäkt). Ingen body.
export function confirmMiscCharge(id: string): Promise<MiscCharge> {
  return post<MiscCharge>(`/misc-charges/${id}/confirm`)
}

// Annullering: DRAFT → CANCELLED (inget verifikat) eller CONFIRMED → motverifikat
// + CANCELLED. Ingen body.
export function cancelMiscCharge(id: string): Promise<MiscCharge> {
  return post<MiscCharge>(`/misc-charges/${id}/cancel`)
}
