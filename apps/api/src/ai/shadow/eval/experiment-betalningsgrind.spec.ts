import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nyaGrindprover } from './betalningsgrind-prover'
import {
  granskaBetalningsbedomning,
  beloppIOre,
  klassificeraBelopp,
} from './experiment-betalningsgrind'
import { matGrindprov, sammanfattaGrindprov } from './betalningsgrind-matning'
import { provaKandidater } from '../payment/payment-candidates'
import { berikaReferenser } from './experiment-betalningsreferenser'
import { verklighetslikaBetalningar } from './verklighetslika-betalningar'
import type { VerklighetslikMatpunkt } from './verklighetslik-betalningsmatning'

const kandidater = (c: ReturnType<typeof nyaGrindprover>[number]) => {
  const regel = provaKandidater(c.rad, c.poster)
  return berikaReferenser(c.rad, c.poster, regel.typ === 'KANDIDATER' ? regel.kandidater : [])
    .kandidater
}

it('har 32 skilda grundfall och håller facit utanför bankraden', () => {
  const cases = nyaGrindprover()
  expect(cases).toHaveLength(32)
  expect(new Set(cases.map((c) => c.id)).size).toBe(32)
  for (const c of cases) {
    expect(c.rad).not.toHaveProperty('facit')
    expect(c.rad).not.toHaveProperty('provmatchning')
    expect(c.rad).not.toHaveProperty('scenario')
  }
})

it.each([
  [6240.35, 6240.35, 'FULL'],
  [6239.35, 6240.35, 'FULL'],
  [6239.34, 6240.35, 'DEL'],
  [6241.35, 6240.35, 'FULL'],
  [6241.36, 6240.35, 'OVERSKOTT'],
  [37.25, 6240.35, 'DEL'],
  [8450, 1250, 'OVERSKOTT'],
  [0.3, 0.3, 'FULL'],
  [0.01, 1.02, 'DEL'],
] as const)('räknar %s på skuld %s till %s med exakta ören', (betalning, skuld, facit) => {
  expect(klassificeraBelopp(betalning, skuld)).toBe(facit)
})
it.each([NaN, Infinity, -1, 0.001, 0.1 + 0.2, Number.MAX_SAFE_INTEGER])(
  'avrundar inte ogiltigt belopp %s till godkänt',
  (n) => expect(beloppIOre(n)).toBeNull(),
)
it('bevarar ett stort exakt decimalbelopp utan öresförlust', () =>
  expect(beloppIOre(9999999999.99)).toBe(999999999999n))

it.each(nyaGrindprover())(
  '$id: bevarar korrekt identitet, räknar kategori och provar rätt avgränsning',
  (c) => {
    const before = JSON.stringify(c)
    const result = granskaBetalningsbedomning(c.rad, c.poster, kandidater(c), c.facit, true)
    expect(result.bedomning).toEqual(c.facit)
    expect(Boolean(result.provmatchning)).toBe(c.provmatchning)
    expect(result.automatiskVerkstallning).toBe(false)
    expect(result.kandidater).toEqual(kandidater(c).map((k) => k.id))
    expect(JSON.stringify(c)).toBe(before)
  },
)

it.each(nyaGrindprover())(
  '$id: ett framtvingat felaktigt modellval ger ingen provmatchning',
  (c) => {
    const menu = kandidater(c)
    for (const k of menu) {
      if (c.provmatchning && c.facit.avier.includes(k.id)) continue
      for (const hantering of ['FULL', 'DEL', 'OVERSKOTT', 'RETUR', 'FLERA'] as const) {
        const result = granskaBetalningsbedomning(
          c.rad,
          c.poster,
          menu,
          { avier: [k.id], hantering },
          true,
        )
        expect(result.provmatchning).toBeNull()
        expect(result.automatiskVerkstallning).toBe(false)
      }
    }
  },
)

it('kräver fullständigt underlag också när modellsvaret är korrekt', () => {
  const c = nyaGrindprover()[0]!
  expect(
    granskaBetalningsbedomning(c.rad, c.poster, kandidater(c), c.facit).provmatchning,
  ).toBeNull()
  expect(granskaBetalningsbedomning(c.rad, c.poster, kandidater(c), c.facit, false).skal).toContain(
    'UNDERLAGETS_FULLSTANDIGHET_OKAND',
  )
})

