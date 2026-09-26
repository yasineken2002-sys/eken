import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchUnits, fetchUnit, createUnit, updateUnit, deleteUnit } from '../api/units.api'
import type { CreateUnitInput } from '../api/units.api'

// Disjunkta query-nycklar – list-mutationer får inte invalidera detail-queries.
const UNITS_LIST = (propertyId?: string) => ['units', 'list', propertyId ?? ''] as const
const UNIT_DETAIL = (id: string) => ['unit', 'detail', id] as const

export function useUnits(propertyId?: string) {
  return useQuery({
    queryKey: UNITS_LIST(propertyId),
    queryFn: () => fetchUnits(propertyId),
  })
}

export function useUnit(id: string | null) {
  return useQuery({
    queryKey: id ? UNIT_DETAIL(id) : ['unit', 'detail', '__disabled__'],
    queryFn: () => fetchUnit(id!),
    enabled: !!id,
  })
}

function invalidateUnits(qc: ReturnType<typeof useQueryClient>, deletedId?: string) {
  void qc.invalidateQueries({ queryKey: ['units', 'list'] })
  void qc.invalidateQueries({ queryKey: ['properties', 'list'] })
  if (deletedId) qc.removeQueries({ queryKey: UNIT_DETAIL(deletedId) })
}

export function useCreateUnit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateUnitInput) => createUnit(dto),
    onSuccess: () => invalidateUnits(queryClient),
  })
}

export function useUpdateUnit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreateUnitInput>) => updateUnit(id, dto),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['units', 'list'] })
      void queryClient.invalidateQueries({ queryKey: UNIT_DETAIL(variables.id) })
      // R1 (#933) — AVTALSUNDERLAGET BÄR OBJEKTET. Avtalslistan och avtalsdetaljen
      // inkluderar enheten (typ, frivillig skattskyldighet), och fakturaformulärets
      // momsförval läser just därifrån. Med appens staleTime (60 s) låg listan kvar
      // som färsk efter en flaggsparning, och nästa faktura förvalde den GAMLA
      // satsen — som servern sedan avvisar. Samma nycklar som useLeases.ts.
      void queryClient.invalidateQueries({ queryKey: ['leases', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['lease', 'detail'] })
    },
  })
}

export function useDeleteUnit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteUnit(id),
    onSuccess: (_data, id) => invalidateUnits(queryClient, id),
  })
}
