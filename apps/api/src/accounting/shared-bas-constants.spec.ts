/**
 * H5 — @eken/shared BAS-konstanter speglar FIX 9 (BAS 2024).
 *
 * Tidigare pekade STANDARD_ACCOUNTS på 3010/2610/2350 (förbjudna efter FIX 9)
 * och ACCOUNT_RANGES.EQUITY på 3000–3999 (intäkter, inte eget kapital). Testet
 * låser fast de korrekta värdena som matchar accounting.service.ts.
 */

import { ACCOUNT_CLASS_RANGES, RENT_REVENUE_ACCOUNTS, CORE_ACCOUNTS } from '@eken/shared'

describe('@eken/shared BAS-konstanter (H5)', () => {
  it('hyresintäktskonton är per upplåtelsetyp (3911–3914)', () => {
    expect(RENT_REVENUE_ACCOUNTS.APARTMENT).toBe(3911)
    expect(RENT_REVENUE_ACCOUNTS.PARKING).toBe(3912)
    expect(RENT_REVENUE_ACCOUNTS.OFFICE).toBe(3913)
    expect(RENT_REVENUE_ACCOUNTS.RETAIL).toBe(3913)
    expect(RENT_REVENUE_ACCOUNTS.STORAGE).toBe(3914)
    expect(RENT_REVENUE_ACCOUNTS.OTHER).toBe(3914)
  })

  it('kärnkonton matchar AccountingService efter FIX 9', () => {
    expect(CORE_ACCOUNTS.DEPOSIT_LIABILITY).toBe(2890) // INTE 2350
    expect(CORE_ACCOUNTS.VAT_OUTPUT_25).toBe(2611) // INTE 2610
    expect(CORE_ACCOUNTS.VAT_OUTPUT_12).toBe(2621)
    expect(CORE_ACCOUNTS.VAT_OUTPUT_6).toBe(2631)
    expect(CORE_ACCOUNTS.ACCOUNTS_RECEIVABLE).toBe(1510)
    expect(CORE_ACCOUNTS.BANK).toBe(1930)
    expect(CORE_ACCOUNTS.CASH).toBe(1910)
  })

  it('kontoklass-intervall har INGEN EQUITY-nyckel (EK bor i klass 2)', () => {
    expect(ACCOUNT_CLASS_RANGES.LIABILITY).toEqual({ min: 2000, max: 2999 })
    expect(ACCOUNT_CLASS_RANGES.REVENUE).toEqual({ min: 3000, max: 3999 })
    expect('EQUITY' in ACCOUNT_CLASS_RANGES).toBe(false)
  })

  it('inga förbjudna FIX 9-konton kvar i intäktskontona', () => {
    const values = Object.values(RENT_REVENUE_ACCOUNTS)
    expect(values).not.toContain(3010)
    expect(values).not.toContain(3001)
  })
})
