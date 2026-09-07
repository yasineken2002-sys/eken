import { api, get, post, patch } from '@/lib/api'
import type {
  AssignContractorInput,
  CancelWorkOrderInput,
  CreateContractorInput,
  MaintenanceCategoryValue,
  SendWorkOrderInput,
  UpdateContractorInput,
  WorkOrderResponseInput,
} from '@eken/shared'

/**
 * KONTRAKTEN KOMMER UR @eken/shared FRÅN BÖRJAN.
 *
 * Nyttolasttyperna är `z.infer`-typerna, inte egna interfaces — så den här
 * filen kan inte hamna i `request-contract.baseline.json`. Skärps schemat
 * blir webben röd vid kompilering i stället för 400 i drift.
 *
 * SVARSTYPEN är däremot lokal, och det är rätt: den beskriver vad API:t
 * RETURNERAR, inte vad webben skickar. Kontraktsvakten mäter skrivriktningen.
 */
export interface Contractor {
  id: string
  organizationId: string
  name: string
  contactPerson: string | null
  email: string | null
  phone: string | null
  orgNumber: string | null
  categories: MaintenanceCategoryValue[]
  notes: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface ContractorFilters {
  category?: MaintenanceCategoryValue
  activeOnly?: boolean
}

export function fetchContractors(filters?: ContractorFilters): Promise<Contractor[]> {
  const params: Record<string, string> = {}
  if (filters?.category) params['category'] = filters.category
  if (filters?.activeOnly) params['activeOnly'] = 'true'
  return get<Contractor[]>('/contractors', params)
}

export function fetchContractor(id: string): Promise<Contractor> {
  return get<Contractor>(`/contractors/${id}`)
}

export function createContractor(input: CreateContractorInput): Promise<Contractor> {
  return post<Contractor>('/contractors', input)
}

export function updateContractor(id: string, input: UpdateContractorInput): Promise<Contractor> {
  return patch<Contractor>(`/contractors/${id}`, input)
}

export async function deleteContractor(id: string): Promise<{ id: string; ärendenTömda: number }> {
  const { data } = await api.delete<{ data: { id: string; ärendenTömda: number } }>(
    `/contractors/${id}`,
  )
  return data.data
}

/** PATCH /maintenance/:id/assign — `contractorId: null` betyder avtilldela. */
export function assignContractor(ticketId: string, input: AssignContractorInput) {
  return patch<{ id: string; assignedContractorId: string | null }>(
    `/maintenance/${ticketId}/assign`,
    input,
  )
}

// ─── Arbetsorder (PR 2) ──────────────────────────────────────────────────────

export interface WorkOrder {
  id: string
  ticketId: string
  contractorId: string
  status: 'SENT' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED'
  subject: string
  sentToEmail: string
  sharedTenantContact: string | null
  expiresAt: string
  respondedAt: string | null
  proposedAt: string | null
  responseNote: string | null
  createdAt: string
}

export function sendWorkOrder(ticketId: string, input: SendWorkOrderInput): Promise<WorkOrder> {
  return post<WorkOrder>(`/maintenance/${ticketId}/work-orders`, input)
}

export function cancelWorkOrder(id: string, input: CancelWorkOrderInput): Promise<WorkOrder> {
  return post<WorkOrder>(`/work-orders/${id}/cancel`, input)
}

/**
 * Hantverkarens svar. PUBLIK — anropas från svarssidan utan inloggning, och
 * token i sökvägen är den enda behörigheten.
 */
export function respondToWorkOrder(token: string, input: WorkOrderResponseInput) {
  return post<{ status: string }>(`/work-orders/${token}/respond`, input)
}
