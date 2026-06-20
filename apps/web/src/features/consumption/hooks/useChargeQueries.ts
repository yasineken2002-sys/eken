import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchCharges, fetchCharge, confirmCharge } from '../api/charges.api'
import type { ChargeFilters } from '../api/charges.api'

// Disjunkta nycklar: ['charges', filters] för lista, ['charge', id] för detalj.
const CHARGES_LIST = (filters?: ChargeFilters) => ['charges', filters ?? {}] as const
const CHARGE_DETAIL = (id: string) => ['charge', id] as const

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useCharges(filters?: ChargeFilters) {
  return useQuery({
    queryKey: CHARGES_LIST(filters),
    queryFn: () => fetchCharges(filters),
  })
}

export function useCharge(id: string | null) {
  return useQuery({
    queryKey: id ? CHARGE_DETAIL(id) : ['charge', '__disabled__'],
    queryFn: () => fetchCharge(id!),
    enabled: !!id,
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useConfirmCharge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => confirmCharge(id),
    // Confirm bokför posten (status + verifikat). Invalidera BÅDE listan och den
    // berörda detaljen så en öppen detaljmodal aldrig visar inaktuell status.
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['charges'] })
      void qc.invalidateQueries({ queryKey: CHARGE_DETAIL(id) })
    },
  })
}
