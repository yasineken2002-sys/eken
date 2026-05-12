import { get, post } from '@/lib/api'
import type { SubscriptionPlan, OrgStatus } from '@eken/shared'

export interface AiUsageCurrent {
  plan: SubscriptionPlan
  planName: string
  planDescription: string
  status: OrgStatus
  used: number
  limit: number
  percentage: number
  resetsAt: string
  creditsBalance: number
  trialEndsAt: string | null
  planStartedAt: string
  monthlyFee: number
  maxObjects: number
}

export interface AiUsageHistoryRow {
  date: string
  manualCalls: number
  automatedCalls: number
  costUsd: number
}

export interface BuyCreditsResult {
  invoiceId: string
  invoiceNumber: string
  amountNetSek: number
  amountGrossSek: number
  credits: number
  dueDate: string
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
}

export function getAiUsageCurrent(): Promise<AiUsageCurrent> {
  return get<AiUsageCurrent>('/ai-usage/current')
}

export function getAiUsageHistory(days = 30): Promise<AiUsageHistoryRow[]> {
  return get<AiUsageHistoryRow[]>(`/ai-usage/history?days=${days}`)
}

export function buyAiCredits(amount: 100 | 500 | 1000): Promise<BuyCreditsResult> {
  return post<BuyCreditsResult>('/ai-usage/buy-credits', { amount })
}
