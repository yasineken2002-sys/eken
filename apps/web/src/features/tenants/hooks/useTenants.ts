import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchTenants,
  fetchTenant,
  createTenant,
  updateTenant,
  deleteTenant,
} from '../api/tenants.api'
import type { CreateTenantInput } from '@eken/shared'

export function useTenants(search?: string) {
  return useQuery({
    queryKey: ['tenants', search],
    queryFn: () => fetchTenants(search),
  })
}

export function useTenant(id: string | null) {
  return useQuery({
    queryKey: ['tenants', id],
    queryFn: () => fetchTenant(id!),
    enabled: !!id,
  })
}

export function useCreateTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateTenantInput) => createTenant(dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
  })
}

export function useUpdateTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & Partial<CreateTenantInput>) =>
      updateTenant(id, dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
  })
}

export function useDeleteTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteTenant(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
  })
}
