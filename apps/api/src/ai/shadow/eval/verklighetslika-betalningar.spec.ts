import { BetalningskorpusSchema } from './betalningsrapport'
import { verklighetslikaBetalningar } from './verklighetslika-betalningar'
import {
  mataVerklighetslikBetalning,
  sammanfattaVerklighetslikaBetalningar,
} from './verklighetslik-betalningsmatning'
import { tolkaBedomning } from './experiment-betalningsbedomning'
import { provaKandidater } from '../payment/payment-candidates'

it('har 28 skilda syntetiska fall med giltiga observationer och facit', () => {
  const cases = verklighetslikaBetalningar()
  expect(cases).toHaveLength(28)
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
  expect(cases.filter((c) => c.exaktOcrKontroll)).toHaveLength(2)
  for (const c of cases) {
    expect(c.bedomning.avier.every((id) => c.poster.some((p) => p.id === id))).toBe(true)
    expect(c.forslag === 'INGEN' || c.poster.some((p) => p.id === c.forslag)).toBe(true)
    expect(new Set(c.bedomning.avier).size).toBe(c.bedomning.avier.length)
    const post = c.poster.find((p) => p.id === c.forslag)
    expect(
      BetalningskorpusSchema.safeParse({
        poster: c.poster.map((p) => ({
          ...p,
          forfallodatum: p.forfallodatum.toISOString().slice(0, 10),
        })),
        bankrader: [
          {
            ...c.rad,
            datum: c.rad.datum.toISOString().slice(0, 10),
            facit: {
              avi: c.forslag,
              belopp: post ? (c.bedomning.hantering === 'DEL' ? 'DEL' : 'FULL') : null,
              motpart: post?.motpartId ?? null,
              grupp: c.id,
              skal: c.scenario,
            },
          },
        ],
      }).success,
    ).toBe(true)
  }
})

it.each(verklighetslikaBetalningar())(
  '$id: bevarar gamla kandidater och håller facit utanför prompten',
  async (item) => {
    const before = JSON.stringify(item)
    const marked = {
      ...item,
      scenario: 'HEMLIGT_SCENARIO_77881',
      bedomning: { ...item.bedomning },
      forslag: 'HEMLIGT_FACIT_99332',
    }
    const result = await mataVerklighetslikBetalning(marked, 'referensstod', 1)
    expect(result.gamlaKandidaterKvar).toBe(true)
    expect(JSON.stringify(result.request ?? {})).not.toContain('HEMLIGT_SCENARIO_77881')
    expect(JSON.stringify(result.request ?? {})).not.toContain('HEMLIGT_FACIT_99332')
    expect(JSON.stringify(result.request ?? {})).not.toContain('"facit"')
    expect(JSON.stringify(item)).toBe(before)
  },
)

it('bevarar OCR-förbigången utan att anropa modellen', async () => {
  const invoke = jest.fn()
  for (const item of verklighetslikaBetalningar().filter((c) => c.exaktOcrKontroll)) {
    const result = await mataVerklighetslikBetalning(item, 'befintlig', 1, invoke)
    expect(result).toMatchObject({ kontroll: true, kontrollRatt: true, status: 'KONTROLL' })
  }
  expect(invoke).not.toHaveBeenCalled()
})

it('synliggör bortfallet vid topp fem och tillför den explicit refererade sjunde avin i experimentet', async () => {
  const item = verklighetslikaBetalningar().find((c) => c.id === 'referens-efter-kandidattak')!
  expect(await mataVerklighetslikBetalning(item, 'befintlig', 1)).toMatchObject({
    facitIMangden: false,
  })
  expect(await mataVerklighetslikBetalning(item, 'referensstod', 1)).toMatchObject({
    facitIMangden: true,
    gamlaKandidaterKvar: true,
  })
})

it('skiljer rätt dokument vid överskott från ett felaktigt förslag om matchning', async () => {
  const item = verklighetslikaBetalningar().find((c) => c.id === 'redan-delvis-betald')!
  const response = (input: unknown) => async () => ({
    input,
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  })
  const current = await mataVerklighetslikBetalning(
    item,
    'befintlig',
    1,
    response({
      avi: item.bedomning.avier[0],
      confidence: 0.99,
      reasoning: 'Syntetiskt felaktigt förslag',
    }),
  )
  expect(current).toMatchObject({ heltRatt: false, felaktigtForslag: true })
  const experiment = await mataVerklighetslikBetalning(
    item,
    'referensstod',
    1,
    response(item.bedomning),
  )
  expect(experiment).toMatchObject({
    heltRatt: true,
    identitetRatt: true,
    hanteringRatt: true,
    felaktigReferens: false,
  })
})

it('behåller otolkbara, trunkerade och saknade svar i nämnaren', async () => {
  const item = verklighetslikaBetalningar().find((c) => c.id === 'felskriven-ocr')!
  const rows = [
    await mataVerklighetslikBetalning(item, 'befintlig', 1),
    await mataVerklighetslikBetalning(item, 'befintlig', 2, async () => {
      throw new Error('synthetic')
    }),
    await mataVerklighetslikBetalning(item, 'befintlig', 3, async () => ({
      input: { avi: 'unknown', confidence: 1, reasoning: 'unknown' },
      stopReason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    await mataVerklighetslikBetalning(item, 'befintlig', 4, async () => ({
      input: { avi: item.forslag, confidence: 1, reasoning: 'truncated' },
      stopReason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  ]
  expect(
    sammanfattaVerklighetslikaBetalningar(rows).find((r) => r.arm === 'befintlig'),
  ).toMatchObject({ antal: 4, heltRatt: 0, bortfall: 4, felaktigaForslag: 0 })
})

it('avvisar experimentets påhittade id:n och dubblerade val', () => {
  const item = verklighetslikaBetalningar().find((c) => c.id === 'felskriven-ocr')!
  const result = provaKandidater(item.rad, item.poster)
  if (result.typ !== 'KANDIDATER') throw new Error('Kandidatfixture saknas')
  expect(tolkaBedomning({ avier: ['unknown'], hantering: 'FULL' }, result.kandidater)).toBeNull()
  expect(
    tolkaBedomning({ avier: [item.forslag, item.forslag], hantering: 'FULL' }, result.kandidater),
  ).toBeNull()
})
