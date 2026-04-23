import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth.store'
import { getDashboardStats } from '../api/dashboard.api'

export function useDashboardStats() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: getDashboardStats,
    enabled: isAuthenticated,
    staleTime: 30_000,
  })
}
