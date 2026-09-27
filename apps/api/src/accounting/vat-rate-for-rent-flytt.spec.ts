import { vatRateForRent as franShared } from '@eken/shared'
import { vatRateForRent as franApi } from './accounting.service'

// FAKTURAVY-RÄTTNINGEN flyttade regeln OFÖRÄNDRAD till @eken/shared så att
// webbens fakturaformulär förväljer samma sats som servern kräver. Provet låser
// två saker: att API:ts export ÄR den delade funktionen (en källa, ingen kopia),
// och hela tabellen, så att flytten inte ändrade ett enda utfall.
describe('vatRateForRent efter flytten till @eken/shared', () => {
  it('API:ts export är samma funktion som den delade — ingen andra momskälla', () => {
    expect(franApi).toBe(franShared)
  })

  it.each([
    ['APARTMENT', false, 0],
    ['APARTMENT', true, 0],
    ['PARKING', false, 25],
    ['PARKING', true, 25],
    ['OFFICE', false, 0],
    ['OFFICE', true, 25],
    ['RETAIL', false, 0],
    ['RETAIL', true, 25],
    ['STORAGE', false, 0],
    ['STORAGE', true, 25],
    ['OTHER', false, 0],
    ['OTHER', true, 25],
    [null, true, 0],
    [undefined, true, 0],
  ] as const)('%s, frivillig=%s → %i %%', (typ, frivillig, sats) => {
    expect(franApi(typ, frivillig)).toBe(sats)
  })
})
