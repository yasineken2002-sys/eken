import { useQuery } from '@tanstack/react-query'
import { get } from '@/lib/api'

/**
 * Funktionsflaggor som gränssnittet behöver FÖRE inloggning.
 *
 * Endpointen är `@Public()` och bär bara booleaner — se
 * `apps/api/src/public/public-config.controller.ts` för vad som får stå där och
 * varför den inte lades i `/v1/health`.
 *
 * `staleTime: Infinity`: en funktionsflagga ändras genom en omdeploy, inte under
 * en session. Att polla den hade lagt ett anrop på varje sidladdning utan att
 * kunna se en ändring som inte ändå kräver en ny flik.
 *
 * FEL BEHANDLAS SOM "AV". Kan vi inte fråga vet vi inte, och en knapp som kanske
 * inte fungerar ska inte visas — samma fail-closed-hållning som flaggan har på
 * serversidan.
 */
export interface PublicFeatureFlags {
  bankId: boolean
}

const AV: PublicFeatureFlags = { bankId: false }

export function usePublicFeatures(): PublicFeatureFlags {
  const { data } = useQuery({
    queryKey: ['public-config'],
    queryFn: () => get<{ features: PublicFeatureFlags }>('/public/config'),
    staleTime: Infinity,
    retry: 1,
  })
  return data?.features ?? AV
}
