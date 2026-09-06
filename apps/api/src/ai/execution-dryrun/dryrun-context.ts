import { typenFörFörslaget } from '../delegation/delegation-birth'

import type { DelegationKontext } from '../delegation/delegation.service'

/**
 * FALLET SOM DELEGATIONSGRINDEN SKA PRÖVAS MOT.
 *
 * ── VARFÖR INTE `förifylltVillkor` ─────────────────────────────────────────
 *
 * De två ser ut att göra samma sak och gör motsatta saker. `förifylltVillkor`
 * bygger ett VILLKOR — den rätt hyresvärden ger — och utelämnar därför medvetet
 * `propertyId` när `unitId` finns: lägenheten ligger i fastigheten, och två fält
 * där ett räcker gör rätten svårare att läsa.
 *
 * Det här bygger en KONTEXT — det konkreta fallet grinden mäter villkoret mot.
 * `villkoretMatchar` kräver att varje SATT nyckel i villkoret matchar kontexten,
 * så en kontext som saknar `propertyId` gör en delegation avgränsad till
 * fastigheten till en icke-träff. Utfallet hade varit `NO_DELEGATION` för en
 * rätt som faktiskt täcker fallet — alltså ett facit som säger att hyresvärden
 * inte gett något hen har gett.
 *
 * Kontexten bär därför BÅDA. Samma skillnad som CLAUDE.md:s regel om att
 * återanvända ett fält som svarar på en annan fråga, fast en nivå upp: två
 * funktioner, två frågor, gemensam härledning av typen.
 *
 * ── BELOPPET SAKNAS, OCH DET ÄR FAIL-CLOSED ────────────────────────────────
 *
 * Skuggförslagen på felanmälan bär inget belopp. `villkoretMatchar` behandlar
 * ett saknat belopp mot ett satt `maxBelopp` som en icke-träff — fail-closed —
 * så en delegation med beloppstak ger `NO_DELEGATION` här. Det är rätt utfall:
 * en rätt som är villkorad av ett belopp kan inte prövas av ett fall som inte
 * har ett.
 */
export function kontextFörFörslag(a: {
  prediction: unknown
  propertyId: string | null
  unitId: string | null
}): DelegationKontext {
  const typ = typenFörFörslaget(a.prediction)
  return {
    ...(typ ? { kategori: typ } : {}),
    ...(a.unitId ? { unitId: a.unitId } : {}),
    ...(a.propertyId ? { propertyId: a.propertyId } : {}),
  }
}
