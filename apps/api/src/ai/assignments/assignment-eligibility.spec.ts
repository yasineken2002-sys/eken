import { prövaDuglighet, dugligaVerktyg } from './assignment-eligibility'
import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'
import { ACTION_TOOLS } from '../tools/ai-tools.definition'

import type { EffectDeclaration } from '../tools/effect-idempotency'

/**
 * Specen äger MEKANIKEN i grinden; `check-assignment-deadline.mjs` äger en
 * annan fråga (att tidsgränsen inte härleds ur en delad konstant). Ingen av dem
 * kan se den andras sak, och det står i båda filerna.
 *
 * VAD DEN HÄR SPECEN INTE KAN SE: att grinden faktiskt ANROPAS när ett uppdrag
 * skapas. Det ägs av `ai-assignments.service.spec.ts`, som prövar tjänsten.
 */

/** En syntetisk deklaration — bara fälten grinden läser behöver stämma. */
function dekl(över: Partial<EffectDeclaration>): EffectDeclaration {
  return {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_INDEX', livslangd: 'så länge raden finns' },
    traceIntegrity: 'FÖRE_EFFEKTEN',
    externalHandle: 'EJ_TILLÄMPLIG',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [],
    ...över,
  } as EffectDeclaration
}

describe('uppdragsduglighet — grinden vid skapandet', () => {
  it('släpper igenom ett IDEMPOTENT verktyg med bärande spår', () => {
    expect(prövaDuglighet('x', { x: dekl({}) })).toEqual({ duglig: true })
  })

  it('avvisar ett verktyg som saknar klassificering (fail-closed)', () => {
    const utfall = prövaDuglighet('finns_inte', {})
    expect(utfall).toMatchObject({ duglig: false, skäl: 'OKÄNT_VERKTYG' })
  })

  it('avvisar DEDUPLICERBAR — ett "kan avdupliceras" är ingen garanti', () => {
    const utfall = prövaDuglighet('x', { x: dekl({ effectIdempotency: 'DEDUPLICERBAR' }) })
    expect(utfall).toMatchObject({ duglig: false, skäl: 'ANDRAEFFEKT_MÖJLIG' })
  })

  it('avvisar OKÄND — ett oklassat värde är aldrig "antagligen okej"', () => {
    const utfall = prövaDuglighet('x', { x: dekl({ effectIdempotency: 'OKÄND' }) })
    expect(utfall).toMatchObject({ duglig: false, skäl: 'ANDRAEFFEKT_MÖJLIG' })
  })

  it('avvisar plats INGET — utan spår kan ingen fråga om effekten redan finns', () => {
    const utfall = prövaDuglighet('x', {
      x: dekl({ traceDurability: { plats: 'INGET', livslangd: '—' } }),
    })
    expect(utfall).toMatchObject({ duglig: false, skäl: 'SPÅRET_BÄR_INTE' })
  })

  // ── KANARIEFÅGELN FÖR DEN INERTA KLAUSULEN ──────────────────────────────
  //
  // KÖ_FÖNSTER avvisar NOLL verktyg i dag: enda posten med det värdet
  // (`send_invoice_email`) faller redan på IDEMPOTENT-kravet. Klausulen är
  // alltså inte prövad av något riktigt verktyg, och en inert regel som ingen
  // kan se falla är en kommentar i förklädnad.
  //
  // Provet matar in exakt den kombination som inte finns i verkligheten —
  // IDEMPOTENT MED kö-spår — och kräver utslag. Faller klausulen bort blir det
  // här provet rött, inte tyst.
  it('KANARIEFÅGEL: avvisar IDEMPOTENT med KÖ_FÖNSTER, den kombination som inte finns i dag', () => {
    const utfall = prövaDuglighet('x', {
      x: dekl({
        effectIdempotency: 'IDEMPOTENT',
        traceDurability: { plats: 'KÖ_FÖNSTER', livslangd: '7 dygn ELLER 1000 jobb' },
      }),
    })
    expect(utfall).toMatchObject({ duglig: false, skäl: 'SPÅRET_BÄR_INTE' })

    // …och motprovet: samma deklaration med ett bärande spår SLÄPPS igenom.
    // Utan det kunde provet ovan vara grönt av att allt avvisas.
    expect(
      prövaDuglighet('x', {
        x: dekl({ traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: 'raden' } }),
      }),
    ).toEqual({ duglig: true })
  })
})

describe('mängden dugliga verktyg — härledd ur koden, aldrig skriven', () => {
  const dugliga = dugligaVerktyg()
  const avvisade = [...ACTION_TOOLS].filter((n) => !dugliga.includes(n))

  it('är en äkta delmängd av ACTION_TOOLS', () => {
    expect(ACTION_TOOLS.size).toBeGreaterThan(0)
    for (const namn of dugliga) expect(ACTION_TOOLS.has(namn)).toBe(true)
  })

  // Sonden måste kunna ge något ANNAT än det den ger. Både mängden och dess
  // komplement är icke-tomma — annars vore "alla dugliga" och "grinden trasig"
  // samma utdata.
  it('är varken tom eller allt — båda riktningarna har innehåll', () => {
    expect(dugliga.length).toBeGreaterThan(0)
    expect(avvisade.length).toBeGreaterThan(0)
    expect(dugliga.length + avvisade.length).toBe(ACTION_TOOLS.size)
  })

  it('avvisar exakt de verktyg som inte är IDEMPOTENT eller saknar bärande spår', () => {
    for (const namn of avvisade) {
      const d = EFFECT_DECLARATIONS[namn]
      // Varje ACTION_TOOL MÅSTE ha en deklaration — att den saknas är ett eget
      // fel, och ska synas som ett fel och inte som ett hoppat varv.
      expect(d).toBeDefined()
      if (!d) continue
      const bärandeSpår = !['INGET', 'KÖ_FÖNSTER'].includes(d.traceDurability.plats)
      expect(d.effectIdempotency !== 'IDEMPOTENT' || !bärandeSpår).toBe(true)
    }
  })
})
