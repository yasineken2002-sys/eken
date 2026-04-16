import { useQuery } from '@tanstack/react-query'
import { getDashboardStats } from '../api/dashboard.api'

export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: getDashboardStats,
    staleTime: 30_000,
  })
}
