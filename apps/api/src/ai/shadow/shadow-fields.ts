/**
 * SKUGGLÄGETS JÄMFÖRBARA FÄLT — deklarerade på ETT ställe.
 *
 * ── VARFÖR EN DEKLARATION OCH INTE TVÅ UPPRÄKNINGAR ─────────────────────────
 *
 * Träffgraden är `antal där prediction[f] === outcome[f]` delat med `antal
 * besvarade`. Två sidor av samma jämförelse skrivs alltså på två ställen —
 * producenten som fyller `prediction`, facitvägen som fyller `outcome` — och
 * skulle de glida isär blir utfallet inte ett fel utan en TYSTNAD: ett fält som
 * bara finns på ena sidan räknas aldrig, och träffgraden ser rimlig ut medan den
 * mäter färre fält än den påstår.
 *
 * Därför är mängden en konstant som båda läser, och `shadow-hit-rate.spec.ts`
 * kräver att varje fält som förekommer i något `prediction`-objekt står här.
 *
 * ── VARFÖR JUST DE HÄR TRE ──────────────────────────────────────────────────
 *
 * De är de tre besluten en människa faktiskt fattar när en felanmälan kommer in
 * och som går att läsa ur ärendet efteråt utan tolkning:
 *
 *   kategori    `MaintenanceTicket.category`  — enum, jämförs exakt
 *   prioritet   `MaintenanceTicket.priority`  — enum, jämförs exakt
 *   tilldelad   `MaintenanceTicket.assignedToId` — naken `String?` utan
 *               relation; planen säger uttryckligen att hantverkarbokning inte
 *               ingår förrän den är utredd. Fältet jämförs ändå, som TEXT, och
 *               det är avsiktligt: det mäter om agenten gissar rätt person, inte
 *               om bokningen finns.
 *
 * "Svar till hyresgäst" är MED FLIT inte ett jämförbart fält. Två olika men lika
 * goda svar är olika strängar, och en exakt jämförelse hade mätt formulering i
 * stället för riktighet. Att bedöma det kräver en människa — och det är precis
 * vad godkännandet i inkorgen ÄR.
 */

/** Ett fält som jämförs mellan förslag och facit. */
export interface Skuggfalt {
  /** Nyckeln i både `prediction` och `outcome`. */
  nyckel: string
  /** Svensk etikett för läsytan. */
  etikett: string
}

export const SKUGGFALT: readonly Skuggfalt[] = [
  { nyckel: 'category', etikett: 'Kategori' },
  { nyckel: 'priority', etikett: 'Prioritet' },
  { nyckel: 'assignedToId', etikett: 'Tilldelad' },
] as const

export const SKUGGFALT_NYCKLAR: readonly string[] = SKUGGFALT.map((f) => f.nyckel)

/** Vad skuggkörningen producerades ur. En sträng, inte en enum — se schemat. */
export const SKUGGKALLA_FELANMALAN = 'MAINTENANCE_TICKET'

/** Träffgrad för ETT fält, och för helheten. Beräknad, aldrig lagrad. */
export interface Traffgrad {
  /** Antal rader där facit finns — nämnaren. */
  besvarade: number
  /** Antal rader där förslag och facit är lika. */
  traffar: number
  /** `traffar / besvarade`, eller null när ingen besvarats. */
  andel: number | null
}

/**
 * Jämför ett förslag mot ett facit, fält för fält.
 *
 * ── NULL PÅ NÅGONDERA SIDAN RÄKNAS INTE ─────────────────────────────────────
 *
 * Saknar facit ett fält vet vi inte vad som var rätt; saknar förslaget ett fält
 * gissade agenten inte. Att räkna endera som en MISS hade gjort träffgraden till
 * ett mått på hur fullständigt facit fylldes i — vilket är en egenskap hos
 * människan, inte hos agenten.
 *
 * Nämnaren per fält är alltså "antal fall där BÅDA sidorna svarat", och den
 * redovisas därför separat per fält i stället för som ett gemensamt tal.
 */
export function jamforSkuggfalt(
  prediction: Record<string, unknown> | null | undefined,
  outcome: Record<string, unknown> | null | undefined,
): Record<string, boolean | null> {
  const ut: Record<string, boolean | null> = {}
  for (const { nyckel } of SKUGGFALT) {
    const p = prediction?.[nyckel]
    const o = outcome?.[nyckel]
    if (p === undefined || p === null || o === undefined || o === null) {
      ut[nyckel] = null
      continue
    }
    ut[nyckel] = String(p) === String(o)
  }
  return ut
}

/** Träffgrad per fält över en mängd rader. */
export function traffgradPerFalt(
  rader: ReadonlyArray<{
    prediction: Record<string, unknown> | null
    outcome: Record<string, unknown> | null
  }>,
): Record<string, Traffgrad> {
  const ut: Record<string, Traffgrad> = {}
  for (const { nyckel } of SKUGGFALT) ut[nyckel] = { besvarade: 0, traffar: 0, andel: null }
  for (const rad of rader) {
    const j = jamforSkuggfalt(rad.prediction, rad.outcome)
    for (const { nyckel } of SKUGGFALT) {
      const v = j[nyckel]
      if (v === null || v === undefined) continue
      const t = ut[nyckel]!
      t.besvarade++
      if (v) t.traffar++
    }
  }
  for (const { nyckel } of SKUGGFALT) {
    const t = ut[nyckel]!
    t.andel = t.besvarade === 0 ? null : t.traffar / t.besvarade
  }
  return ut
}
