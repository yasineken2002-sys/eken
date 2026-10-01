import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth.store'
import { fetchProperties } from '@/features/properties/api/properties.api'
import { getFortnoxCatalog, saveFortnoxMapping, startFortnoxRead } from '../api/fortnox.api'

export function useFortnoxCatalog(financialYearId: number | null, companyNumber: number) {
  const user = useAuthStore((state) => state.user)
  const organization = useAuthStore((state) => state.organization)
  const client = useQueryClient()
  const scope = [organization?.id, user?.id, user?.role] as const
  const enabled = Boolean(organization?.id) && (user?.role === 'OWNER' || user?.role === 'ADMIN')
  const catalog = useQuery({
    queryKey: ['fortnox', 'catalog', ...scope, companyNumber, financialYearId],
    queryFn: () => getFortnoxCatalog(financialYearId),
    enabled,
    retry: false,
    staleTime: 0,
  })
  const properties = useQuery({
    queryKey: ['fortnox', 'own-properties', ...scope],
    queryFn: fetchProperties,
    enabled,
    retry: false,
    staleTime: 0,
  })
  const refreshStatus = async () => {
    await client.invalidateQueries({
      queryKey: ['fortnox', 'status', ...scope],
    })
  }
  const read = useMutation({
    mutationFn: startFortnoxRead,
    retry: false,
    onSuccess: refreshStatus,
  })
  const mapping = useMutation({
    mutationFn: saveFortnoxMapping,
    retry: false,
    onSuccess: refreshStatus,
  })
  return {
    catalog,
    properties,
    read,
    mapping,
    organizationId: organization?.id,
  }
}
