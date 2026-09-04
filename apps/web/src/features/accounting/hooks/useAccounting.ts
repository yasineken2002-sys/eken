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
  reverseJournalEntry,
  fetchFiscalYears,
  fetchFiscalYearClosePreview,
  closeFiscalYear,
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

// ── Rättelse av verifikat (T5 PR1c2) ─────────────────────────────────────────

/**
 * Rättar ett verifikat. Invaliderar journalen (både originalet och rättelsen
 * ändrar hur listan ser ut) och periodens förhandskontroll (rättelsen är ett
 * nytt verifikat i innevarande period).
 */
export function useReverseJournalEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => reverseJournalEntry(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'journal'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-precheck'] })
    },
    meta: { handlesOwnError: true },
  })
}

// ── Årsstängning (#704 PR 3) ─────────────────────────────────────────────────

/**
 * Räkenskapsårens läge. Billig fråga — två databasfrågor oavsett antal år — och
 * körs därför på sidladdning, till skillnad från förhandsvisningen.
 */
export function useFiscalYears(years?: number) {
  return useQuery({
    queryKey: ['accounting', 'fiscal-years', years ?? 3],
    queryFn: () => fetchFiscalYears(years),
  })
}

/**
 * Det FÖRESLAGNA årsavslutsverifikatet, rad för rad.
 *
 * Hämtas först när dialogen öppnas: den läser hela kontoplanen, grupperar årets
 * journalrader per konto och kör månad tolvs precheck. Samma beräkning som
 * stängningen sedan bokför — det är hela poängen med att de delar kod, och det
 * är därför dialogen kan visa exakt de rader som kommer att skrivas.
 */
export function useFiscalYearClosePreview(fiscalYear: number | null) {
  return useQuery({
    queryKey: ['accounting', 'fiscal-year-preview', fiscalYear],
    queryFn: () => fetchFiscalYearClosePreview(fiscalYear as number),
    enabled: fiscalYear != null,
  })
}

/**
 * Stänger räkenskapsåret. OÅTERKALLELIGT — det finns ingen väg tillbaka, varken
 * i UI:t eller i backend.
 *
 * Invalideringen är bred med flit: stängningen bokför ett verifikat (journalen),
 * stänger årets sista månad (periodöversikten och dess precheck) och låser året
 * (korten och periodhistoriken). En utebliven invalidering hade lämnat sidan i
 * ett läge som ser ut som att ingenting hände.
 */
export function useCloseFiscalYear() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ fiscalYear }: { fiscalYear: number }) => closeFiscalYear(fiscalYear),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounting', 'fiscal-years'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'fiscal-year-preview'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'periods'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-precheck'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'period-history'] })
      void qc.invalidateQueries({ queryKey: ['accounting', 'journal'] })
    },
    meta: { handlesOwnError: true },
  })
}
