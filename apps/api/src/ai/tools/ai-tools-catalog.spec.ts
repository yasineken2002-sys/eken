import { TOOLS, ACTION_TOOLS } from './ai-tools.definition'
import { buildToolCatalog, TOOL_GROUPS, TOOL_META_NAMES, type ToolGroup } from './ai-tools.catalog'

/**
 * Den här sviten ÄR regeln som håller verktygslistan sann framåt.
 *
 * Frontend hade tidigare en egen etikettlista som drev isär från TOOLS: 10
 * verktyg saknade etikett, 2 etiketter pekade på borttagna verktyg. Ingen
 * märkte det, för driften gav bara en sämre sträng — aldrig ett fel.
 *
 * Testerna nedan gör drift till ett brutet bygge i BÅDA riktningarna: ett nytt
 * verktyg utan katalogpost fäller, och en katalogpost för ett borttaget verktyg
 * fäller också.
 */
describe('verktygskatalogen', () => {
  it('har en post för VARJE verktyg i TOOLS', () => {
    const toolNames = TOOLS.map((t) => t.name)
    const saknar = toolNames.filter((n) => !TOOL_META_NAMES.includes(n))
    expect(saknar).toEqual([])
  })

  it('har INGA poster för verktyg som inte finns (döda etiketter)', () => {
    const toolNames = new Set(TOOLS.map((t) => t.name))
    const doda = TOOL_META_NAMES.filter((n) => !toolNames.has(n))
    expect(doda).toEqual([])
  })

  it('innehåller exakt lika många poster som TOOLS', () => {
    expect(buildToolCatalog()).toHaveLength(TOOLS.length)
  })

  it('härleder binding ur ACTION_TOOLS — ingen andra lista', () => {
    for (const entry of buildToolCatalog()) {
      expect(entry.binding).toBe(ACTION_TOOLS.has(entry.name))
    }
  })

  it('markerar exakt ACTION_TOOLS som bindande', () => {
    const bindande = buildToolCatalog()
      .filter((e) => e.binding)
      .map((e) => e.name)
      .sort()
    expect(bindande).toEqual([...ACTION_TOOLS].sort())
  })

  it('placerar varje verktyg i en av de tillåtna grupperna', () => {
    for (const entry of buildToolCatalog()) {
      expect(TOOL_GROUPS).toContain(entry.group as ToolGroup)
    }
  })

  it('ger varje verktyg en icke-tom svensk etikett', () => {
    for (const entry of buildToolCatalog()) {
      expect(entry.label.trim().length).toBeGreaterThan(0)
      // Etiketten ska vara skriven, inte härledd ur maskinnamnet.
      expect(entry.label).not.toBe(entry.name)
    }
  })

  it('kastar med verktygets namn om en post saknas', () => {
    // Simulerar ett nytt verktyg utan katalogpost: buildToolCatalog läser TOOLS
    // vid anrop, så vi lägger till ett tillfälligt och städar efteråt.
    TOOLS.push({
      name: 'nytt_overktyg_utan_post',
      description: 'x',
      input_schema: { type: 'object' },
    })
    try {
      expect(() => buildToolCatalog()).toThrow(/nytt_overktyg_utan_post/)
    } finally {
      TOOLS.pop()
    }
  })
})
