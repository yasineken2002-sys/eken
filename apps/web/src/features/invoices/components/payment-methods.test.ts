import { describe, expect, it } from 'vitest'
import { PaymentMethodSchema } from '@eken/shared'
import { ALLA_METODER, BETALSATT, ETIKETTER, metodForEtikett } from './payment-methods'

describe('BETALSATT — översättning, inte en andra sanning', () => {
  it('varje metod är ett giltigt enumvärde', () => {
    // Ersätter det gamla `toPaymentMethod`-provet. Skillnaden: mappningen bor
    // numera på klienten och SKICKAS som enum, i stället för att servern gissar
    // ur fri text.
    for (const b of BETALSATT) {
      expect(PaymentMethodSchema.safeParse(b.metod).success).toBe(true)
    }
  })

  it('de tre giroformerna är alla BANK — och det är avsiktligt', () => {
    expect(metodForEtikett('Bankgiro')).toBe('BANK')
    expect(metodForEtikett('Plusgiro')).toBe('BANK')
    expect(metodForEtikett('Autogiro')).toBe('BANK')
  })

  it('Swish och Kontant har egna värden', () => {
    expect(metodForEtikett('Swish')).toBe('SWISH')
    expect(metodForEtikett('Kontant')).toBe('CASH')
  })

  it('okänd etikett ger MANUAL — men etiketten kastas inte, den följer med som råtext', () => {
    expect(metodForEtikett('Bitcoin')).toBe('MANUAL')
    expect(metodForEtikett('')).toBe('MANUAL')
  })

  it('etiketterna är unika', () => {
    expect(new Set(ETIKETTER).size).toBe(ETIKETTER.length)
  })

  it('KANARIEFÅGEL: enumen har fyra värden — växer den ska listan ses över', () => {
    // Ett nytt enumvärde utan en etikett är inte fel i sig, men det ska vara ett
    // BESLUT. Faller den här har någon utökat enumen utan att titta på listan.
    expect([...ALLA_METODER].sort()).toEqual(['BANK', 'CASH', 'MANUAL', 'SWISH'])
  })
})
