import { api, del, get, patch, post } from '@/lib/api'
import type { BankTransaction, ImportResult, ReconciliationStats } from '@eken/shared'

export type BankFormat = 'GENERIC' | 'HANDELSBANKEN' | 'SEB' | 'SWEDBANK'

export interface AutoMatchResult {
  matched: number
  unmatched: number
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
  return post<AutoMatchResult>('/reconciliation/auto-match', {})
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

export async function manualMatch(
  transactionId: string,
  target: { invoiceId?: string; rentNoticeId?: string },
): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/match`, target)
}

export async function ignoreTransaction(transactionId: string): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/ignore`, {})
}

export async function unmatchTransaction(transactionId: string): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/unmatch`, {})
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
  return post<ImportCommitResult>(`/reconciliation/imports/${importId}/confirm`, {
    ...(transactions ? { transactions } : {}),
  })
}

export async function cancelPdfImport(importId: string): Promise<void> {
  await del(`/reconciliation/imports/${importId}`)
}
