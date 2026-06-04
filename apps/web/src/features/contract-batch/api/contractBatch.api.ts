import { api, get, post, del } from '@/lib/api'

export type ContractRowStatus =
  | 'PENDING'
  | 'SCANNING'
  | 'SCANNED'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'SKIPPED'
  | 'FAILED'

export type ContractMatchStatus = 'AUTO_MATCHED' | 'AMBIGUOUS' | 'NO_MATCH' | 'NEEDS_REVIEW' | null

export type ContractBatchStatus =
  | 'PENDING'
  | 'SCANNING'
  | 'SCANNED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

// Fälten ur skanningen som operatören kan granska/redigera inför commit.
export interface ScannedContractData {
  tenantName: string | null
  tenantType: 'INDIVIDUAL' | 'COMPANY' | null
  tenantEmail: string | null
  tenantPhone: string | null
  personalNumber: string | null
  companyName: string | null
  orgNumber: string | null
  propertyAddress: string | null
  unitDescription: string | null
  monthlyRent: number | null
  depositAmount: number | null
  startDate: string | null
  endDate: string | null
  noticePeriodMonths: number | null
  confidence: number
}

export interface ContractBatchRow {
  id: string
  fileName: string
  fileSize: number
  rowStatus: ContractRowStatus
  confidence: number | null
  reviewedData: ScannedContractData | null
  matchStatus: ContractMatchStatus
  matchedUnitId: string | null
  createdLeaseId: string | null
  errorMessage: string | null
}

export interface ContractBatch {
  id: string
  status: ContractBatchStatus
  totalRows: number
  scannedRows: number
  failedRows: number
  estimatedCostSek: number
  createdAt: string
  rows: ContractBatchRow[]
}

export interface CreateBatchResult {
  id: string
  status: ContractBatchStatus
  totalRows: number
  estimatedCostSek: number
}

export interface ConfirmRowResult {
  rowId: string
  leaseId: string
  alreadyCommitted: boolean
}

export interface BulkConfirmResult {
  committed: Array<{ rowId: string; leaseId: string }>
  failed: Array<{ rowId: string; error: string }>
  skipped: number
}

export interface ConfirmRowBody {
  unitId?: string
  reviewedData?: Partial<ScannedContractData>
}

export async function createContractBatch(files: File[]): Promise<CreateBatchResult> {
  const form = new FormData()
  for (const file of files) form.append('files', file)
  const { data } = await api.post<{ data: CreateBatchResult }>('/import/contract-batches', form)
  return data.data
}

export const getContractBatch = (id: string) => get<ContractBatch>(`/import/contract-batches/${id}`)

export const confirmContractRow = (batchId: string, rowId: string, body: ConfirmRowBody) =>
  post<ConfirmRowResult>(`/import/contract-batches/${batchId}/rows/${rowId}/confirm`, body)

export const confirmSafeRows = (batchId: string) =>
  post<BulkConfirmResult>(`/import/contract-batches/${batchId}/confirm-safe`, {})

export const skipContractRow = (batchId: string, rowId: string) =>
  post<{ rowId: string; rowStatus: string }>(
    `/import/contract-batches/${batchId}/rows/${rowId}/skip`,
    {},
  )

export const cancelContractBatch = (id: string) => del(`/import/contract-batches/${id}`)
