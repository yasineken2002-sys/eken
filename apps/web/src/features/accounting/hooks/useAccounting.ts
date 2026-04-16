import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchAccounts, seedAccounts, fetchJournalEntries } from '../api/accounting.api'

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
