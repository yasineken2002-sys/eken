import { get, patch, post } from '@/lib/api'
import type {
  CreateDepositInput,
  RefundDepositInput,
  Deposit,
  DepositStatus,
  Tenant,
} from '@eken/shared'

export type DepositDetail = Deposit & {
  lease: {
    id: string
    monthlyRent: number
    unit: { id: string; name: string; property: { id: string; name: string } }
  }
  tenant: Tenant
  invoice?: { id: string; invoiceNumber: string; status: string; total: number } | null
}

export function fetchDeposits(filters?: {
  status?: DepositStatus
  leaseId?: string
}): Promise<DepositDetail[]> {
  return get<DepositDetail[]>('/deposits', filters as Record<string, unknown> | undefined)
}

export function fetchDeposit(id: string): Promise<DepositDetail> {
  return get<DepositDetail>(`/deposits/${id}`)
}

export function createDeposit(dto: CreateDepositInput): Promise<DepositDetail> {
  return post<DepositDetail>('/deposits', dto)
}

export function markDepositPaid(id: string): Promise<DepositDetail> {
  // Ingen kropp: rutten tar inget @Body(). Ett tomt objekt hade sett ut som
  // en nyttolast utan att vara en.
  return patch<DepositDetail>(`/deposits/${id}/pay`)
}

export function refundDeposit(id: string, dto: RefundDepositInput): Promise<DepositDetail> {
  return patch<DepositDetail>(`/deposits/${id}/refund`, dto)
}
