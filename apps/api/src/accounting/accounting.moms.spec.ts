/**
 * FIX 9 · PR 3 — Momshantering bostad/lokal (LAGBROTT 5, ML 1994:200).
 *
 * vatRateForRent kodifierar momssatsen per upplåtelsetyp:
 *   • Bostad (APARTMENT)          → 0 % alltid (ML 3 kap 2 §; frivillig
 *     skattskyldighet får aldrig avse stadigvarande bostad, 3 kap 3 § 2 st).
 *   • Lokal (OFFICE/RETAIL)       → 0 %, eller 25 % vid frivillig skattskyldighet.
 *   • Parkering (PARKING)         → 25 % (momspliktig enligt ML 3 kap 3 § 5).
 *   • Förråd/övrigt (STORAGE/OTHER) → 0 %, eller 25 % vid frivillig skattskyldighet.
 */

import type { UnitType } from '@prisma/client'
import { vatRateForRent } from './accounting.service'

describe('FIX 9 · PR 3 — vatRateForRent', () => {
  it('bostad är alltid momsfri — även om voluntaryTaxLiability av misstag är true', () => {
    expect(vatRateForRent('APARTMENT', false)).toBe(0)
    expect(vatRateForRent('APARTMENT', true)).toBe(0)
  })

  it('parkering är momspliktig (25%) oavsett frivillig skattskyldighet', () => {
    expect(vatRateForRent('PARKING', false)).toBe(25)
    expect(vatRateForRent('PARKING', true)).toBe(25)
  })

  it.each<[UnitType]>([['OFFICE'], ['RETAIL'], ['STORAGE'], ['OTHER']])(
    '%s: momsfri utan frivillig skattskyldighet',
    (type) => {
      expect(vatRateForRent(type, false)).toBe(0)
    },
  )

  it.each<[UnitType]>([['OFFICE'], ['RETAIL'], ['STORAGE'], ['OTHER']])(
    '%s: 25%% med frivillig skattskyldighet',
    (type) => {
      expect(vatRateForRent(type, true)).toBe(25)
    },
  )

  it('okänd/saknad typ → 0 (säker default)', () => {
    expect(vatRateForRent(null, true)).toBe(0)
    expect(vatRateForRent(undefined, true)).toBe(0)
  })
})
