import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchActivationStatus,
  fetchTenants,
  fetchTenant,
  resendActivation,
  updateTenant,
} from '../api/tenants.api'
import type { UpdateTenantInput } from '../api/tenants.api'

// Disjunkta query-nycklar så list-invalidering inte träffar detalj-queries.
const TENANTS_LIST = (search?: string) => ['tenants', 'list', search ?? ''] as const
const TENANT_DETAIL = (id: string) => ['tenant', 'detail', id] as const

export const tenantQueryKeys = {
  list: TENANTS_LIST,
  detail: TENANT_DETAIL,
  allLists: () => ['tenants', 'list'] as const,
}

export function useTenants(search?: string) {
  return useQuery({
    queryKey: TENANTS_LIST(search),
    queryFn: () => fetchTenants(search),
  })
}

export function useTenant(id: string | null) {
  return useQuery({
    queryKey: id ? TENANT_DETAIL(id) : ['tenant', 'detail', '__disabled__'],
    queryFn: () => fetchTenant(id!),
    enabled: !!id,
  })
}

// Skapande/borttagning av hyresgäster sker inte längre via denna feature.
// Hyresgäster skapas via useCreateLeaseWithTenant (LeaseForm) och tas bort
// indirekt när alla deras kontrakt avslutas + är fakturafria.

export function useUpdateTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & UpdateTenantInput) => updateTenant(id, dto),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: tenantQueryKeys.allLists() })
      void queryClient.invalidateQueries({ queryKey: TENANT_DETAIL(variables.id) })
    },
  })
}

// ── Portal-aktivering ───────────────────────────────────────────────────────

const ACTIVATION_STATUS = (tenantId: string) => ['tenant', 'activation-status', tenantId] as const

export function useTenantActivationStatus(tenantId: string | null) {
  return useQuery({
    queryKey: tenantId ? ACTIVATION_STATUS(tenantId) : ['tenant', 'activation-status', '__none__'],
    queryFn: () => fetchActivationStatus(tenantId!),
    enabled: !!tenantId,
  })
}

export function useResendActivation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tenantId: string) => resendActivation(tenantId),
    onSuccess: (_data, tenantId) => {
      void queryClient.invalidateQueries({ queryKey: ACTIVATION_STATUS(tenantId) })
    },
  })
}
