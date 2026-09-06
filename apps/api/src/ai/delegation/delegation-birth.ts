import { SKUGGFALT } from '../shadow/shadow-fields'

import type { DelegationVillkor } from './delegation.service'

/**
 * ── ATT AGENTEN INTE UTFÖR NÅGOT ÄN ÄR ETT FAKTUM, INTE EN MENING ───────────
 *
 * Läsytan säger "Agenten utför fortfarande ingenting förrän utföraren finns", och
 * den meningen är sann bara så länge det INTE finns en utförare. Skriven som ren
 * prosa i en modal hade den blivit kvar den dag etapp 8–9 landar, och då står det
 * en osanning i det enda gränssnitt hyresvärden har för att förstå vad hen ger
 * bort.
 *
 * Konstanten läses av både API:t och webben. Den dag utföraren byggs sätts den
 * till `true` i samma PR som bygger den, och texten försvinner av sig själv.
 *
 * `check-delegation-scope.mjs` kan inte se det här — det är en flagga, inte en
 * form. Det som bär den är att den bor bredvid grinden och inte i en komponent.
 */
export const UTFÖRARE_FINNS = false

/**
 * TYPEN ETT FÖRSLAG GÄLLER — och därmed vad "samma typ" betyder.
 *
 * "Gör alltid så här för den här typen" behöver en typ. Den läses ur förslagets
 * `prediction`, som redan bär agentens bedömning i strukturerad form — och det
 * fältet är `SKUGGFALT[0]` (`category`) och inte en ny uppräkning, så en ändring
 * av vad som mäts följer med hit av sig själv.
 *
 * Returnerar null när förslaget saknar typ. Ett förslag utan typ kan inte bli en
 * delegation: "gör alltid så här" skulle då betyda "gör alltid detta verktyg,
 * alltid", vilket är en helt annan och mycket bredare rätt än den hyresvärden
 * tror sig ge.
 */
export function typenFörFörslaget(prediction: unknown): string | null {
  if (typeof prediction !== 'object' || prediction === null) return null
  const nyckel = SKUGGFALT[0]?.nyckel
  if (!nyckel) return null
  const v = (prediction as Record<string, unknown>)[nyckel]
  return typeof v === 'string' && v !== '' ? v : null
}

/** Nyckeln `SKUGGFALT[0]` bär — exporterad så villkoret kan namnge fältet. */
export const TYPFÄLT = SKUGGFALT[0]?.nyckel ?? 'category'

/**
 * ── VILLKORET FÅR SNÄVAS, ALDRIG VIDGAS ─────────────────────────────────────
 *
 * Scope förifylls ur det konkreta fallet. Hyresvärden får ändra det — men bara
 * åt ett håll. Att kunna vidga det hade gjort knappen "Gör alltid så här" till
 * en väg att ge en bredare rätt än det fall man tittade på, och hela poängen med
 * att delegationen FÖDS ur ett godkännande är att omfånget är det man såg.
 *
 * Reglerna, en per fält:
 *
 *   • Ett fält som är SATT i det förifyllda måste vara satt och LIKA i det
 *     valda. Att ta bort det är att vidga.
 *   • Ett fält som SAKNAS i det förifyllda får läggas till — det snävar.
 *   • `maxBelopp` får sänkas men inte höjas, och får läggas till där det saknas.
 *
 * Returnerar en lista med skäl. Tom lista = snävare eller lika.
 */
export function villkoretSnävas(förifyllt: DelegationVillkor, valt: DelegationVillkor): string[] {
  const fel: string[] = []
  for (const nyckel of ['propertyId', 'unitId', TYPFÄLT] as const) {
    const f = (förifyllt as Record<string, unknown>)[nyckel]
    const v = (valt as Record<string, unknown>)[nyckel]
    if (f === undefined) continue
    if (v === undefined) {
      fel.push(
        `Fältet ${nyckel} är förifyllt ur ärendet och kan inte tas bort — det vidgar rätten.`,
      )
      continue
    }
    if (v !== f) {
      fel.push(`Fältet ${nyckel} kan inte ändras från "${String(f)}" till "${String(v)}".`)
    }
  }
  if (förifyllt.maxBelopp !== undefined) {
    if (valt.maxBelopp === undefined) {
      fel.push('Beloppstaket kan inte tas bort — det vidgar rätten.')
    } else if (valt.maxBelopp > förifyllt.maxBelopp) {
      fel.push(
        `Beloppstaket kan sänkas men inte höjas (${förifyllt.maxBelopp} → ${valt.maxBelopp}).`,
      )
    }
  }
  return fel
}

/** Scope förifyllt ur ett godkänt förslag. Bara fält som FINNS tas med. */
export function förifylltVillkor(assignment: {
  prediction: unknown
  propertyId: string | null
  unitId: string | null
}): DelegationVillkor {
  const ut: DelegationVillkor = {}
  const typ = typenFörFörslaget(assignment.prediction)
  if (typ) (ut as Record<string, unknown>)[TYPFÄLT] = typ
  // OBJEKTET FÖRE FASTIGHETEN: är förslaget knutet till en lägenhet är det den
  // avgränsningen hyresvärden såg. Att lägga till fastigheten också hade varit
  // redundant — lägenheten ligger i den — och två fält där ett räcker gör
  // villkoret svårare att läsa utan att göra det snävare.
  if (assignment.unitId) ut.unitId = assignment.unitId
  else if (assignment.propertyId) ut.propertyId = assignment.propertyId
  return ut
}
