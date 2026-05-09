import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  importBankStatement,
  importBgMaxFile,
  getTransactions,
  getReconciliationStats,
  manualMatch,
  ignoreTransaction,
  unmatchTransaction,
  autoMatchAll,
} from '../api/reconciliation.api'
import type { BankFormat } from '../api/reconciliation.api'

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
    // Filändelsen styr endpoint: .txt → BgMax, .csv/.xlsx/.xls → bankutdrag.
    // Detekteringen ligger här istället för i UI så alla anrop (inkl. drag-
    // and-drop, programmatic) får samma routing.
    mutationFn: ({ file, bank }: { file: File; bank?: BankFormat }) => {
      const ext = file.name.toLowerCase().split('.').pop() ?? ''
      if (ext === 'txt' || ext === 'bgmax') {
        return importBgMaxFile(file)
      }
      return importBankStatement(file, bank)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
      // En auto-matchad transaktion kan ändra Invoice ELLER RentNotice till PAID.
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['avisering'] })
    },
  })
}

export function useAutoMatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => autoMatchAll(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
    },
  })
}

export function useManualMatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      transactionId,
      invoiceId,
      rentNoticeId,
    }: {
      transactionId: string
      invoiceId?: string
      rentNoticeId?: string
    }) =>
      manualMatch(transactionId, {
        ...(invoiceId ? { invoiceId } : {}),
        ...(rentNoticeId ? { rentNoticeId } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['avisering'] })
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
