import { describe, expect, it } from 'vitest'
import {
  beraknaSaldo,
  momsAvBrutto,
  tolkaBelopp,
  verifikatFel,
  type RadUtkast,
} from './entry-balance'

/**
 * Modalens saldoräkning. Webs vitest kör med `environment: 'node'` och
 * renderar ingenting, så provet ställs mot de rena funktionerna — vilket är
 * hela skälet till att räkningen bor utanför komponenten.
 *
 * Nolltoleransen ska vara SAMMA som serverns (ett öre). Ett prov som tillät mer
 * hade gjort knappen klickbar för något backend avvisar med 422.
 */

const rad = (accountNumber: string, debit = '', credit = ''): RadUtkast => ({
  accountNumber,
  debit,
  credit,
})

describe('tolkaBelopp', () => {
  it('tomt, blanktecken och skräp blir 0 — aldrig NaN', () => {
    // Ett NaN i totalen hade gjort saldot oläsbart medan man skriver, och
    // `balanserar` falskt på ett sätt man inte kan skriva sig ur.
    expect(tolkaBelopp('')).toBe(0)
    expect(tolkaBelopp(undefined)).toBe(0)
    expect(tolkaBelopp('   ')).toBe(0)
    expect(tolkaBelopp('abc')).toBe(0)
  })

  it('ett HALVSKRIVET tal läses som det som står — saldot uppdateras medan man skriver', () => {
    // `'12,'` blir `'12.'` och `Number('12.')` är 12, inte NaN. Det är rätt
    // beteende och står här som ett PÅSTÅENDE i stället för att upptäckas av
    // nästa person: fälten är fritext, och ett saldo som blev 0 mitt i ett tal
    // hade sett ut som att inmatningen inte fungerar.
    expect(tolkaBelopp('12,')).toBe(12)
    expect(tolkaBelopp('12,5')).toBe(12.5)
  })

  it('komma är decimaltecken — svenskt tangentbord', () => {
    expect(tolkaBelopp('1234,50')).toBe(1234.5)
  })

  it('mellanslag som tusentalsavgränsare tolereras', () => {
    expect(tolkaBelopp('1 234,50')).toBe(1234.5)
  })

  it('negativa tal blir 0 — riktningen bestäms av kolumnen, inte av tecknet', () => {
    expect(tolkaBelopp('-100')).toBe(0)
  })
})

describe('beraknaSaldo', () => {
  it('summerar debet och kredit var för sig', () => {
    const s = beraknaSaldo([rad('1930', '1000'), rad('3011', '', '600'), rad('3011', '', '400')])
    expect(s.debet).toBe(1000)
    expect(s.kredit).toBe(1000)
    expect(s.differens).toBe(0)
    expect(s.balanserar).toBe(true)
    expect(s.radermedBelopp).toBe(3)
  })

  it('ett TOMT formulär balanserar INTE — 0 = 0 är inget besked', () => {
    // Kravet är att verifikatet går att bokföra, inte att två nollor är lika.
    const s = beraknaSaldo([rad('', ''), rad('', '')])
    expect(s.balanserar).toBe(false)
    expect(s.radermedBelopp).toBe(0)
  })

  it('differensens TECKEN säger vilken sida som saknas', () => {
    const saknarKredit = beraknaSaldo([rad('1930', '1000'), rad('3011', '', '900')])
    expect(saknarKredit.differens).toBeCloseTo(100, 2)

    const saknarDebet = beraknaSaldo([rad('1930', '900'), rad('3011', '', '1000')])
    expect(saknarDebet.differens).toBeCloseTo(-100, 2)
  })

  it('ETT ÖRE är en obalans — samma nolltolerans som serverns C1-grind', () => {
    const s = beraknaSaldo([rad('1930', '1000'), rad('3011', '', '999.99')])
    expect(s.balanserar).toBe(false)
  })

  it('MOTPROV: en HALV öre avrundas bort — jämförelsen är i hela ören', () => {
    // Skiljer "exakt jämförelse" från "en tolerans mindre än ett öre".
    const s = beraknaSaldo([rad('1930', '1000'), rad('3011', '', '999.995')])
    expect(s.balanserar).toBe(true)
  })

  it('flyttalsbruset fäller inte ett verifikat som balanserar i ören', () => {
    // 0.1 + 0.2 === 0.30000000000000004.
    const s = beraknaSaldo([rad('1930', '0.1'), rad('1930', '0.2'), rad('3011', '', '0.3')])
    expect(s.balanserar).toBe(true)
  })
})

describe('verifikatFel — knappens villkor och felmeddelandet är samma svar', () => {
  const IDAG = '2026-09-05'

  it('balanserat verifikat ger null', () => {
    expect(verifikatFel([rad('1930', '100'), rad('3011', '', '100')], 'Hyra', IDAG)).toBeNull()
  })

  it('saknat datum fälls först', () => {
    expect(verifikatFel([rad('1930', '100'), rad('3011', '', '100')], 'Hyra', '')).toContain(
      'datum',
    )
  })

  it('för kort beskrivning fälls', () => {
    expect(verifikatFel([rad('1930', '100'), rad('3011', '', '100')], 'ab', IDAG)).toContain(
      '3 tecken',
    )
  })

  it('färre än två konterade rader fälls', () => {
    expect(verifikatFel([rad('1930', '100'), rad('')], 'Hyra', IDAG)).toContain('två')
  })

  it('rad med både debet och kredit fälls med kontonumret utskrivet', () => {
    const fel = verifikatFel([rad('1930', '100', '100'), rad('3011', '', '100')], 'Hyra', IDAG)
    expect(fel).toContain('1930')
    expect(fel).toContain('separata rader')
  })

  it('obalans fälls med BÅDA beloppen — den som läser ska slippa räkna om', () => {
    const fel = verifikatFel([rad('1930', '1000'), rad('3011', '', '900')], 'Hyra', IDAG)
    expect(fel).toContain('1000.00')
    expect(fel).toContain('900.00')
  })
})

describe('momsAvBrutto — momsen bryts UT ur beloppet', () => {
  it('25 % på 1250 kr brutto ger 250 kr moms, inte 312,50', () => {
    // DEN AVGÖRANDE KONTROLLEN. Formeln belopp × sats/100 ger 312,50 och ett
    // netto som inte stämmer med kvittot — ett fel som är osynligt i ett
    // verifikat som ändå balanserar.
    expect(momsAvBrutto(1250, 25)).toBe(250)
    expect(1250 - momsAvBrutto(1250, 25)).toBe(1000)
  })

  it('12 % och 6 % räknas ur samma formel', () => {
    expect(momsAvBrutto(1120, 12)).toBe(120)
    expect(momsAvBrutto(1060, 6)).toBe(60)
  })

  it('0 % ger 0 kr moms', () => {
    expect(momsAvBrutto(1000, 0)).toBe(0)
  })

  it('avrundas till ören', () => {
    // 100 × 25 / 125 = 20 exakt; 33,33 × 25/125 = 6,666 → 6,67.
    expect(momsAvBrutto(33.33, 25)).toBe(6.67)
  })

  it('belopp ≤ 0 ger 0', () => {
    expect(momsAvBrutto(0, 25)).toBe(0)
    expect(momsAvBrutto(-100, 25)).toBe(0)
  })
})
