import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  importBankStatement,
  getTransactions,
  getReconciliationStats,
  manualMatch,
  ignoreTransaction,
  unmatchTransaction,
} from '../api/reconciliation.api'

export function useTransactions(filters?: { status?: string; from?: string; to?: string }) {
  return useQuery({
    queryKey: ['reconciliation', 'list', filters],
    queryFn: () => getTransactions(filters),
    staleTime: 60_000,
  })
}

export function useReconciliationStats() {
  return useQuery({
    queryKey: ['reconciliation', 'stats'],
    queryFn: getReconciliationStats,
    staleTime: 60_000,
  })
}

export function useImportStatement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => importBankStatement(file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
    },
  })
}

export function useManualMatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, invoiceId }: { transactionId: string; invoiceId: string }) =>
      manualMatch(transactionId, invoiceId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
    },
  })
}

export function useIgnoreTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (transactionId: string) => ignoreTransaction(transactionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
    },
  })
}

export function useUnmatchTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (transactionId: string) => unmatchTransaction(transactionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
    },
  })
}