it.each(['000111222333', 'bokstaver28461357902'])(
  'ignorerar inte en okänd eller felaktigt formad OCR även med hel avireferens: %s',
  (rawOcr) => {
    const c = nyaGrindprover()[0]!
    const result = granskaBetalningsbedomning(
      { ...c.rad, rawOcr },
      c.poster,
      kandidater(c),
      c.facit,
      true,
    )
    expect(result.provmatchning).toBeNull()
    expect(result.bedomning).toEqual(c.facit)
    expect(result.skal).toContain('OCR_UTAN_VERIFIERBART_STOD')
  },
)
it.each([
  null,
  { avier: ['främmande'], hantering: 'FULL' },
  { avier: ['prov-a', 'prov-a'], hantering: 'FULL' },
])('öppnar inte för otolkbart eller förfalskat modellsvar', (input) => {
  const c = nyaGrindprover()[0]!
  expect(
    granskaBetalningsbedomning(c.rad, c.poster, kandidater(c), input, true).provmatchning,
  ).toBeNull()
})
it('en komplett men trunkerad org-vy kan inte smygas in med dubbla id:n', () => {
  const c = nyaGrindprover()[0]!
  expect(
    granskaBetalningsbedomning(c.rad, [c.poster[0]!, c.poster[0]!], kandidater(c), c.facit, true)
      .provmatchning,
  ).toBeNull()
})
it('tolkar inte en avstående modell som säker bara för att namn och referens finns', () => {
  const c = nyaGrindprover()[0]!
  const result = granskaBetalningsbedomning(
    c.rad,
    c.poster,
    kandidater(c),
    { avier: ['prov-a'], hantering: 'OKLART' },
    true,
  )
  expect(result.bedomning).toEqual({ avier: [], hantering: 'OKLART' })
  expect(result.provmatchning).toBeNull()
})
it('rättar de sparade kända felen utan att skriva om facit eller tappa gamla korrekta förslag', () => {
  const saved = JSON.parse(
    readFileSync(join(__dirname, 'verklighetslika-betalningar.modell.json'), 'utf8'),
  ) as { rader: VerklighetslikMatpunkt[] }
  const cases = verklighetslikaBetalningar()
  const rows = saved.rader
    .filter((r) => r.arm === 'referensstod' && !r.kontroll)
    .map((r) => {
      const c = cases.find((c) => c.id === r.id)!
      return matGrindprov({ ...c, facit: c.bedomning }, r.bedomning, r.repetition, r.status)
    })
  expect(sammanfattaGrindprov(rows)).toMatchObject({
    antal: 52,
    grundfall: 26,
    foreRatt: 40,
    efterRatt: 52,
    tidigareKorrektForlorat: 0,
    mal99_1BelagtIDrift: false,
  })
})
it('tomt prov och saknat svar ger aldrig 100 procent eller driftgodkännande', () => {
  expect(sammanfattaGrindprov([])).toMatchObject({
    precisionPaValda: null,
    tackning: null,
    mal99_1BelagtIDrift: false,
  })
  const row = matGrindprov(nyaGrindprover()[0]!, null, 1, 'API_FEL')
  expect(sammanfattaGrindprov([row])).toMatchObject({
    antal: 1,
    efterRatt: 0,
    bortfall: 1,
    missadeProvmatchningar: 1,
    precisionPaValda: null,
    mal99_1BelagtIDrift: false,
  })
})

it('räknar faktiska provkandidater men kallar inte saknat automatikfacit för noll fel', () => {
  const { provmatchning: _facit, ...c } = nyaGrindprover()[0]!
  void _facit
  const row = matGrindprov(c, c.facit, 1, 'SVAR')
  expect(sammanfattaGrindprov([row])).toMatchObject({
    provmatchningar: 1,
    provmatchningarMedFacit: 0,
    felaktigaProvmatchningar: null,
    missadeProvmatchningar: null,
    precisionPaValda: null,
  })
})
