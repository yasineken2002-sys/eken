import type { UnitType } from '../types'

/**
 * DEN ENDA MOMSKÄLLAN FÖR HYRA PER UPPLÅTELSE — flyttad hit oförändrad från
 * apps/api/src/accounting/accounting.service.ts (som re-exporterar den), så att
 * webbens fakturaformulär förväljer samma sats som servern kräver.
 * Regeln och dess kommentar är ordagrant desamma som före flytten.
 */
// Tillämplig momssats (%) för hyresintäkt per upplåtelsetyp (ML 2023:200):
//   • Bostad (APARTMENT)         → 0 %. Undantagen moms (ML 10 kap. 35 §). Frivillig
//     beskattning får ALDRIG avse stadigvarande bostad (ML 12 kap. 5 §) —
//     därför alltid 0 % oavsett voluntaryTaxLiability.
//   • Lokal (OFFICE/RETAIL)      → 0 % som huvudregel; 25 % endast vid frivillig
//     beskattning (ML 12 kap. 5 §).
//   • Parkering (PARKING)        → 25 %. Momspliktig enligt lag (ML 10 kap. 36 §),
//     oberoende av frivillig skattskyldighet. Gäller fristående p-plats; ingår
//     platsen i en bostadsupplåtelse hör den till APARTMENT-enheten.
//   • Förråd/övrigt (STORAGE/OTHER) → 0 % som huvudregel; 25 % vid frivillig
//     beskattning (konservativ tolkning — fristående förvaringsbox kan vara
//     momspliktig enligt ML 10 kap. 36 § 6, men kräver då explicit beskattning).
export function vatRateForRent(
  type: UnitType | null | undefined,
  voluntaryTaxLiability: boolean,
): number {
  switch (type) {
    case 'APARTMENT':
      return 0
    case 'PARKING':
      return 25
    case 'OFFICE':
    case 'RETAIL':
    case 'STORAGE':
    case 'OTHER':
      return voluntaryTaxLiability ? 25 : 0
    default:
      return 0
  }
}

/**
 * PÅVERKAR FRIVILLIG SKATTSKYLDIGHET SATSEN FÖR DEN HÄR UPPLÅTELSETYPEN?
 *
 * Härledd UR `vatRateForRent` ovan — ingen egen typlista och ingen egen
 * skatteregel. Svaret är sant exakt när regeln ger olika sats med och utan
 * flaggan (i dag lokaler, förråd och övrigt). För bostad och parkering ger
 * flaggan ingen skillnad, och därför erbjuds den inte där: ett reglage som
 * inte kan ändra något vore ett påstående som ingen läser.
 *
 * Läses av objektformuläret (om reglaget visas) och av API:ts skrivväg (om
 * `true` får sparas). Ändras regeln följer båda med.
 */
export function frivilligSkattskyldighetPaverkarSatsen(type: UnitType | null | undefined): boolean {
  return vatRateForRent(type, true) !== vatRateForRent(type, false)
}
