import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  extendDelegation,
  fetchDelegationer,
  pauseDelegation,
  resumeDelegation,
  revokeDelegation,
} from '../api/delegationer.api'

const LISTA = ['delegationer'] as const

export function useDelegationer() {
  return useQuery({ queryKey: LISTA, queryFn: fetchDelegationer, staleTime: 30_000 })
}

/**
 * Fyra åtgärder, fyra `useMutation` — inte en med ett `slag`-fält.
 *
 * `isPending` hade annars gällt alla fyra knapparna samtidigt, och raden hade
 * sett ut att göra fyra saker när den gör en. De delar däremot
 * ogiltigförklaring: varje åtgärd ändrar den beräknade statusen, och statusen
 * är det enda listan visar som inte går att härleda ur raden själv.
 */
function useÅtgärd<A>(fn: (arg: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LISTA })
      // Inkorgens knapp läser samma tillstånd: en återkallad delegation ska
      // kunna födas på nytt ur ett nytt godkännande, och knappen där ska inte
      // stå kvar grå tills sidan laddas om.
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    },
  })
}

export const useRevokeDelegation = () =>
  useÅtgärd(({ id, skäl }: { id: string; skäl?: string | undefined }) => revokeDelegation(id, skäl))
export const usePauseDelegation = () => useÅtgärd(pauseDelegation)
export const useResumeDelegation = () => useÅtgärd(resumeDelegation)
export const useExtendDelegation = () => useÅtgärd(extendDelegation)
