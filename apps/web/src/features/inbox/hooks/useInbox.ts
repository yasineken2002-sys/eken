import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  begarAngra,
  decideInboxItem,
  fetchGjorda,
  fetchInbox,
  fetchInboxSummary,
  fetchKanDelegera,
  skapaDelegationUrForslag,
  svaraPaFraga,
} from '../api/inbox.api'

import type { AssignmentStatus } from '../api/inbox.api'

// Disjunkta nycklar per filter — annars skriver en filtrerad lista över den
// ofiltrerade i cachen.
const LIST = ['inbox', 'list'] as const
const SUMMARY = ['inbox', 'summary'] as const
/** "Gjort" är en EGEN nyckel — den läser andra rader och andra fält än listan. */
const GJORT = ['inbox', 'gjorda'] as const

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

/** De utförda åtgärderna. Egen fråga, egen nyckel — se `GJORT`. */
export function useGjorda() {
  return useQuery({ queryKey: GJORT, queryFn: () => fetchGjorda(), staleTime: 30_000 })
}

/**
 * ÅNGRA-BEGÄRAN.
 *
 * Invaliderar `GJORT` så raden visar att någon sagt ifrån direkt. Den rör INTE
 * `LIST` eller `SUMMARY`: begäran ändrar ingen status och inget KPI-tal — den
 * lägger till en händelse.
 */
export function useBegarAngra() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: begarAngra,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: GJORT })
    },
  })
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
      // Ett beslut kan flytta en rad in i "Gjort" (via utföraren), så den
      // listan är inte längre färsk heller.
      void qc.invalidateQueries({ queryKey: GJORT })
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

/**
 * SVARET PÅ EN FRÅGA.
 *
 * Egen mutation och inte en gren i `useDecideInboxItem`: ett beslut är ja eller
 * nej, ett svar är ett värde ur en mängd, och `isPending` ska inte gälla båda
 * knappuppsättningarna samtidigt.
 */
export function useSvaraPaFraga() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, svar }: { id: string; svar: string }) => svaraPaFraga(id, svar),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    },
  })
}
