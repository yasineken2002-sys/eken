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
