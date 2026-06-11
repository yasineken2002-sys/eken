/**
 * Regressionsspärr för tool-schemats API-giltighet (driftstörningsfix 2026-06-11).
 *
 * BAKGRUND: Anthropics API avvisar `input_schema` med oneOf/allOf/anyOf på
 * TOPPNIVÅ ("input_schema does not support oneOf, allOf, or anyOf at the top
 * level"). Felet är fatalt för HELA requesten: ETT ogiltigt verktyg i
 * tools-listan sänker VARJE chat-anrop med 400 — operator-AI:n blir helt
 * obrukbar (uppmätt i drift: match_bank_transaction hade toppnivå-anyOf).
 *
 * Villkor av typen "exakt en av X/Y" uttrycks i stället i description och
 * grindas auktoritativt server-side i tool-executorn (modellens schema är
 * ändå bara rådgivande — executorn är sanningskällan för validering).
 */
import { TOOLS } from './ai-tools.definition'
import { TENANT_TOOLS } from './tenant-ai-tools.definition'

const FORBIDDEN_TOP_LEVEL = ['oneOf', 'allOf', 'anyOf'] as const

const ALL_TOOLS: ReadonlyArray<{ suite: string; name: string; input_schema: object }> = [
  ...TOOLS.map((t) => ({ suite: 'TOOLS', name: t.name, input_schema: t.input_schema as object })),
  ...TENANT_TOOLS.map((t) => ({
    suite: 'TENANT_TOOLS',
    name: t.name,
    input_schema: t.input_schema as object,
  })),
]

describe('Tool-scheman är giltiga mot Anthropics API', () => {
  it('inget verktyg (operator + tenant) har oneOf/allOf/anyOf på toppnivå i input_schema', () => {
    const offenders = ALL_TOOLS.filter((t) =>
      FORBIDDEN_TOP_LEVEL.some((key) => key in t.input_schema),
    ).map((t) => `${t.suite}:${t.name}`)
    // Ett enda fynd här = ALLA chat-anrop faller med 400 i produktion.
    expect(offenders).toEqual([])
  })

  it('varje input_schema är ett objekt-schema (type: "object" på toppnivå)', () => {
    for (const t of ALL_TOOLS) {
      expect({ tool: t.name, type: (t.input_schema as { type?: string }).type }).toEqual({
        tool: t.name,
        type: 'object',
      })
    }
  })

  it('match_bank_transaction bär exakt-ett-villkoret i beskrivningarna (inte i schemat)', () => {
    const tool = TOOLS.find((t) => t.name === 'match_bank_transaction')!
    expect(tool).toBeDefined()
    const schema = tool.input_schema as {
      required?: string[]
      properties: Record<string, { description?: string }>
    }
    // Bara transactionId är schema-required; invoiceId/rentNoticeId-villkoret
    // bärs i description och grindas server-side i tool-executorn.
    expect(schema.required).toEqual(['transactionId'])
    expect(schema.properties.invoiceId!.description).toMatch(/EXAKT ETT/i)
    expect(schema.properties.rentNoticeId!.description).toMatch(/EXAKT ETT/i)
  })
})
