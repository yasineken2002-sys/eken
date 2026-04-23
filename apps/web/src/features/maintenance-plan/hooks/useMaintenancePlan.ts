import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchPlans,
  fetchYearlySummary,
  fetchPlan,
  createPlan,
  updatePlan,
  deletePlan,
} from '../api/maintenance-plan.api'
import type {
  MaintenancePlanFilter,
  CreateMaintenancePlanInput,
  UpdateMaintenancePlanInput,
} from '../api/maintenance-plan.api'

export function usePlans(filters?: MaintenancePlanFilter) {
  return useQuery({
    queryKey: ['maintenance-plans', filters],
    queryFn: () => fetchPlans(filters),
    staleTime: 60_000,
  })
}

export function useYearlySummary(fromYear: number, toYear: number) {
  return useQuery({
    queryKey: ['maintenance-plans', 'summary', fromYear, toYear],
    queryFn: () => fetchYearlySummary(fromYear, toYear),
    staleTime: 60_000,
  })
}

export function usePlan(id: string | null) {
  return useQuery({
    queryKey: ['maintenance-plans', id],
    queryFn: () => fetchPlan(id!),
    enabled: !!id,
    staleTime: 60_000,
  })
}

export function useCreatePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateMaintenancePlanInput) => createPlan(dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance-plans'] })
    },
  })
}

export function useUpdatePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateMaintenancePlanInput }) =>
      updatePlan(id, dto),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance-plans'] })
    },
  })
}

export function useDeletePlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deletePlan(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['maintenance-plans'] })
    },
  })
}
