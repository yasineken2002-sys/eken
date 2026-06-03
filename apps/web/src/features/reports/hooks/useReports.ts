import { useQuery } from '@tanstack/react-query'
import { fetchBalanceSheet, fetchProfitLoss, fetchVatReport } from '../api/reports.api'

export function useProfitLoss(params: { from: string; to: string }, enabled: boolean) {
  return useQuery({
    queryKey: ['accounting', 'report', 'profit-loss', params],
    queryFn: () => fetchProfitLoss(params),
    enabled,
  })
}

export function useBalanceSheet(asOf: string, enabled: boolean) {
  return useQuery({
    queryKey: ['accounting', 'report', 'balance-sheet', asOf],
    queryFn: () => fetchBalanceSheet(asOf),
    enabled,
  })
}

export function useVatReport(params: { from: string; to: string }, enabled: boolean) {
  return useQuery({
    queryKey: ['accounting', 'report', 'vat', params],
    queryFn: () => fetchVatReport(params),
    enabled,
  })
}
