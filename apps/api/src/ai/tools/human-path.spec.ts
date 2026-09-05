import { ACTION_TOOLS } from './ai-tools.definition'
import { HUMAN_PATHS, arSaknad, buildHumanPathCatalog, verktygUtanMansligVag } from './human-path'

/**
 * SPECEN ÄGER MEKANIKEN, VAKTEN ÄGER PÅKOPPLINGEN (#571).
 *
 * Här prövas att fail-closed faktiskt KASTAR och att katalogen är total.
 * `check-tool-human-path.mjs` prövar att rutterna finns i router.tsx och att
 * åtgärderna finns i sidornas källa — sådant en spec inte kan se, eftersom det
 * bor i ett annat paket.
 */
describe('HUMAN_PATHS — delmängdsregeln', () => {
  it('har en post per ACTION_TOOL, och inga döda poster', () => {
    const deklarerade = new Set(Object.keys(HUMAN_PATHS))
    expect([...ACTION_TOOLS].filter((t) => !deklarerade.has(t))).toEqual([])
    expect([...deklarerade].filter((t) => !ACTION_TOOLS.has(t))).toEqual([])
  })

  it('KASTAR med verktygets namn när en post saknas — ingen tyst fallback', () => {
    const original = { ...HUMAN_PATHS }
    const offer = [...ACTION_TOOLS][0] as string
    try {
      delete (HUMAN_PATHS as Record<string, unknown>)[offer]
      expect(() => buildHumanPathCatalog()).toThrow(new RegExp(offer))
      expect(() => buildHumanPathCatalog()).toThrow(/saknar humanPath/)
      // Och den ska säga att man inte får hitta på en väg — texten är regeln.
      expect(() => buildHumanPathCatalog()).toThrow(/Hitta INTE på en rutt/)
      // …och peka på baslinjen, som är där skälet ska skrivas.
      expect(() => buildHumanPathCatalog()).toThrow(/tool-human-path\.baseline\.json/)
    } finally {
      Object.assign(HUMAN_PATHS, original)
    }
    expect(() => buildHumanPathCatalog()).not.toThrow()
  })

  it('bygger en post per verktyg', () => {
    expect(buildHumanPathCatalog()).toHaveLength(ACTION_TOOLS.size)
  })

  it('en post är antingen en väg ELLER ett fynd — aldrig båda, aldrig ingen', () => {
    for (const { name, deklaration } of buildHumanPathCatalog()) {
      if (arSaknad(deklaration)) {
        // Markören bär ingen prosa — skälet bor i tool-human-path.baseline.json,
        // på ett enda ställe. Här prövas bara att posten säger EN sak.
        expect({ name, markör: deklaration.saknas }).toEqual({ name, markör: true })
        expect(deklaration).not.toHaveProperty('rutt')
      } else {
        expect(deklaration.rutt.startsWith('/')).toBe(true)
        expect(deklaration.atgard.trim().length).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('mängden utan mänsklig väg är den mätta — tre fynd, inte noll', () => {
    // Ett tal här är med flit: mängden ska inte kunna växa obemärkt. Krymper den
    // ska den här raden ändras i SAMMA PR som baslinjen, annars är fyndet inte
    // borta utan bara osynligt.
    expect(verktygUtanMansligVag()).toEqual([
      'mark_sent_to_collection',
      'prepare_contract_signing',
      'send_overdue_reminders',
    ])
  })
})
