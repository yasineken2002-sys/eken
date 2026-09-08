export type { IssueKeysInput, ReturnKeyInput, UpdateKeyInput } from '@eken/shared'
import { get, patch, post } from '@/lib/api'
import type {
  KeyHandover,
  KeyStatus,
  IssueKeysInput,
  ReturnKeyInput,
  UpdateKeyInput,
} from '@eken/shared'

export type KeyHandoverDetail = KeyHandover & {
  unit?: { id: string; name: string; unitNumber: string }
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
