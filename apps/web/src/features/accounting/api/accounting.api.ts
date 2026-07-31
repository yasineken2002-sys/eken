import { get, post } from '@/lib/api'
import type { Account, JournalEntry } from '@eken/shared'

export const fetchAccounts = (): Promise<Account[]> => get<Account[]>('/accounting/accounts')

export const seedAccounts = (): Promise<{ message: string }> =>
  post<{ message: string }>('/accounting/accounts/seed')

export const fetchJournalEntries = (filters?: {
  from?: string
  to?: string
  source?: string
}): Promise<JournalEntry[]> =>
  get<JournalEntry[]>('/accounting/journal', filters as Record<string, unknown> | undefined)

export const fetchJournalEntry = (id: string): Promise<JournalEntry> =>
  get<JournalEntry>(`/accounting/journal/${id}`)

// ── Bokföringsperioder (T5 PR1a) ─────────────────────────────────────────────
// Stängningen fanns tidigare bara som AI-verktyg. Spärren mot att bokföra i en
// stängd period är oförändrad och ligger kvar i backend (allocate).

export interface PeriodCheck {
  code: string
  severity: 'blocking' | 'warning'
  message: string
  count: number
}

export interface PeriodOverviewItem {
  year: number
  month: number
  closed: boolean
  closedAt: string | null
}

export interface PeriodOverview {
  items: PeriodOverviewItem[]
  lastClosed: { year: number; month: number } | null
  open: Array<{ year: number; month: number }>
}

export interface PeriodSummary {
  month: number
  year: number
  revenue: number
  expenses: number
  result: number
  entriesCount: number
  generatedAt: string
}

export interface PeriodPrecheck {
  year: number
  month: number
  alreadyClosed: boolean
  canClose: boolean
  checks: PeriodCheck[]
  vatPeriods: string[]
}

export const fetchPeriods = (months?: number): Promise<PeriodOverview> =>
  get<PeriodOverview>('/accounting/periods', months ? { months } : undefined)

export const fetchPeriodPrecheck = (year: number, month: number): Promise<PeriodPrecheck> =>
  get<PeriodPrecheck>(`/accounting/periods/${year}/${month}/precheck`)

export const closePeriod = (
  year: number,
  month: number,
): Promise<{ year: number; month: number; summary: PeriodSummary; checks: PeriodCheck[] }> =>
  post(`/accounting/periods/${year}/${month}/close`)
