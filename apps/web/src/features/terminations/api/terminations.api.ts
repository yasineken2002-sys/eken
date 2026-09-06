import { get, patch } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { ApproveTerminationSchema, RejectTerminationSchema } from '@eken/shared'
import type { ApproveTerminationInput, RejectTerminationInput } from '@eken/shared'
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

/**
 * Kroppen var en INLINE-LITERAL — en form webben hittade på. Nu
 * `ApproveTerminationInput`, samma schema som DTO:n härleds ur.
 *
 * `effectiveDate` förblir VALFRITT, och det är juridik och inte kontraktsform:
 * utelämnat betyder att servern beräknar ett förslag ur uppsägningstiden. Att
 * göra fältet obligatoriskt här hade tyst tagit bort den vägen.
 */
export function approveTermination(
  id: string,
  body: ApproveTerminationInput,
): Promise<TerminationRequestDetail> {
  const kontrakt = kontraktsfel(ApproveTerminationSchema, body)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return patch<TerminationRequestDetail>(`/terminations/${id}/approve`, body)
}

export function rejectTermination(id: string, reason?: string): Promise<TerminationRequestDetail> {
  // `reason` är valfritt hela vägen: utelämnat blir en tom kropp, precis som
  // förut. Skillnaden är att formen nu är schemats och inte en literal här.
  const kropp: RejectTerminationInput = reason ? { reason } : {}
  const kontrakt = kontraktsfel(RejectTerminationSchema, kropp)
  if (kontrakt) return Promise.reject(new Error(kontrakt))
  return patch<TerminationRequestDetail>(`/terminations/${id}/reject`, kropp)
}
