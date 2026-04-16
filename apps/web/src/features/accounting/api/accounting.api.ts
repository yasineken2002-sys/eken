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
