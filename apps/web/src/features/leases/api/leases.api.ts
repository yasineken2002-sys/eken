import { toast } from 'sonner'
import { get, post, patch, del, extractApiError } from '@/lib/api'
import { openPresignedDownload, sanitizeFilename } from '@/lib/download'
import type { Lease, Tenant, Unit, Property } from '@eken/shared'

export type LeaseDetail = Lease & {
  unit: Unit & { property: Property }
  tenant: Tenant
}

export interface CreateLeaseInput {
  unitId: string
  tenantId: string
  startDate: string
  endDate?: string
  monthlyRent: number
  depositAmount?: number
  leaseType?: 'FIXED_TERM' | 'INDEFINITE'
  renewalPeriodMonths?: number
  noticePeriodMonths?: number
}

export function fetchLeases(): Promise<LeaseDetail[]> {
  return get<LeaseDetail[]>('/leases')
}

export function fetchLease(id: string): Promise<LeaseDetail> {
  return get<LeaseDetail>(`/leases/${id}`)
}

export function createLease(dto: CreateLeaseInput): Promise<LeaseDetail> {
  return post<LeaseDetail>('/leases', dto)
}

export function updateLease(id: string, dto: Partial<CreateLeaseInput>): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}`, dto)
}

export function transitionLeaseStatus(id: string, status: string): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/status`, { status })
}

export function deleteLease(id: string): Promise<void> {
  return del(`/leases/${id}`)
}

export type PetPolicy = 'ALLOWED' | 'REQUIRES_APPROVAL' | 'NOT_ALLOWED'
export type IndexClauseType = 'NONE' | 'KPI' | 'NEGOTIATED' | 'MARKET_RENT'

export interface ContractTerms {
  // Vad ingår i hyran
  includesHeating?: boolean
  includesWater?: boolean
  includesHotWater?: boolean
  includesElectricity?: boolean
  includesInternet?: boolean
  includesCleaning?: boolean
  includesParking?: boolean
  includesStorage?: boolean
  includesLaundry?: boolean

  // Tilläggshyror
  parkingFee?: number | null
  storageFee?: number | null
  garageFee?: number | null

  // Användningsändamål, husdjur, andrahand, försäkring
  usagePurpose?: string | null
  petsAllowed?: PetPolicy
  petsApprovalNotes?: string | null
  sublettingAllowed?: boolean
  requiresHomeInsurance?: boolean

  // Indexklausul
  indexClauseType?: IndexClauseType
  indexBaseYear?: number | null
  indexAdjustmentDate?: string | null
  indexMaxIncrease?: number | null
  indexMinIncrease?: number | null
  indexNotes?: string | null
}

export interface CreateLeaseWithTenantInput extends ContractTerms {
  unitId: string
  existingTenantId?: string
  newTenant?: {
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName?: string
    lastName?: string
    companyName?: string
    email: string
    phone?: string
    personalNumber?: string
    orgNumber?: string
    street?: string
    city?: string
    postalCode?: string
    country?: string
  }
  monthlyRent: number
  depositAmount?: number
  startDate: string
  endDate?: string
  leaseType?: 'FIXED_TERM' | 'INDEFINITE'
  renewalPeriodMonths?: number
  noticePeriodMonths?: number
}

export interface TerminateLeaseInput {
  terminationReason?: string
  effectiveDate?: string
}

export interface RenewLeaseInput {
  newEndDate?: string
  monthlyRent?: number
}

export function terminateLease(id: string, dto: TerminateLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/terminate`, dto)
}

export function renewLease(id: string, dto: RenewLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/renew`, dto)
}

export function createLeaseWithTenant(dto: CreateLeaseWithTenantInput): Promise<LeaseDetail> {
  return post<LeaseDetail>('/leases/with-tenant', dto)
}

export function generateLeaseContract(
  leaseId: string,
): Promise<{ documentId: string; message: string }> {
  return post(`/contracts/generate/${leaseId}`, {})
}

export async function downloadLeaseContract(leaseId: string): Promise<void> {
  // Backend returnerar presigned R2-URL till senaste sparade kontrakts-PDF.
  // Tidigare laddades hela bufferten via vår API som blob — onödig
  // bandbreddskostnad när filen redan ligger i R2.
  try {
    const { url, filename } = await get<{ url: string; filename: string; mimeType: string }>(
      `/contracts/download/${leaseId}`,
    )
    openPresignedDownload(
      url,
      sanitizeFilename(filename || `hyreskontrakt-${leaseId.slice(0, 8)}.pdf`),
    )
  } catch (err) {
    toast.error('Kunde inte ladda ner kontraktet', {
      description: extractApiError(err, 'Försök igen om en stund.'),
    })
    throw err
  }
}

export interface ContractDocument {
  id: string
  name: string
  createdAt: string
  signedAt: string | null
  signedFromIp: string | null
  contentHash: string | null
  locked: boolean
  previousVersionId: string | null
  signedByTenant: {
    firstName: string | null
    lastName: string | null
    companyName: string | null
  } | null
}

export interface ContractStatus {
  latest: ContractDocument | null
  versions: ContractDocument[]
  hasPdf: boolean
  staleSinceSigning: boolean
}

export function fetchContractStatus(leaseId: string): Promise<ContractStatus> {
  return get<ContractStatus>(`/contracts/status/${leaseId}`)
}
