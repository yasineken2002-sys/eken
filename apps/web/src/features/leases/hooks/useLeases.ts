import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchLeases,
  fetchLease,
  createLease,
  updateLease,
  transitionLeaseStatus,
  deleteLease,
  createLeaseWithTenant,
} from '../api/leases.api'
import type { CreateLeaseInput, CreateLeaseWithTenantInput } from '../api/leases.api'

export function useLeases() {
  return useQuery({ queryKey: ['leases'], queryFn: fetchLeases })
}

export function useLease(id: string | null) {
  return useQuery({
    queryKey: ['leases', id],
    queryFn: () => fetchLease(id!),
    enabled: !!id,
  })
}

export function useCreateLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createLease,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leases'] }),
  })
}

export function useUpdateLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreateLeaseInput>) =>
      updateLease(id, dto),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leases'] }),
  })
}

export function useTransitionLeaseStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      transitionLeaseStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leases'] }),
  })
}

export function useDeleteLease() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteLease,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leases'] }),
  })
}

export function useCreateLeaseWithTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateLeaseWithTenantInput) => createLeaseWithTenant(dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leases'] })
      void queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
  })
}
