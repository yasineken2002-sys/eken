import { get, patch, post } from '@/lib/api'
import type { RentIncrease, RentIncreaseStatus, Tenant } from '@eken/shared'

export type RentIncreaseDetail = RentIncrease & {
  lease: {
    id: string
    monthlyRent: number
    unit: { id: string; name: string; property: { id: string; name: string } }
    tenant: Tenant
  }
}

export interface CreateRentIncreaseInput {
  leaseId: string
  newRent: number
  reason: string
  effectiveDate: string
}

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
  return post<RentIncreaseDetail>('/rent-increases', dto)
}

export function sendRentIncreaseNotice(id: string): Promise<RentIncreaseDetail> {
  return post<RentIncreaseDetail>(`/rent-increases/${id}/send-notice`, {})
}

export function acceptRentIncrease(id: string): Promise<RentIncreaseDetail> {
  return patch<RentIncreaseDetail>(`/rent-increases/${id}/accept`, {})
}

export function rejectRentIncrease(
  id: string,
  rejectionReason: string,
): Promise<RentIncreaseDetail> {
  return patch<RentIncreaseDetail>(`/rent-increases/${id}/reject`, { rejectionReason })
}

export function withdrawRentIncrease(id: string): Promise<RentIncreaseDetail> {
  return patch<RentIncreaseDetail>(`/rent-increases/${id}/withdraw`, {})
}
