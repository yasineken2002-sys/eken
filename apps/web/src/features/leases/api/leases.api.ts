import { toast } from 'sonner'
import { get, post, patch, del, extractApiError } from '@/lib/api'
import { openPresignedDownload, sanitizeFilename } from '@/lib/download'
import type {
  CreateLeaseInput,
  CreateLeaseWithTenantInput,
  Lease,
  Property,
  CreateSigningRequestInput,
  RenewLeaseInput,
  Tenant,
  TerminateLeaseInput,
  TransitionLeaseStatusInput,
  Unit,
  UpdateAppendixInput,
  UpdateLeaseInput,
} from '@eken/shared'

/**
 * KONTRAKTET ÄGS AV `@eken/shared`, inte av den här filen.
 *
 * Här stod tidigare fyra egna interface — `CreateLeaseInput`,
 * `ContractTerms`, `CreateLeaseWithTenantInput`, `TerminateLeaseInput` och
 * `RenewLeaseInput` — som beskrev samma endpoints som DTO:erna. De hade redan
 * glidit: villkorsfälten var typade `?: number | null` medan schemat säger
 * `.optional()`, och `existingTenantId` var `?: string` utan `| undefined`,
 * vilket under `exactOptionalPropertyTypes: true` är en ANNAN typ än den
 * schemat härleder.
 *
 * Namnen re-exporteras så att de sex importörerna inte behöver röras — men
 * definitionen kommer nu från schemat.
 */
export type { CreateLeaseInput, CreateLeaseWithTenantInput, RenewLeaseInput, TerminateLeaseInput }

export type LeaseDetail = Lease & {
  unit: Unit & { property: Property }
  tenant: Tenant
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

export function updateLease(id: string, dto: UpdateLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}`, dto)
}

export function transitionLeaseStatus(
  id: string,
  status: TransitionLeaseStatusInput['status'],
): Promise<LeaseDetail> {
  const kropp: TransitionLeaseStatusInput = { status }
  return patch<LeaseDetail>(`/leases/${id}/status`, kropp)
}

export function deleteLease(id: string): Promise<void> {
  return del(`/leases/${id}`)
}

export type PetPolicy = 'ALLOWED' | 'REQUIRES_APPROVAL' | 'NOT_ALLOWED'
export type IndexClauseType = 'NONE' | 'KPI' | 'NEGOTIATED' | 'MARKET_RENT'

export function terminateLease(id: string, dto: TerminateLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/terminate`, dto)
}

// ─── Bilagor (Kontraktsmall 2.0) ──────────────────────────────────────────

export type AppendixCategory =
  | 'ENERGY_DECLARATION'
  | 'HOUSE_RULES'
  | 'INSPECTION_PROTOCOL'
  | 'OTHER'

export interface AppendixItem {
  id: string
  name: string
  category: string
  fileSize: number | null
  mimeType: string
  attachedToLeaseAsAppendix: boolean
  appendixOrder: number | null
  createdAt: string
}

export function fetchAppendices(leaseId: string): Promise<{ items: AppendixItem[] }> {
  return get<{ items: AppendixItem[] }>(`/contracts/${leaseId}/appendices`)
}

export function updateAppendix(
  leaseId: string,
  documentId: string,
  dto: UpdateAppendixInput,
): Promise<AppendixItem> {
  return patch<AppendixItem>(`/contracts/${leaseId}/appendices/${documentId}`, dto)
}

export function renewLease(id: string, dto: RenewLeaseInput): Promise<LeaseDetail> {
  return patch<LeaseDetail>(`/leases/${id}/renew`, dto)
}

export function createLeaseWithTenant(dto: CreateLeaseWithTenantInput): Promise<LeaseDetail> {
  return post<LeaseDetail>('/leases/with-tenant', dto)
}

export interface InitialNoticesResult {
  deposit: { id: string; noticeNumber: string } | null
  firstRent: { id: string; noticeNumber: string } | null
  mailed: boolean
  skippedDeposit: boolean
  skipDepositReason: 'succession' | 'deposit-finns' | 'depositionsavi-finns' | null
}

// Skapar aktiveringens avier manuellt när köandet fallerade (#58). Servern
// härleder själv om depositionen ska hoppas över — klienten skickar inga
// flaggor, just för att en felaktig flagga skulle kunna dubbeldebitera.
export function createInitialNotices(leaseId: string): Promise<InitialNoticesResult> {
  // INGEN NYTTOLAST. Endpointen tar ingen kropp — allt den behöver står i
  // sökvägen — och `{}` var ett tomt objekt som såg ut som ett kontrakt utan
  // att vara ett. Ett schema hade inte kunnat beskriva det, och en läsare kan
  // inte se skillnad på "kroppen är avsiktligt tom" och "fälten glömdes".
  return post<InitialNoticesResult>(`/leases/${leaseId}/initial-notices`)
}

export function generateLeaseContract(
  leaseId: string,
): Promise<{ documentId: string; message: string }> {
  // Samma sak: kontraktet genereras ur avtalet, som identifieras av sökvägen.
  return post(`/contracts/generate/${leaseId}`)
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
  signedUserAgent: string | null
  signatureName: string | null
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

/**
 * Förbered en signeringsbegäran för ett kontraktsdokument.
 *
 * Samma endpoint och samma tjänstemetod (`SigningService.createSigningRequest`)
 * som AI-verktyget `prepare_contract_signing` anropar. Signeringsmodulen är
 * inert i produktion tills S3 — då svarar den 503, och felet visas i klartext
 * i stället för att knappen tyst inte gör något.
 */
export function createSigningRequest(documentId: string): Promise<{
  id: string
  status: string
}> {
  const kropp: CreateSigningRequestInput = { documentId }
  return post<{ id: string; status: string }>('/signing/requests', kropp)
}
