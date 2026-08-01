import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchAccounts,
  seedAccounts,
  fetchJournalEntries,
  fetchPeriods,
  fetchPeriodPrecheck,
  fetchPeriodHistory,
  closePeriod,
  reopenPeriod,
} from '../api/accounting.api'

export function useAccounts() {
  return useQuery({
    queryKey: ['accounting', 'accounts'],
    queryFn: fetchAccounts,
  })
}

export function useSeedAccounts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: seedAccounts,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'accounts'] })
    },
  })
}

export function useJournalEntries(filters?: { from?: string; to?: string; source?: string }) {
  return useQuery({
    queryKey: ['accounting', 'journal', filters],
    queryFn: () => fetchJournalEntries(filters),
  })
}

// ── Bokföringsperioder (T5 PR1a) ─────────────────────────────────────────────

export function usePeriods(months?: number) {
  return useQuery({
    queryKey: ['accounting', 'periods', months ?? 12],
    queryFn: () => fetchPeriods(months),
  })
}

// Förhandskontrollen hämtas först när en period valts för stängning — den kör
// flera aggregerade queries och ska inte gå på varje sidladdning.
export function usePeriodPrecheck(period: { year: number; month: number } | null) {
  return useQuery({
    queryKey: ['accounting', 'period-precheck', period?.year, period?.month],
    queryFn: () => fetchPeriodPrecheck(period!.year, period!.month),
    enabled: period != null,
  })
}

export function useClosePeriod() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ year, month }: { year: number; month: number }) => closePeriod(year, month),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'periods'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-precheck'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-history'] })
    },
    meta: { handlesOwnError: true },
  })
}

// ── Återöppning (T5 PR1c) ────────────────────────────────────────────────────

/** Historik + underlag för dialogen. Hämtas först när en period valts. */
export function usePeriodHistory(period: { year: number; month: number } | null) {
  return useQuery({
    queryKey: ['accounting', 'period-history', period?.year, period?.month],
    queryFn: () => fetchPeriodHistory(period!.year, period!.month),
    enabled: period != null,
  })
}

export function useReopenPeriod() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: reopenPeriod,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'periods'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-precheck'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-history'] })
    },
    meta: { handlesOwnError: true },
  })
}
