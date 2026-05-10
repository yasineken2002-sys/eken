import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth.store'
import {
  getDashboardStats,
  getDashboardTimeseries,
  type DashboardPeriod,
} from '../api/dashboard.api'

export function useDashboardStats() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: getDashboardStats,
    enabled: isAuthenticated,
    staleTime: 30_000,
  })
}

export function useDashboardTimeseries(period: DashboardPeriod) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery({
    queryKey: ['dashboard', 'timeseries', period],
    queryFn: () => getDashboardTimeseries(period),
    enabled: isAuthenticated,
    // Backend cachar 5min — kort staleTime räcker så toggle mellan perioder
    // refetchar inte i onödan, men nya månader hämtas vid mount.
    staleTime: 60_000,
  })
}
