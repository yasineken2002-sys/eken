import type { Traffgrad } from '../api/inbox.api'

/**
 * KONFIDENSENS BADGE-VARIANT — en SIGNAL, inte ett tillstånd.
 *
 * Skalan är grön/gul/röd med flit. Ett neutralt grått hade sagt "det här är ett
 * läge", och det är precis fel: talet är agentens eget påstående om hur säker
 * den är, och hyresvärden ska kunna se på färgen om förslaget är värt att lita
 * på utan att läsa siffran. Se CLAUDE.md: signalfärgerna är reserverade för
 * faktiska signaler — det här ÄR en.
 *
 * `null` är inte 0. En modell som inte svarat på frågan har inte sagt att den
 * är osäker, och 0,0 hade lästs som "säker på att den hade fel".
 */
export type KonfidensVariant = 'success' | 'warning' | 'danger' | 'default'

export function konfidensVariant(v: number | null | undefined): KonfidensVariant {
  if (v === null || v === undefined) return 'default'
  if (v >= 0.8) return 'success'
  if (v >= 0.6) return 'warning'
  return 'danger'
}

/** `0,72` med svenskt decimaltecken, eller `—` när modellen inte svarat. */
export function formatKonfidens(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * TRÄFFGRADEN ÖVER ALLA FÄLT, som en procentsträng — eller `—`.
 *
 * `—` OCH INTE `0 %` när inget facit finns. De två betyder helt olika saker:
 * "ingen har avslutat ett ärende än" mot "agenten hade fel varje gång", och att
 * visa noll för det första hade fått en fungerande agent att se trasig ut på
 * sin första dag.
 *
 * Talet vägs över FÄLT och inte över rader: varje fält bär sin egen nämnare,
 * eftersom ett facit kan svara på kategori men inte på tilldelning.
 */
export function formatTraffgrad(t: Record<string, Traffgrad> | undefined): string {
  if (!t) return '—'
  let besvarade = 0
  let traffar = 0
  for (const v of Object.values(t)) {
    besvarade += v.besvarade
    traffar += v.traffar
  }
  if (besvarade === 0) return '—'
  return `${Math.round((traffar / besvarade) * 100)} %`
}
