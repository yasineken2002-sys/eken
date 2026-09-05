import { provaSkuggDuglighet, skuggdugligaVerktyg } from './shadow-tool-gate'
import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'
import { HUMAN_PATHS } from '../tools/human-path'

import type { EffectDeclaration } from '../tools/effect-idempotency'

/**
 * GRINDEN FÖR VAD SOM FÅR FÖRESLÅS — mekaniken, inte mängden.
 *
 * Talen nedan är MÄTPUNKTER, inte krav: de härleds ur koden och skrivs ut, så
 * att en ändring syns i loggen i stället för att fälla på ett tal i prosan.
 */
describe('skuggdugligheten', () => {
  it('KANARIEFÅGEL: mängden är varken tom eller allt', () => {
    // Utan den här raden kan grinden ha slutat mäta utan att något blir rött —
    // en tom mängd och en full mängd är båda "gröna" för de andra proven.
    const dugliga = skuggdugligaVerktyg()
    const alla = Object.keys(EFFECT_DECLARATIONS)

    console.warn(
      `[skuggrind] ${dugliga.length} av ${alla.length} får föreslås: ${dugliga.join(', ')}`,
    )
    expect(dugliga.length).toBeGreaterThan(0)
    expect(dugliga.length).toBeLessThan(alla.length)
  })

  it('avvisar ett okänt verktyg', () => {
    const r = provaSkuggDuglighet('finns_inte')
    expect(r.duglig).toBe(false)
    if (!r.duglig) expect(r.skäl).toBe('OKÄNT_VERKTYG')
  })

  it('avvisar verktyg UTAN mänsklig väg — delmängdsregeln gäller förslag också', () => {
    const utan = Object.keys(HUMAN_PATHS).filter((n) => 'saknas' in (HUMAN_PATHS[n] ?? {}))
    expect(utan.length).toBeGreaterThan(0) // annars mäter provet ingenting
    for (const n of utan) {
      const r = provaSkuggDuglighet(n)
      expect(r.duglig).toBe(false)
      if (!r.duglig) expect(r.skäl).toBe('SAKNAR_MÄNSKLIG_VÄG')
    }
  })

  it('avvisar MOT_TREDJE_PART', () => {
    const tredje = Object.entries(EFFECT_DECLARATIONS)
      .filter(([, d]) => d.authorityScope === 'MOT_TREDJE_PART')
      .map(([n]) => n)
    expect(tredje.length).toBeGreaterThan(0)
    for (const n of tredje) expect(provaSkuggDuglighet(n).duglig).toBe(false)
  })

  it('GRINDEN ÄR INTE agentAllowlist — den släpper igenom mer', () => {
    // Att låna `agentAllowlist` hade stängt ute 21 av 30 från att ens FÖRESLÅS,
    // vilket är exakt fel: skuggläget finns för att se vad agenten skulle ha
    // gjort med det den inte får göra. Provet fäller om någon gör lånet.
    const dugliga = new Set(skuggdugligaVerktyg())
    const allowlist = Object.entries(EFFECT_DECLARATIONS)
      .filter(([, d]) => d.agentAllowlist)
      .map(([n]) => n)
    const utanfor = dugliga.size - allowlist.filter((n) => dugliga.has(n)).length
    expect(utanfor).toBeGreaterThan(0)
  })

  it('reglerna prövas var för sig, mot påhittade deklarationer', () => {
    const bas = EFFECT_DECLARATIONS['create_property']!
    const d: Record<string, EffectDeclaration> = { zz_sond: { ...bas } }
    const v = { zz_sond: { rutt: '/x', atgard: 'Y' } } as unknown as typeof HUMAN_PATHS
    expect(provaSkuggDuglighet('zz_sond', d, v).duglig).toBe(true)

    const tredje: Record<string, EffectDeclaration> = {
      zz_sond: { ...bas, authorityScope: 'MOT_TREDJE_PART' },
    }
    expect(provaSkuggDuglighet('zz_sond', tredje, v).duglig).toBe(false)

    const utanVag = { zz_sond: { saknas: true } } as unknown as typeof HUMAN_PATHS
    expect(provaSkuggDuglighet('zz_sond', d, utanVag).duglig).toBe(false)
  })
})
