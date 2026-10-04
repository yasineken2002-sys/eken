import type { UnitType } from '../types'

/**
 * DEN ENDA KÄLLAN FÖR HYRESINTÄKTSKONTO PER UPPLÅTELSETYP — flyttad hit OFÖRÄNDRAD från
 * apps/api/src/accounting/accounting.service.ts (som re-exporterar den), så att Fortnox-
 * exportens intäktsgrind (TESTKUND-006) härleder samma konto som bokföringen utan att
 * fortnox-modulen importerar bokföringstjänsten. Värdena och kommentaren är desamma som före.
 */
// BAS 2024-konto för hyresintäkt per upplåtelsetyp. Avgör vilket 39xx-konto
// en hyresfaktura/-avi krediteras mot. Bostäder (3911) är undantagna moms
// (ML 10 kap. 35 §); lokaler (3913) kan vara momspliktiga vid frivillig
// beskattning (ML 12 kap.). Saknas koppling till en Unit används 3914
// (övriga rörelseintäkter) som säker fallback.
const REVENUE_ACCOUNT_BY_UNIT_TYPE: Record<UnitType, number> = {
  APARTMENT: 3911,
  PARKING: 3912,
  OFFICE: 3913,
  RETAIL: 3913,
  STORAGE: 3914,
  OTHER: 3914,
}
export const DEFAULT_REVENUE_ACCOUNT = 3914

export function revenueAccountForUnitType(type: UnitType | null | undefined): number {
  return type ? REVENUE_ACCOUNT_BY_UNIT_TYPE[type] : DEFAULT_REVENUE_ACCOUNT
}
