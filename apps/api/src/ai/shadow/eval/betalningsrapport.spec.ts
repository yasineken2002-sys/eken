import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BetalningskorpusSchema,
  mataBetalningar,
  sammanfattaBetalningar,
  type Betalningsmatpunkt,
  type Modellutfall,
} from './betalningsrapport'

const rå = JSON.parse(readFileSync(join(__dirname, 'korpus-betalningar.json'), 'utf8'))
const korpus = BetalningskorpusSchema.parse(rå)
const nej: Modellutfall = {
  input: { avi: 'INGEN', confidence: 0.9, reasoning: 'Ingen kandidat passar' },
  stopReason: 'tool_use',
  tokensIn: 100,
  tokensUt: 10,
}
const punkt = (id: string): Betalningsmatpunkt => ({
  id,
  grupp: 'prov',
  kontroll: false,
  regelTyp: 'KANDIDATER',
  antalKandidater: 1,
  rattPostIMangden: true,
  facit: { avi: 'a', belopp: 'FULL', motpart: 't' },
  regler: null,
  kombinerat: { avi: 'a', belopp: 'FULL', motpart: 't' },
  modellstatus: 'SVAR',
})

describe('betalningsrapport — nämnaren ägs av facit', () => {
  it('ett korrekt och ett otolkbart svar blir 1/2 på varje fält, aldrig 1/1', () => {
    const saknat = { ...punkt('2'), kombinerat: null, modellstatus: 'AVVISAT' as const }
    const rapport = sammanfattaBetalningar([punkt('1'), saknat], true)
    expect(rapport.kombinerat.map((m) => [m.ratt, m.antal, m.saknadeSvar, m.procent])).toEqual([
      [1, 2, 1, 50],
      [1, 2, 1, 50],
      [1, 2, 1, 50],
    ])
    expect(rapport.etappB).toBe('UNDERKAND')
  })

  it('saknat facit undantas endast på det fältet', () => {
    const rad = punkt('1')
    rad.facit['motpart'] = null
    const rapport = sammanfattaBetalningar([rad], true)
    expect(rapport.kombinerat.map((m) => m.antal)).toEqual([1, 1, 0])
    expect(rapport.kombinerat[2]?.procent).toBeNull()
    expect(rapport.etappB).toBe('UNDERKAND')
  })

  it('färre än 80 procent på motpart fäller även om avi och belopp är perfekta', () => {
    const rad = punkt('1')
    rad.kombinerat = { avi: 'a', belopp: 'FULL', motpart: 'fel' }
    expect(sammanfattaBetalningar([rad], true).etappB).toBe('UNDERKAND')
  })

  it('exakt 80 procent passerar, men 79 procent gör det inte', () => {
    const rader = Array.from({ length: 100 }, (_, i) => punkt(String(i)))
    for (const r of rader.slice(80)) r.kombinerat = { avi: 'fel', belopp: 'DEL', motpart: 'fel' }
    expect(sammanfattaBetalningar(rader, true).etappB).toBe('GODKAND')
    rader[79]!.kombinerat = null
    expect(sammanfattaBetalningar(rader, true).etappB).toBe('UNDERKAND')
  })

  it('en regel kan inte krympa nämnaren genom att felaktigt säga INGEN_FRAGA', () => {
    const rad = { ...punkt('1'), regelTyp: 'INGEN_FRAGA', kombinerat: null }
    const rapport = sammanfattaBetalningar([rad], true)
    expect(rapport.kombinerat.map((m) => m.antal)).toEqual([1, 1, 1])
    expect(rapport.kontroller.fel).toEqual(['1'])
  })

  it('en förväntad kontroll som börjar nå modellen fäller', () => {
    const rapport = sammanfattaBetalningar(
      [{ ...punkt('kontroll'), kontroll: true }, punkt('1')],
      true,
    )
    expect(rapport.kontroller.fel).toEqual(['kontroll'])
    expect(rapport.etappB).toBe('UNDERKAND')
  })

  it('tomma mängder och en utebliven modellkörning kan aldrig godkännas', () => {
    expect(sammanfattaBetalningar([], true).etappB).toBe('UNDERKAND')
    expect(sammanfattaBetalningar([punkt('1')], false).etappB).toBe('BLOCKERAT')
  })
})

