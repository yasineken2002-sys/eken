import { get, patch } from '@/lib/api'
import type { Tenant } from '@eken/shared'

export type TerminationStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface TerminationRequestDetail {
  id: string
  organizationId: string
  tenantId: string
  leaseId: string
  requestedEndDate: string
  reason: string | null
  status: TerminationStatus
  reviewedAt: string | null
  reviewedById: string | null
  createdAt: string
  updatedAt: string
  organization: { name: string }
  tenant: Tenant
  lease: {
    id: string
    noticePeriodMonths: number
    unit: { id: string; name: string; property: { id: string; name: string } }
  }
}

export function fetchTerminations(filters?: {
  status?: TerminationStatus
}): Promise<TerminationRequestDetail[]> {
  return get<TerminationRequestDetail[]>(
    '/terminations',
    filters as Record<string, unknown> | undefined,
  )
}

export function approveTermination(
  id: string,
  body: { effectiveDate?: string; terminationReason?: string },
): Promise<TerminationRequestDetail> {
  return patch<TerminationRequestDetail>(`/terminations/${id}/approve`, body)
}

export function rejectTermination(id: string, reason?: string): Promise<TerminationRequestDetail> {
  return patch<TerminationRequestDetail>(`/terminations/${id}/reject`, reason ? { reason } : {})
}
