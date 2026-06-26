import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchMiscCharges,
  fetchMiscCharge,
  createMiscCharge,
  confirmMiscCharge,
  cancelMiscCharge,
} from '../api/misc-charges.api'
import type { MiscChargeFilters, CreateMiscChargeBody } from '../api/misc-charges.api'

// Disjunkta nycklar: ['misc-charges', filters] för lista, ['misc-charge', id] för
// detalj — kolliderar varken med varandra eller med consumptions ['charge', id].
const LIST = (filters?: MiscChargeFilters) => ['misc-charges', filters ?? {}] as const
const DETAIL = (id: string) => ['misc-charge', id] as const

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useMiscCharges(filters?: MiscChargeFilters) {
  return useQuery({
    queryKey: LIST(filters),
    queryFn: () => fetchMiscCharges(filters),
  })
}

export function useMiscCharge(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? DETAIL(id) : ['misc-charge', '__disabled__'],
    queryFn: () => fetchMiscCharge(id!),
    enabled: !!id,
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

// Invaliderar alltid maintenance-cachen också: create sätter MaintenanceTicket.
// chargeId, vilket ändrar ärendets debiterings-tillstånd i panelen.
function invalidateAll(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: ['misc-charges'] })
  if (id) void qc.invalidateQueries({ queryKey: DETAIL(id) })
  void qc.invalidateQueries({ queryKey: ['maintenance'] })
}

export function useCreateMiscCharge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateMiscChargeBody) => createMiscCharge(body),
    onSuccess: (charge) => invalidateAll(qc, charge.id),
  })
}

export function useConfirmMiscCharge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => confirmMiscCharge(id),
    onSuccess: (_data, id) => invalidateAll(qc, id),
  })
}

export function useCancelMiscCharge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => cancelMiscCharge(id),
    onSuccess: (_data, id) => invalidateAll(qc, id),
  })
}
