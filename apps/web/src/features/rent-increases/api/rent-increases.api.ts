import { get, patch, post } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { CreateRentIncreaseSchema, RejectRentIncreaseSchema } from '@eken/shared'
import type { CreateRentIncreaseInput, RejectRentIncreaseInput } from '@eken/shared'
import type { RentIncrease, RentIncreaseStatus, Tenant } from '@eken/shared'

export type RentIncreaseDetail = RentIncrease & {
  lease: {
    id: string
    monthlyRent: number
    unit: { id: string; name: string; property: { id: string; name: string } }
    tenant: Tenant
  }
}

/**
 * TYPEN KOMMER NU FRÅN @eken/shared.
 *
 * Den lokala versionen SAKNADE `notes` — ett valfritt fält som `CreateRentIncreaseDto`
 * alltid tagit emot. Fältet fanns alltså i API:t men gick inte att fylla i från
 * gränssnittet, och ingen typ sa ifrån eftersom de två aldrig jämfördes.
 */

export function fetchRentIncreases(filters?: {
  status?: RentIncreaseStatus
  leaseId?: string
}): Promise<RentIncreaseDetail[]> {
  return get<RentIncreaseDetail[]>(
    '/rent-increases',
    filters as Record<string, unknown> | undefined,
  )
}

export function fetchRentIncrease(id: string): Promise<RentIncreaseDetail> {
  return get<RentIncreaseDetail>(`/rent-increases/${id}`)
}

export function createRentIncrease(dto: CreateRentIncreaseInput): Promise<RentIncreaseDetail> {
  const kontrakt = kontraktsfel(CreateRentIncreaseSchema, dto)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return post<RentIncreaseDetail>('/rent-increases', dto)
}

/**
 * TOM KROPP BORTTAGEN. Rutten deklarerar inget `@Body()`, så `{}` var en
 * nyttolast ingen läste — och en nyttolast utan mottagare är en form som ser ut
 * att betyda något. Åtgärden är att sluta skicka den, inte att uppfinna en DTO.
 */
export function sendRentIncreaseNotice(id: string): Promise<RentIncreaseDetail> {
  return post<RentIncreaseDetail>(`/rent-increases/${id}/send-notice`)
}

/** TOM KROPP BORTTAGEN — rutten har inget `@Body()`. Se send-notice ovan. */
export function acceptRentIncrease(id: string): Promise<RentIncreaseDetail> {
  return patch<RentIncreaseDetail>(`/rent-increases/${id}/accept`)
}

export function rejectRentIncrease(
  id: string,
  rejectionReason: string,
): Promise<RentIncreaseDetail> {
  const kropp: RejectRentIncreaseInput = { rejectionReason }
  const kontrakt = kontraktsfel(RejectRentIncreaseSchema, kropp)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return patch<RentIncreaseDetail>(`/rent-increases/${id}/reject`, kropp)
}

/** TOM KROPP BORTTAGEN — rutten har inget `@Body()`. Se send-notice ovan. */
export function withdrawRentIncrease(id: string): Promise<RentIncreaseDetail> {
  return patch<RentIncreaseDetail>(`/rent-increases/${id}/withdraw`)
}
