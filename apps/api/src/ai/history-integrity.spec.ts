import type Anthropic from '@anthropic-ai/sdk'
import {
  enforceToolPairInvariant,
  sanitizeBlocksForPersistence,
  wasRepaired,
} from './history-integrity'

/**
 * PAR-INVARIANTEN — regressionstester för produktionsbuggen
 * `messages.6: tool_use ids were found without tool_result blocks immediately
 * after` (request_id req_011CdRaYhV3vpYgC7kDpam68).
 *
 * ORSAKEN var att den icke-strömmande tool-loopen tog `.find()` och besvarade
 * bara det FÖRSTA av flera parallella tool_use. Den fixen ligger i
 * ai-assistant.service.ts; den här filen vaktar de två skydden runt den:
 * persistensen som aldrig får spara ett halvt par, och backstoppen som
 * saneras precis före SDK-anropet.
 */

const text = (t: string) => ({ type: 'text' as const, text: t })
const toolUse = (id: string, name = 'get_properties') => ({
  type: 'tool_use' as const,
  id,
  name,
  input: {},
})
const toolResult = (id: string) => ({
  type: 'tool_result' as const,
  tool_use_id: id,
  content: '{}',
})

const assistant = (content: unknown[]): Anthropic.MessageParam =>
  ({ role: 'assistant', content }) as unknown as Anthropic.MessageParam
const userBlocks = (content: unknown[]): Anthropic.MessageParam =>
  ({ role: 'user', content }) as unknown as Anthropic.MessageParam
const userText = (t: string): Anthropic.MessageParam => ({ role: 'user', content: t })

describe('sanitizeBlocksForPersistence', () => {
  it('strippar tool_use — tool_result persisteras aldrig, så paret vore halvt', () => {
    const out = sanitizeBlocksForPersistence([
      text('Jag kollar.'),
      toolUse('toolu_1'),
    ] as unknown as Anthropic.ContentBlock[])
    expect(out).toEqual([text('Jag kollar.')])
  })

  it('lämnar en ren textur orörd', () => {
    const blocks = [text('Du har 2 fastigheter.')] as unknown as Anthropic.ContentBlock[]
    expect(sanitizeBlocksForPersistence(blocks)).toEqual(blocks)
  })

  it('behåller thinking-block så länge det finns text kvar', () => {
    const out = sanitizeBlocksForPersistence([
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      text('Svar.'),
      toolUse('toolu_1'),
    ] as unknown as Anthropic.ContentBlock[])
    expect(out).toHaveLength(2)
    expect(out!.some((b) => b.type === 'tool_use')).toBe(false)
  })

  it('returnerar null när bara tool_use fanns — rehydreringen faller på content', () => {
    // Det HÄR är fallet som förgiftade konversationer: tool-loopen tog slut på
    // iterationer och turen bestod av enbart verktygsanrop.
    expect(
      sanitizeBlocksForPersistence([toolUse('toolu_1'), toolUse('toolu_2')] as never),
    ).toBeNull()
  })

  it('returnerar null för en tur med bara thinking (inget att återge)', () => {
    expect(
      sanitizeBlocksForPersistence([
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      ] as never),
    ).toBeNull()
  })
})

