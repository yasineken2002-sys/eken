import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  importBankStatement,
  importBgMaxFile,
  importPdfStatement,
  confirmPdfImport,
  cancelPdfImport,
  getTransactions,
  getReconciliationStats,
  manualMatch,
  ignoreTransaction,
  unmatchTransaction,
  autoMatchAll,
  getBankAccounts,
  createBankAccount,
} from '../api/reconciliation.api'
import type { BankFormat, ParsedTransaction } from '../api/reconciliation.api'
import type { CreateBankAccountInput } from '@eken/shared'

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
    mutationFn: ({
      file,
      bankAccountId,
      bank,
    }: {
      file: File
      // #F034c — obligatoriskt. Servern avvisar en import utan konto.
      bankAccountId: string
      bank?: BankFormat
    }) => {
      const ext = file.name.toLowerCase().split('.').pop() ?? ''
      if (ext === 'txt' || ext === 'bgmax') {
        return importBgMaxFile(file, bankAccountId)
      }
      return importBankStatement(file, bankAccountId, bank)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
      // En auto-matchad transaktion kan ändra Invoice ELLER RentNotice till PAID.
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['avisering'] })
    },
  })
}

// ── PDF-import (AI-tolkning, två steg: upload → confirm) ─────────────────
// useImportPdfStatement laddar upp filen + triggar Claude-tolkning. Returnerar
// DRAFT med extraherade transaktioner. INGA BankTransactions skapas ännu.
export function useImportPdfStatement() {
  return useMutation({
    mutationFn: (file: File) => importPdfStatement(file),
  })
}

// useConfirmPdfImport bekräftar en DRAFT (med ev. redigeringar) och skapar
// BankTransactions som auto-matchas via FIFO. Invaliderar samma queries
// som CSV/BgMax-confirmflödet.
export function useConfirmPdfImport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      importId,
      bankAccountId,
      transactions,
    }: {
      importId: string
      bankAccountId: string
      transactions?: ParsedTransaction[]
    }) => confirmPdfImport(importId, bankAccountId, transactions),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation'] })
      void qc.invalidateQueries({ queryKey: ['invoices'] })
      void qc.invalidateQueries({ queryKey: ['avisering'] })
    },
  })
}

export function useCancelPdfImport() {
  return useMutation({
    mutationFn: (importId: string) => cancelPdfImport(importId),
  })
}

/** #F034c — organisationens målkonton, för väljaren i importmodalen. */
export function useBankAccounts() {
  return useQuery({
    queryKey: ['reconciliation', 'bank-accounts'],
    queryFn: getBankAccounts,
    staleTime: 300_000,
  })
}

export function useCreateBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBankAccountInput) => createBankAccount(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reconciliation', 'bank-accounts'] })
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
