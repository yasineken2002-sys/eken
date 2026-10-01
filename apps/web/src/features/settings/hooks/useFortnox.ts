import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth.store'
import { connectFortnox, disconnectFortnox, getFortnoxStatus } from '../api/fortnox.api'

export function useFortnox() {
  const user = useAuthStore((state) => state.user)
  const organization = useAuthStore((state) => state.organization)
  const client = useQueryClient()
  const allowed = user?.role === 'OWNER' || user?.role === 'ADMIN'
  // Include organization and principal to prevent a cached panel crossing a session boundary.
  const queryKey = ['fortnox', 'status', organization?.id, user?.id, user?.role] as const
  const status = useQuery({
    queryKey,
    queryFn: getFortnoxStatus,
    enabled: allowed && Boolean(organization?.id),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.latestRead?.status === 'RUNNING' && !query.state.error ? 3_000 : false,
  })
  const connect = useMutation({ mutationFn: connectFortnox, retry: false })
  const disconnect = useMutation({
    mutationFn: disconnectFortnox,
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey })
    },
  })
  return { status, connect, disconnect }
}
