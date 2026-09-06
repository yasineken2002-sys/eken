import { get, post } from '@/lib/api'

import type { RevokeDelegationInput } from '@eken/shared'

export type DelegationStatus = 'AKTIV' | 'PAUSAD' | 'ÅTERKALLAD' | 'UTGÅNGEN'

export interface Frekvensvillkor {
  maxAntal: number
  periodDagar: number
}

/**
 * En delegation, som sidan läser den.
 *
 * `status` och `löperUtInomDagar` räknas i API:t och inte här. Två räknare för
 * samma sak hade kunnat säga olika saker — och den som visas för hyresvärden
 * hade då inte varit den som styr om agenten får handla.
 */
export interface Delegation {
  id: string
  toolName: string
  authorityScope: string
  villkor: Record<string, unknown> | null
  frekvensvillkor: Frekvensvillkor | null
  expiresAt: string
  createdAt: string
  status: DelegationStatus
  löperUtInomDagar: number
  /** KÄLLAN: vem som tryckte. Null = användaren finns inte kvar. */
  createdByUserId: string | null
  createdByUser: { firstName: string; lastName: string } | null
  /** KÄLLAN: vilket ärende som födde den. Null = skapad utanför inkorgen. */
  bornFromAssignmentId: string | null
  bornFromAssignment: { id: string; title: string } | null
}

export const fetchDelegationer = () => get<Delegation[]>('/agent/delegations')

/**
 * Återkallandet är den enda av de fyra som bär en nyttolast, och den är typad
 * mot det DELADE schemat — inte mot ett objektliteral. Se
 * `check-request-contract`: en form som beskrivs på två ställen glider isär, och
 * glidningen märks först som ett 400 i produktion.
 */
export const revokeDelegation = (id: string, skäl?: string) => {
  const kropp: RevokeDelegationInput = skäl ? { skäl } : {}
  return post<{ ok: boolean }>(`/agent/delegations/${id}/revoke`, kropp)
}

// Pausa, återuppta och förläng bär INGEN nyttolast: vad som ska hända står i
// URL:en, och ett tomt objekt hade varit en form att hålla i synk utan innehåll.
export const pauseDelegation = (id: string) =>
  post<{ ok: boolean }>(`/agent/delegations/${id}/pause`)

export const resumeDelegation = (id: string) =>
  post<{ ok: boolean }>(`/agent/delegations/${id}/resume`)

export const extendDelegation = (id: string) =>
  post<{ expiresAt: string }>(`/agent/delegations/${id}/extend`)
