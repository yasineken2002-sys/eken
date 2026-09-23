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
  getIdentityReview,
  createBankAccount,
} from '../api/reconciliation.api'
import type { BankFormat, Bankkonto, ParsedTransaction } from '../api/reconciliation.api'
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

/**
 * G2 — kravpausens läge. Kortare `staleTime` än kontolistan: det här är ett
 * tillstånd operatören AKTIVT arbetar bort, och ett gammalt svar hade visat en
 * paus som just släppts.
 */
export function useIdentityReview() {
  return useQuery({
    queryKey: ['reconciliation', 'identity-review'],
    queryFn: getIdentityReview,
    staleTime: 15_000,
  })
}

/**
 * K1 — lägga upp ett målkonto.
 *
 * ── VARFÖR BÅDE `setQueryData` OCH `invalidateQueries` ──────────────────────
 *
 * Kravet är att listan uppdateras UTAN sidladdning. Enbart invalidering ger det
 * också, men först efter en tur till servern — och under den turen står det
 * nyss skapade kontot inte i väljaren, vars `value` då pekar på ett id som inte
 * finns bland `<option>`-elementen. Webbläsaren visar då ingen markering alls,
 * och operatören som just skapade kontot ser en tom väljare.
 *
 * Cacheskrivningen stänger det glappet; invalideringen står kvar därför att
 * SERVERN äger listan — ordningen (`isActive desc, name asc`) och eventuella
 * rader som skapats av någon annan i samma organisation kommer därifrån, inte
 * härifrån. Den lokala sorteringen speglar serverns bara för att raden inte ska
 * hoppa när svaret kommer.
 */
export function useCreateBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBankAccountInput) => createBankAccount(input),
    onSuccess: (konto) => {
      qc.setQueryData<Bankkonto[]>(['reconciliation', 'bank-accounts'], (gamla) =>
        gamla
          ? [...gamla.filter((k) => k.id !== konto.id), konto].sort(
              (a, b) =>
                Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, 'sv'),
            )
          : [konto],
      )
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
