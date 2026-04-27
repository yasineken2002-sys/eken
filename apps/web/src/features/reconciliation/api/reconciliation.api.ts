import { api, get, patch, post } from '@/lib/api'
import type { BankTransaction, ImportResult, ReconciliationStats } from '@eken/shared'

export type BankFormat = 'GENERIC' | 'HANDELSBANKEN' | 'SEB' | 'SWEDBANK'

export interface AutoMatchResult {
  matched: number
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

export async function manualMatch(transactionId: string, invoiceId: string): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/match`, { invoiceId })
}

export async function ignoreTransaction(transactionId: string): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/ignore`, {})
}

export async function unmatchTransaction(transactionId: string): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/unmatch`, {})
}
