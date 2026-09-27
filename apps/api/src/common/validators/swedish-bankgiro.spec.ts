/**
 * K2 — `validateSwedishBankgiro` (@eken/shared).
 *
 * De fyra mätpunkterna uppdraget kräver — SAKNAT, BLANKT, KÄNT OGILTIGT och
 * GILTIGT — plus de två fällorna som gör att en naiv implementation ser rätt ut:
 *
 *   1. `0000-0000` passerar modulus-10. Kontrollsiffran kan alltså ALDRIG avvisa
 *      provets påhittade mål; det krävs en egen regel.
 *   2. `luhnChecksum` i samma paket är en ANNAN funktion än standard-Luhn och
 *      avvisar varje verkligt bankgiro. Provet nedan fäller en "förenkling" som
 *      byter ut kontrollen mot den.
 */

import { validateSwedishBankgiro, luhnChecksum } from '@eken/shared'

/**
 * Bankgironummer som går att kontrollera UTIFRÅN, inte påhittade av mig.
 * `5050-1055` är Skatteverkets skattekonto; de tre 90-kontona är publika
 * insamlingskonton. De finns här för att kontrollen ska mätas mot verkligheten
 * och inte mot sin egen aritmetik.
 */
const VERKLIGA = ['5050-1055', '900-8004', '901-9514', '902-0900']

describe('validateSwedishBankgiro — de fyra mätpunkterna', () => {
  it('SAKNAT: null och undefined är inget betalningsmål', () => {
    for (const v of [null, undefined]) {
      const r = validateSwedishBankgiro(v)
      expect(r.valid).toBe(false)
      expect(r.error).toMatch(/saknas/i)
    }
  })

  it('BLANKT: tom sträng och enbart blanktecken likaså', () => {
    for (const v of ['', '   ', '\t']) {
      expect(validateSwedishBankgiro(v).valid).toBe(false)
    }
  })

  it('KÄNT OGILTIGT: 0000-0000 avvisas — provets påhittade mål', () => {
    const r = validateSwedishBankgiro('0000-0000')
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/nollor/i)
  })

  it('GILTIGT: verkliga bankgironummer godtas och normaliseras', () => {
    expect(validateSwedishBankgiro('5050-1055')).toEqual({
      valid: true,
      normalized: '5050-1055',
    })
    // Utan bindestreck och med blanktecken — samma nummer, samma svar.
    expect(validateSwedishBankgiro('50501055').normalized).toBe('5050-1055')
    expect(validateSwedishBankgiro(' 5050 1055 ').normalized).toBe('5050-1055')
    // Sjusiffrigt normaliseras till XXX-XXXX.
    expect(validateSwedishBankgiro('9008004').normalized).toBe('900-8004')
  })
})

describe('validateSwedishBankgiro — fällorna', () => {
  it('kontrollsiffran ensam kan INTE avvisa enbart nollor', () => {
    // Mätningen som motiverar den egna nollregeln. Går den här sönder är det
    // för att någon bytt kontrollsiffrefunktion — inte för att regeln är onödig.
    expect(luhnChecksum('0000000')).toBe(0)
    // Och standard-Luhn säger samma sak: summan är noll, noll modulo tio är noll.
    const summa = '00000000'.split('').reduce((a, c) => a + Number(c), 0)
    expect(summa % 10).toBe(0)
  })

  it('kontrollen är INTE luhnChecksum — den hade avvisat varje verkligt bankgiro', () => {
    // NEGATIV REFERENS, och den är hela poängen: skulle någon "återanvända"
    // luhnChecksum här blir den här raden röd innan koden hinner ut till en kund.
    for (const bg of VERKLIGA) {
      const siffror = bg.replace('-', '')
      const enligtLuhnChecksum = luhnChecksum(siffror.slice(0, -1)) === Number(siffror.slice(-1))
      expect(enligtLuhnChecksum).toBe(false)
      // …medan den riktiga kontrollen godtar dem.
      expect(validateSwedishBankgiro(bg).valid).toBe(true)
    }
  })

  it('fel längd avvisas åt båda hållen', () => {
    expect(validateSwedishBankgiro('900800').valid).toBe(false) // 6 siffror
    expect(validateSwedishBankgiro('505010551').valid).toBe(false) // 9 siffror
    expect(validateSwedishBankgiro('900800').error).toMatch(/siffror/i)
  })

  it('fel kontrollsiffra avvisas', () => {
    // 5050-1055 är giltigt; varje annan sista siffra ska falla.
    for (let d = 0; d <= 9; d++) {
      const kandidat = `5050105${d}`
      expect(validateSwedishBankgiro(kandidat).valid).toBe(d === 5)
    }
  })

  it('icke-siffror avvisas — och tyst städning får inte dölja dem', () => {
    expect(validateSwedishBankgiro('5050-105X').valid).toBe(false)
    expect(validateSwedishBankgiro('BG 5050-1055').valid).toBe(false)
  })
})
