import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchUnits, fetchUnit, createUnit, updateUnit, deleteUnit } from '../api/units.api'
import type { CreateUnitInput } from '../api/units.api'

export function useUnits(propertyId?: string) {
  return useQuery({
    queryKey: ['units', propertyId ?? null],
    queryFn: () => fetchUnits(propertyId),
  })
}

export function useUnit(id: string | null) {
  return useQuery({
    queryKey: ['units', id],
    queryFn: () => fetchUnit(id!),
    enabled: !!id,
  })
}

export function useCreateUnit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateUnitInput) => createUnit(dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['units'] })
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
    },
  })
}

export function useUpdateUnit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreateUnitInput>) => updateUnit(id, dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['units'] })
    },
  })
}

export function useDeleteUnit() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteUnit(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['units'] })
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
    },
  })
}
