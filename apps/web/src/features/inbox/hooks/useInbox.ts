import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  decideInboxItem,
  fetchInbox,
  fetchInboxSummary,
  fetchKanDelegera,
  skapaDelegationUrForslag,
} from '../api/inbox.api'

import type { AssignmentStatus } from '../api/inbox.api'

// Disjunkta nycklar per filter — annars skriver en filtrerad lista över den
// ofiltrerade i cachen.
const LIST = ['inbox', 'list'] as const
const SUMMARY = ['inbox', 'summary'] as const

export function useInbox(status?: AssignmentStatus) {
  return useQuery({
    queryKey: [...LIST, status ?? 'alla'],
    queryFn: () => fetchInbox(status ? { status } : {}),
    staleTime: 30_000,
  })
}

export function useInboxSummary() {
  return useQuery({ queryKey: SUMMARY, queryFn: fetchInboxSummary, staleTime: 30_000 })
}

export function useDecideInboxItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: decideInboxItem,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST })
      // KPI-korten räknas serverside och måste följa med beslutet — annars
      // visar "väntande" ett tal som just blev fel.
      void qc.invalidateQueries({ queryKey: SUMMARY })
      // Kallelsen ligger i notisklockan. Beslutar man här ska räknaren följa med.
      void qc.invalidateQueries({ queryKey: ['notifications'] })
      // `/uppdrag` läser samma rader.
      void qc.invalidateQueries({ queryKey: ['assignments'] })
    },
  })
}

/**
 * Kan förslaget bli en delegation?
 *
 * `enabled` på ett id: frågan ställs bara när en rad är öppen, och aldrig för ett
 * förslag som inte är godkänt — knappen finns inte där ändå.
 */
export function useKanDelegera(assignmentId: string | null, aktivt: boolean) {
  return useQuery({
    queryKey: ['inbox', 'kanDelegera', assignmentId ?? 'ingen'],
    queryFn: () => fetchKanDelegera(assignmentId as string),
    enabled: Boolean(assignmentId) && aktivt,
    staleTime: 30_000,
  })
}

export function useSkapaDelegation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: skapaDelegationUrForslag,
    onSuccess: () => {
      // Knappen ska bli grå direkt: förslaget har nu blivit en delegation.
      void qc.invalidateQueries({ queryKey: ['inbox', 'kanDelegera'] })
      void qc.invalidateQueries({ queryKey: ['delegationer'] })
    },
  })
}
