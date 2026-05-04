import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchLeases,
  fetchLease,
  createLease,
  updateLease,
  transitionLeaseStatus,
  deleteLease,
  createLeaseWithTenant,
  terminateLease,
  renewLease,
} from '../api/leases.api'
import type {
  CreateLeaseInput,
  CreateLeaseWithTenantInput,
  TerminateLeaseInput,
  RenewLeaseInput,
} from '../api/leases.api'

// Disjunkta query-nycklar – list och detail får inte dela prefix, annars
// invaliderar list-mutationen även disabled detail-queries vilket triggar
// 404-fetchar mot ogiltiga IDs.
const LEASES_LIST = ['leases', 'list'] as const
const LEASE_DETAIL = (id: string) => ['lease', 'detail', id] as const

export function useLeases() {
  return useQuery({ queryKey: LEASES_LIST, queryFn: fetchLeases })
}

export function useLease(id: string | null) {
  return useQuery({
    queryKey: id ? LEASE_DETAIL(id) : ['lease', 'detail', '__disabled__'],
    queryFn: () => fetchLease(id!),
    enabled: !!id,
  })
}

function invalidateLeases(qc: ReturnType<typeof useQueryClient>, deletedId?: string) {
  void qc.invalidateQueries({ queryKey: LEASES_LIST })
  if (deletedId) qc.removeQueries({ queryKey: LEASE_DETAIL(deletedId) })
}

export function useCreateLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createLease,
    onSuccess: () => invalidateLeases(queryClient),
  })
}

export function useUpdateLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreateLeaseInput>) =>
      updateLease(id, dto),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: LEASES_LIST })
      void queryClient.invalidateQueries({ queryKey: LEASE_DETAIL(variables.id) })
    },
  })
}

export function useTransitionLeaseStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      transitionLeaseStatus(id, status),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: LEASES_LIST })
      void queryClient.invalidateQueries({ queryKey: LEASE_DETAIL(variables.id) })
    },
  })
}

export function useDeleteLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteLease,
    onSuccess: (_data, id) => invalidateLeases(queryClient, id),
  })
}

export function useCreateLeaseWithTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateLeaseWithTenantInput) => createLeaseWithTenant(dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LEASES_LIST })
      // Endast list-cachen – matchar inte detalj-queries (['tenant', 'detail', id])
      void queryClient.invalidateQueries({ queryKey: ['tenants', 'list'] })
    },
    // Anroparen visar en kontextuell toast i sin onError — globala
    // MutationCache.onError ska därför inte också toast:a samma fel.
    meta: { handlesOwnError: true },
  })
}

export function useTerminateLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & TerminateLeaseInput) => terminateLease(id, dto),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: LEASES_LIST })
      void queryClient.invalidateQueries({ queryKey: LEASE_DETAIL(variables.id) })
    },
  })
}

export function useRenewLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & RenewLeaseInput) => renewLease(id, dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LEASES_LIST })
    },
  })
}