describe('enforceToolPairInvariant', () => {
  it('lämnar ett KOMPLETT par orört', () => {
    const messages = [
      userText('Hur många fastigheter?'),
      assistant([text('Kollar.'), toolUse('toolu_1')]),
      userBlocks([toolResult('toolu_1')]),
      assistant([text('Du har 2.')]),
    ]
    const { messages: out, repair } = enforceToolPairInvariant(messages)
    expect(out).toEqual(messages)
    expect(wasRepaired(repair)).toBe(false)
  })

  it('lämnar FLERA parallella anrop orörda när alla besvaras', () => {
    // Precis formen som den fixade loopen nu producerar.
    const messages = [
      userText('Fastigheter och hyresgäster?'),
      assistant([text('Kollar båda.'), toolUse('toolu_1'), toolUse('toolu_2', 'get_tenants')]),
      userBlocks([toolResult('toolu_1'), toolResult('toolu_2')]),
    ]
    const { messages: out, repair } = enforceToolPairInvariant(messages)
    expect(out).toEqual(messages)
    expect(wasRepaired(repair)).toBe(false)
  })

  it('DROPPAR ett tool_use som inte besvaras — exakt produktionsfallet', () => {
    const messages = [
      userText('Fastigheter och hyresgäster?'),
      assistant([text('Kollar.'), toolUse('toolu_1'), toolUse('toolu_2', 'get_tenants')]),
      // Bara det första besvarades — den gamla `.find()`-buggen.
      userBlocks([toolResult('toolu_1')]),
    ]
    const { messages: out, repair } = enforceToolPairInvariant(messages)
    expect(repair.droppedToolUses).toEqual(['toolu_2'])
    const kept = out[1]!.content as unknown as Array<{ type: string; id?: string }>
    expect(kept.filter((b) => b.type === 'tool_use').map((b) => b.id)).toEqual(['toolu_1'])
    // Det besvarade paret är kvar i sin helhet.
    expect(out[2]).toEqual(messages[2])
  })

  it('DROPPAR ett tool_use utan något svarsmeddelande alls (rehydrerad historik)', () => {
    const messages = [
      userText('Hur många fastigheter?'),
      assistant([text('Jag kollar.'), toolUse('toolu_orphan')]),
      // Ingen tool_result-tur — så såg en rad ut som persisterades vid
      // iterationstaket.
      userText('Och hyresgäster?'),
    ]
    const { messages: out, repair } = enforceToolPairInvariant(messages)
    expect(repair.droppedToolUses).toEqual(['toolu_orphan'])
    expect(out[1]!.content).toEqual([text('Jag kollar.')])
  })

  it('DROPPAR ett föräldralöst tool_result — samma 400 från andra hållet', () => {
    const messages = [
      userText('Fråga'),
      assistant([text('Svar.')]),
      userBlocks([toolResult('toolu_ingen_anropare')]),
    ]
    const { messages: out, repair } = enforceToolPairInvariant(messages)
    expect(repair.droppedToolResults).toEqual(['toolu_ingen_anropare'])
    // Meddelandet blev tomt och togs bort helt — en tom content-array avvisas
    // också av API:t, så ett halvt fix hade bytt ett 400 mot ett annat.
    expect(repair.droppedMessages).toBe(1)
    expect(out).toHaveLength(2)
  })

  it('tar bort ett svar som blev föräldralöst av att dess anrop städades', () => {
    // Kedjeeffekten: anropet strippas i steg 1, svaret måste följa med.
    const messages = [
      userText('Fråga'),
      assistant([toolUse('toolu_1')]),
      // Svaret ligger TVÅ steg bort, så anropet räknas som obesvarat.
      assistant([text('Mellanliggande.')]),
      userBlocks([toolResult('toolu_1')]),
    ]
    const { repair } = enforceToolPairInvariant(messages)
    expect(repair.droppedToolUses).toEqual(['toolu_1'])
    expect(repair.droppedToolResults).toEqual(['toolu_1'])
  })

  it('tar ALDRIG bort en halva — anrop och svar försvinner ihop', () => {
    const messages = [
      userText('Fråga'),
      assistant([text('a'), toolUse('toolu_1'), toolUse('toolu_2')]),
      userBlocks([toolResult('toolu_1')]),
    ]
    const { messages: out } = enforceToolPairInvariant(messages)
    const uses = (out[1]!.content as unknown as Array<{ type: string; id?: string }>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id)
    const results = (out[2]!.content as unknown as Array<{ type: string; tool_use_id?: string }>)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id)
    // Kvarvarande mängder är IDENTISKA — inga halvor.
    expect(uses).toEqual(results)
  })

  it('rör inte strängmeddelanden (den vanliga historiken)', () => {
    const messages = [userText('Hej'), { role: 'assistant' as const, content: 'Hej själv' }]
    const { messages: out, repair } = enforceToolPairInvariant(messages)
    expect(out).toEqual(messages)
    expect(wasRepaired(repair)).toBe(false)
  })

  it('är idempotent — en sanerad lista ändras inte igen', () => {
    const messages = [
      userText('Fråga'),
      assistant([text('a'), toolUse('toolu_1'), toolUse('toolu_2')]),
      userBlocks([toolResult('toolu_1')]),
    ]
    const first = enforceToolPairInvariant(messages)
    const second = enforceToolPairInvariant(first.messages)
    expect(second.messages).toEqual(first.messages)
    expect(wasRepaired(second.repair)).toBe(false)
  })

  it('hanterar en tom lista', () => {
    const { messages: out, repair } = enforceToolPairInvariant([])
    expect(out).toEqual([])
    expect(wasRepaired(repair)).toBe(false)
  })
})

describe('trunkering kan inte dela ett par', () => {
  /**
   * Rehydreringsbudgeten (B2/B3) rör BARA bilage-referensblock, och efter fixen
   * persisteras inga tool_use alls. Ett par kan därför inte längre finnas i
   * historiken att dela. Testet låser det: sanera det värsta tänkbara utfallet
   * av en trunkering och verifiera att ingen halva blir kvar.
   */
  it('en historik klippt mitt i ett par saneras till noll halvor', () => {
    // Fall 1: anropet finns, svaret klipptes bort.
    const anropUtanSvar = [
      userText('Fråga'),
      assistant([text('a'), toolUse('toolu_1')]),
      // svaret borta
    ]
    // Fall 2: svaret finns, anropet klipptes bort.
    const svarUtanAnrop = [assistant([text('a')]), userBlocks([toolResult('toolu_1')])]

    for (const messages of [anropUtanSvar, svarUtanAnrop]) {
      const { messages: out } = enforceToolPairInvariant(messages)
      const allBlocks = out.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as unknown as Array<{ type: string }>) : [],
      )
      expect(allBlocks.filter((b) => b.type === 'tool_use')).toHaveLength(0)
      expect(allBlocks.filter((b) => b.type === 'tool_result')).toHaveLength(0)
    }
  })
})
