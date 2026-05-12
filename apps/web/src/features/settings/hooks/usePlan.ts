import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  buyAiCredits,
  getAiUsageCurrent,
  getAiUsageHistory,
  type BuyCreditsResult,
} from '../api/plan.api'

export function useAiUsageCurrent() {
  return useQuery({
    queryKey: ['ai-usage', 'current'],
    queryFn: getAiUsageCurrent,
    staleTime: 30_000,
  })
}

export function useAiUsageHistory(days = 30) {
  return useQuery({
    queryKey: ['ai-usage', 'history', days],
    queryFn: () => getAiUsageHistory(days),
    staleTime: 60_000,
  })
}

export function useBuyAiCredits() {
  const qc = useQueryClient()
  return useMutation<BuyCreditsResult, Error, 100 | 500 | 1000>({
    mutationFn: (amount) => buyAiCredits(amount),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-usage'] })
    },
  })
}