describe('betalningsriggens produktionsregler och modellsvar', () => {
  it('mäter regelarmen utan modell: fyra kontroller och 10/36 per fält', async () => {
    const rapport = await mataBetalningar(korpus)
    expect(rapport.kontroller).toEqual({ antal: 4, fel: [] })
    expect(rapport.recall).toEqual({ ratt: 19, antal: 19 })
    expect(rapport.regler.map((m) => [m.ratt, m.antal])).toEqual([
      [10, 36],
      [10, 36],
      [10, 36],
    ])
    expect(rapport.usage).toEqual({ tokensIn: 0, tokensUt: 0, modellanrop: 0, komplett: true })
    expect(rapport.etappB).toBe('BLOCKERAT')
  })

  it('ett aktivt INGEN ger FULL/OKAND, precis som producenten, och facit når inte modellen', async () => {
    const modell = jest.fn(async () => nej)
    const rapport = await mataBetalningar(korpus, modell)
    expect(modell).toHaveBeenCalledTimes(26)
    expect(rapport.kombinerat.map((m) => m.antal)).toEqual([36, 36, 36])
    expect(rapport.kombinerat.map((m) => m.saknadeSvar)).toEqual([0, 0, 0])
    expect(rapport.usage).toEqual({
      tokensIn: 2600,
      tokensUt: 260,
      modellanrop: 26,
      komplett: true,
    })
    for (const rad of rapport.rader.filter((r) => !r.kontroll)) {
      expect(rad.kombinerat).toEqual({ avi: 'INGEN', belopp: 'FULL', motpart: 'OKAND' })
    }
    const anrop = jest.fn(async (rad, kandidater) => {
      expect(Object.keys(rad).sort()).toEqual(['belopp', 'datum', 'id', 'rawOcr', 'text'])
      expect(kandidater.every((k: object) => !('facit' in k))).toBe(true)
      return nej
    })
    await mataBetalningar(korpus, anrop)
  })

  it.each([
    ['trunkerat', { ...nej, stopReason: 'max_tokens' }],
    ['otolkbart', { ...nej, input: {} }],
    ['främmande id', { ...nej, input: { avi: 'saknas', confidence: 1, reasoning: 'fel' } }],
  ])('%s svar försvinner inte ur nämnaren', async (_namn, svar) => {
    const rapport = await mataBetalningar(korpus, async () => svar)
    expect(rapport.kombinerat.map((m) => [m.ratt, m.antal, m.saknadeSvar])).toEqual([
      [10, 36, 26],
      [10, 36, 26],
      [10, 36, 26],
    ])
    expect(rapport.tekniskaFel).toHaveLength(26)
    expect(rapport.etappB).toBe('UNDERKAND')
  })

  it('stoppar fler betalda anrop vid API-fel men bevarar alla rader', async () => {
    const modell = jest.fn(async (): Promise<Modellutfall> => {
      throw new Error('hemlig råtext')
    })
    const rapport = await mataBetalningar(korpus, modell)
    expect(modell).toHaveBeenCalledTimes(1)
    expect(rapport.rader).toHaveLength(korpus.bankrader.length)
    expect(rapport.rader.filter((r) => r.modellstatus === 'EJ_KORD')).toHaveLength(25)
    expect(rapport.usage.komplett).toBe(false)
    expect(JSON.stringify(rapport)).not.toContain('hemlig råtext')
    expect(rapport.etappB).toBe('UNDERKAND')
  })

  it('facitfel och dubbla id:n fälls före körning', () => {
    expect(
      BetalningskorpusSchema.safeParse({ ...rå, bankrader: [...rå.bankrader, rå.bankrader[0]] })
        .success,
    ).toBe(false)
    const rad = korpus.bankrader[0]!
    expect(
      BetalningskorpusSchema.safeParse({
        ...korpus,
        bankrader: [{ ...rad, facit: { ...rad.facit, avi: 'finns-inte' } }],
      }).success,
    ).toBe(false)
  })
})
