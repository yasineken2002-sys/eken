import { api, del, get, patch, post } from '@/lib/api'
import type {
  BankTransaction,
  ConfirmImportInput,
  ImportResult,
  ManualMatchInput,
  ReconciliationStats,
} from '@eken/shared'

export type BankFormat = 'GENERIC' | 'HANDELSBANKEN' | 'SEB' | 'SWEDBANK'

export interface AutoMatchResult {
  matched: number
  /** Kördes utan fel men matchade inte — väntar på manuell matchning. */
  unmatched: number
  /** Matchningen KASTADE (bokföringsfel, timeout, DB-fel). Inte samma sak som att
   *  ingen match hittades — se kommentaren i reconciliation.service.ts. */
  failed: number
  /** Bar en OCR som inte löste ut, och beloppsgissades därför inte. Ingår i
   *  `unmatched` — "en ledtråd som inte stämde" är något annat än "ingen ledtråd". */
  skippedUnresolvedOcr: number
}

// ─── PDF-import (AI-tolkat kontoutdrag) ──────────────────────────────────────

export interface ParsedTransaction {
  date: string // YYYY-MM-DD
  description: string
  ocr: string | null
  amount: number
  isIncoming: boolean
}

export interface ParsedBankStatement {
  bank: string | null
  accountNumber: string | null
  periodStart: string | null
  periodEnd: string | null
  transactions: ParsedTransaction[]
}

export interface PdfImportDraft {
  id: string
  status: 'PARSING' | 'PARSED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'
  parsed: ParsedBankStatement
}

export interface ImportCommitResult {
  importId: string
  created: number
  duplicates: number
  autoMatched: number
  unmatched: number
}

export async function importBankStatement(file: File, bank?: BankFormat): Promise<ImportResult> {
  const formData = new FormData()
  formData.append('statement', file)
  const url = bank ? `/reconciliation/import?bank=${bank}` : '/reconciliation/import'
  const { data } = await api.post<{ data: ImportResult }>(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.data
}

export async function importBgMaxFile(file: File): Promise<ImportResult & { fileName: string }> {
  const formData = new FormData()
  formData.append('statement', file)
  const { data } = await api.post<{ data: ImportResult & { fileName: string } }>(
    '/reconciliation/import-bgmax',
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data.data
}

export async function autoMatchAll(): Promise<AutoMatchResult> {
  // Ingen kropp: rutten tar inget @Body().
  return post<AutoMatchResult>('/reconciliation/auto-match')
}

export async function getTransactions(filters?: {
  status?: string
  from?: string
  to?: string
}): Promise<BankTransaction[]> {
  return get<BankTransaction[]>('/reconciliation/transactions', filters as Record<string, unknown>)
}

export async function getReconciliationStats(): Promise<ReconciliationStats> {
  return get<ReconciliationStats>('/reconciliation/stats')
}

export async function manualMatch(transactionId: string, target: ManualMatchInput): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/match`, target)
}

export async function ignoreTransaction(transactionId: string): Promise<void> {
  // Ingen kropp: rutten tar inget @Body().
  await patch(`/reconciliation/transactions/${transactionId}/ignore`)
}

export async function unmatchTransaction(transactionId: string): Promise<void> {
  // Ingen kropp: rutten tar inget @Body().
  await patch(`/reconciliation/transactions/${transactionId}/unmatch`)
}

// ─── PDF-import ─────────────────────────────────────────────────────────────

export async function importPdfStatement(file: File): Promise<PdfImportDraft> {
  const formData = new FormData()
  formData.append('statement', file)
  const { data } = await api.post<{ data: PdfImportDraft }>(
    '/reconciliation/import-pdf',
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data.data
}

export async function confirmPdfImport(
  importId: string,
  transactions?: ParsedTransaction[],
): Promise<ImportCommitResult> {
  const kropp: ConfirmImportInput = { ...(transactions ? { transactions } : {}) }
  return post<ImportCommitResult>(`/reconciliation/imports/${importId}/confirm`, kropp)
}

export async function cancelPdfImport(importId: string): Promise<void> {
  await del(`/reconciliation/imports/${importId}`)
}
