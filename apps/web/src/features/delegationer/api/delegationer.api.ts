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
  /**
   * TORRLÄGETS FACIT (etapp 8): hur många skuggförslag som HADE utförts enligt
   * den här rätten. Räknas i API:t, inte här — det är samma tal som
   * frekvensvillkoret förbrukar, och två räknare för samma sak hade kunnat säga
   * olika saker om samma delegation.
   */
  skulleHaUtlöst: number
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

/**
 * ── ANTAGANDENA (etapp 8) ────────────────────────────────────────────────────
 *
 * Det systemet TROR men ingen har sagt. Motsvarigheten till delegationerna, som
 * är det hyresvärden HAR gett bort — planens "se vad systemet tror om hen",
 * andra halvan.
 */
export interface Antagande {
  id: string
  key: string
  value: string
  type: 'preference' | 'fact' | 'relationship' | 'convention'
  createdAt: string
  updatedAt: string
}

export const fetchAntaganden = () => get<Antagande[]>('/ai/memory/assumptions')

// INGEN NYTTOLAST: vad som ska hända står i URL:en. Ett tomt objekt hade varit
// en form att hålla i synk utan innehåll — se `check-request-contract`.
export const bekraftaAntagande = (id: string) => post<void>(`/ai/memory/assumptions/${id}/confirm`)

export const avvisaAntagande = (id: string) => post<void>(`/ai/memory/assumptions/${id}/reject`)
