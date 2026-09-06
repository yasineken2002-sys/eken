import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { avvisaAntagande, bekraftaAntagande, fetchAntaganden } from '../api/delegationer.api'

const NYCKEL = ['antaganden'] as const

export function useAntaganden() {
  return useQuery({ queryKey: NYCKEL, queryFn: fetchAntaganden, staleTime: 30_000 })
}

/**
 * Två åtgärder, två mutationer — inte en med ett `svar`-fält.
 *
 * `isPending` hade annars gällt båda knapparna på varje rad samtidigt, och
 * raden hade sett ut att göra två saker när den gör en. Samma skäl som
 * radåtgärderna på delegationerna.
 */
function useSvar(fn: (id: string) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NYCKEL })
    },
  })
}

export const useBekraftaAntagande = () => useSvar(bekraftaAntagande)
export const useAvvisaAntagande = () => useSvar(avvisaAntagande)
