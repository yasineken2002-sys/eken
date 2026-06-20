import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateMeterInput, UpdateMeterInput } from '@eken/shared'
import { fetchMeters, fetchMeter, createMeter, updateMeter } from '../api/meters.api'
import type { MeterFilters } from '../api/meters.api'

// Disjunkta query-nycklar: list-mutationer får aldrig invalidera detail-queries
// och vice versa (['meters', filters] för lista vs ['meter', id] för detalj).
const METERS_LIST = (filters?: MeterFilters) => ['meters', filters ?? {}] as const
const METER_DETAIL = (id: string) => ['meter', id] as const

// ─── Queries ─────────────────────────────────────────────────────────────────

export function useMeters(filters?: MeterFilters) {
  return useQuery({
    queryKey: METERS_LIST(filters),
    queryFn: () => fetchMeters(filters),
  })
}

export function useMeter(id: string | null) {
  return useQuery({
    queryKey: id ? METER_DETAIL(id) : ['meter', '__disabled__'],
    queryFn: () => fetchMeter(id!),
    enabled: !!id,
  })
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateMeter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateMeterInput) => createMeter(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['meters'] })
    },
  })
}

export function useUpdateMeter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & UpdateMeterInput) => updateMeter(id, dto),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['meters'] })
      void qc.invalidateQueries({ queryKey: METER_DETAIL(variables.id) })
    },
  })
}
