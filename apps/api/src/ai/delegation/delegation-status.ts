import type { AiDelegationEventType } from '@prisma/client'

/**
 * DELEGATIONENS TILLSTÅND — BERÄKNAT, aldrig lagrat.
 *
 * Det finns ingen `status`-kolumn på `AiDelegation`, och det är samma hållning
 * som bär resten av systemet: skuld är ett beräknat tillstånd, träffgraden är en
 * fråga, och en delegations status är summan av sina händelser plus klockan.
 *
 * En lagrad status hade kunnat glida isär från händelserna den sammanfattar —
 * en PAUSED som aldrig skrevs, en REVOKED som skrevs två gånger — och den
 * avvikelsen är osynlig. Här kan den inte uppstå.
 *
 * ── ORDNINGEN ÄR SLUTGILTIG FÖRST, SEDAN KLOCKAN ────────────────────────────
 *
 * `REVOKED` vinner över allt: en återkallad delegation kan inte återupptas, bara
 * ersättas av en ny. Därefter avgör tiden — en pausad delegation som passerat
 * sin gräns är UTGÅNGEN och inte pausad, eftersom den inte kan återupptas till
 * något giltigt. Sist gäller den senaste PAUSED/RESUMED.
 */
export type DelegationStatus = 'AKTIV' | 'PAUSAD' | 'ÅTERKALLAD' | 'UTGÅNGEN'

export interface DelegationHändelse {
  type: AiDelegationEventType
  createdAt: Date
}

export function beräknaStatus(
  händelser: readonly DelegationHändelse[],
  expiresAt: Date,
  nu: Date = new Date(),
): DelegationStatus {
  // SLUTGILTIGT FÖRST. En återkallelse går inte att ta tillbaka, så den vinner
  // oavsett vad som skrevs efteråt — och att den kan skrivas efteråt är just
  // varför ordningen står här och inte underförstås av en sortering.
  if (händelser.some((h) => h.type === 'REVOKED')) return 'ÅTERKALLAD'

  // SEDAN KLOCKAN. `EXPIRED`-händelsen är ett KVITTO på att systemet såg det,
  // inte sanningen — utan den här raden hade en delegation vars pass inte hunnit
  // köra räknats som aktiv, och grinden hade släppt igenom den.
  if (expiresAt.getTime() <= nu.getTime()) return 'UTGÅNGEN'

  // SIST den senaste paus/återupptagning. Sorteringen är på tid och inte på
  // insättningsordning: två händelser i samma millisekund är inte ett läge
  // koden ska ha en åsikt om, men en lista i fel ordning är det.
  const senaste = [...händelser]
    .filter((h) => h.type === 'PAUSED' || h.type === 'RESUMED')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .at(-1)
  if (senaste?.type === 'PAUSED') return 'PAUSAD'

  return 'AKTIV'
}
