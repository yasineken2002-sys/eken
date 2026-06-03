import { get, patch, post } from '@/lib/api'
import type { KeyHandover, KeyStatus, KeyType } from '@eken/shared'

export type KeyHandoverDetail = KeyHandover & {
  unit?: { id: string; name: string; unitNumber: string }
}

export interface IssueKeysInput {
  leaseId: string
  type: KeyType
  quantity: number
  label?: string
  issuedToName?: string
  issuedAt?: string
  notes?: string
}

export interface ReturnKeyInput {
  returnedAt?: string
  notes?: string
}

export interface UpdateKeyInput {
  status?: Extract<KeyStatus, 'LOST' | 'REPLACED'>
  type?: KeyType
  label?: string
  issuedToName?: string
  notes?: string
}

export function fetchKeys(filters?: {
  leaseId?: string
  unitId?: string
  status?: KeyStatus
}): Promise<KeyHandoverDetail[]> {
  return get<KeyHandoverDetail[]>('/keys', filters as Record<string, unknown> | undefined)
}

// Bulk-utlämning: backend skapar `quantity` rader och returnerar dem.
export function issueKeys(dto: IssueKeysInput): Promise<KeyHandoverDetail[]> {
  return post<KeyHandoverDetail[]>('/keys', dto)
}

export function returnKey(id: string, dto: ReturnKeyInput): Promise<KeyHandoverDetail> {
  return patch<KeyHandoverDetail>(`/keys/${id}/return`, dto)
}

export function updateKey(id: string, dto: UpdateKeyInput): Promise<KeyHandoverDetail> {
  return patch<KeyHandoverDetail>(`/keys/${id}`, dto)
}
