import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateTariffInput } from '@eken/shared'
import { fetchTariffs, createTariff } from '../api/tariffs.api'
import type { TariffFilters } from '../api/tariffs.api'

// Disjunkta query-nycklar: ['tariffs', filters] för lista, ['tariff', id] för
// en enskild tariff. Backend har ingen detalj-endpoint ännu — list-nyckeln är
// den enda som hämtas — men nyckelkonventionen hålls disjunkt så en framtida
// detalj-query inte invalideras av list-mutationer.
const TARIFFS_LIST = (filters?: TariffFilters) => ['tariffs', filters ?? {}] as const

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useTariffs(filters?: TariffFilters) {
  return useQuery({
    queryKey: TARIFFS_LIST(filters),
    queryFn: () => fetchTariffs(filters),
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateTariff() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateTariffInput) => createTariff(dto),
    onSuccess: () => {
      // En ny tariff stänger föregående (validTo) → invalidera hela listan.
      void qc.invalidateQueries({ queryKey: ['tariffs'] })
    },
  })
}
