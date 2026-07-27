jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AiAssistantService } from './ai-assistant.service'
import { sanitizeBlocksForPersistence, stripThinkingBlocks } from './history-integrity'

/**
 * BLANDAD KONVERSATION — Sonnet-turer och Opus-turer i samma historik.
 *
 * Sedan modellvalet blev per meddelande kan en konversation se ut så här:
 *
 *   1. "vad är skulden?"          → Sonnet   (ingen bilaga)
 *   2. "läs det här kontoutdraget" → Opus 5  (bilaga)
 *   3. "sammanfatta"              → Sonnet   (ingen bilaga)
 *
 * Tur 3 skickar tur 1 OCH tur 2 tillbaka till modellen. Om tur 2 persisterade
 * ett resonemangsblock från Opus skulle Sonnet få ett block från en annan
 * modell — i bästa fall ignorerat, i värsta fall ett avvisat anrop.
 *
 * Lösningen är att göra historiken modelloberoende av konstruktion: inga
 * resonemangsblock sparas, och de som redan ligger i databasen städas bort på
 * väg in till modellen. Testet bevakar båda leden.
 */

const textTurn = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
})

/** En assistent-rad som Opus 5 skulle ha skrivit: thinking + text. */
const OPUS_ROW = {
  id: 'm2',
  role: 'assistant',
  content: 'Kontoutdraget visar 12 poster.',
  blocks: [
    // Opus 5 returnerar aldrig sin råa tankekedja — fältet är tomt.
    { type: 'thinking', thinking: '', signature: 'sig-abc' },
    { type: 'text', text: 'Kontoutdraget visar 12 poster.' },
  ],
}

/** En assistent-rad som Sonnet skulle ha skrivit: bara text. */
const SONNET_ROW = {
  id: 'm4',
  role: 'assistant',
  content: 'Skulden är 4 500 kr.',
  blocks: null,
}

const USER_ROW = (id: string, text: string) => ({
  id,
  role: 'user',
  content: text,
  blocks: null,
})

function makeService(history: unknown[]) {
  const create = jest.fn().mockResolvedValue(textTurn('Sammanfattning.'))
  const conversation = {
    id: 'conv-1',
    organizationId: 'org-1',
    summary: null,
    summarizedUpToMessageId: null,
    messages: history,
  }
  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue(conversation),
      create: jest.fn().mockResolvedValue(conversation),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
    aiPendingAction: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  }

  const service = new AiAssistantService(
    prisma as never,
    { get: jest.fn().mockReturnValue('test-key') } as never,
    {
      buildContext: jest.fn().mockResolvedValue('PORTFÖLJ'),
      getCurrentDateContext: jest.fn().mockReturnValue('Idag'),
    } as never,
    { executeTool: jest.fn() } as never,
    {
      getMemories: jest.fn().mockResolvedValue(''),
      extractAndSaveMemories: jest.fn().mockResolvedValue(undefined),
    } as never,
    { logUsage: jest.fn().mockResolvedValue(undefined) } as never,
    {
      checkQuota: jest.fn().mockResolvedValue(undefined),
      checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
    } as never,
    {} as never,
    { retrieve: jest.fn().mockResolvedValue(null) } as never,
    {
      buildContentBlocks: jest
        .fn()
        .mockResolvedValue({ contentBlocks: [], refBlocks: [], ids: [], encodedBytes: 0 }),
      markConsumed: jest.fn().mockResolvedValue(undefined),
      rehydrateHistoryBlocks: jest.fn((blocks: unknown[]) => Promise.resolve(blocks)),
    } as never,
  )
  ;(service as unknown as { client: unknown }).client = { messages: { create } }
  ;(service as unknown as { resolveLegalGrounding: unknown }).resolveLegalGrounding = jest
    .fn()
    .mockResolvedValue(null)

  return { service, create }
}

/** Alla blocktyper som förekommer i en meddelandelista. */
function blockTypes(messages: Array<{ content: unknown }>): string[] {
  return messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Array<{ type?: string }>).map((b) => b.type ?? '(okänd)')
      : [],
  )
}

describe('Blandad Sonnet/Opus-historik når modellen utan resonemangsblock', () => {
  it('text → bilaga → text: Opus-turens thinking-block följer inte med till Sonnet', async () => {
    const { service, create } = makeService([
      USER_ROW('m1', 'Vad är skulden?'),
      SONNET_ROW,
      USER_ROW('m3', 'Läs det här kontoutdraget'),
      OPUS_ROW,
    ])

    // Tredje turen: ingen bilaga → Sonnet, med hela blandade historiken.
    await service.chat('org-1', 'user-1', 'ADMIN', 'Sammanfatta')

    const args = create.mock.calls[0]![0] as {
      model: string
      messages: Array<{ role: string; content: unknown }>
    }

    expect(args.model).toBe('claude-sonnet-4-5')
    expect(blockTypes(args.messages)).not.toContain('thinking')
    expect(blockTypes(args.messages)).not.toContain('redacted_thinking')

    // Textinnehållet ska vara KVAR — vi städar resonemang, inte historik.
    const allText = JSON.stringify(args.messages)
    expect(allText).toContain('Kontoutdraget visar 12 poster.')
    expect(allText).toContain('Skulden är 4 500 kr.')
    expect(allText).toContain('Sammanfatta')
  })

  it('samma historik funkar även när nästa tur GÅR till Opus (bilaga med)', async () => {
    const { service, create } = makeService([USER_ROW('m1', 'Fråga'), OPUS_ROW])
    ;(
      service as unknown as { attachments: { buildContentBlocks: jest.Mock } }
    ).attachments.buildContentBlocks.mockResolvedValue({
      contentBlocks: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        },
      ],
      refBlocks: [],
      ids: ['att-1'],
      encodedBytes: 1024,
    })

    await service.chat('org-1', 'user-1', 'ADMIN', 'Och det här?', undefined, ['att-1'])

    const args = create.mock.calls[0]![0] as {
      model: string
      messages: Array<{ role: string; content: unknown }>
    }
    expect(args.model).toBe('claude-opus-5')
    expect(blockTypes(args.messages)).not.toContain('thinking')
  })
})

describe('Resonemangsblock persisteras inte alls (nya rader)', () => {
  it('sanitizeBlocksForPersistence strippar thinking men behåller text', () => {
    const kept = sanitizeBlocksForPersistence([
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'Svaret.' },
    ] as never)

    expect(kept).toEqual([{ type: 'text', text: 'Svaret.' }])
  })

  it('en tur med BARA resonemang ger null (ingen blocks-kolumn sparas)', () => {
    expect(
      sanitizeBlocksForPersistence([{ type: 'thinking', thinking: '', signature: 's' }] as never),
    ).toBeNull()
  })

  it('tool_use strippas fortfarande — par-invarianten är oförändrad', () => {
    const kept = sanitizeBlocksForPersistence([
      { type: 'text', text: 'Kollar.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_x', input: {} },
    ] as never)

    expect(kept).toEqual([{ type: 'text', text: 'Kollar.' }])
  })
})

describe('stripThinkingBlocks — backstop för rader skrivna före ändringen', () => {
  it('tar bort thinking ur en assistent-tur men lämnar övriga block', () => {
    const ut = stripThinkingBlocks([
      { role: 'user', content: 'Fråga' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'text', text: 'Svar' },
        ],
      },
    ] as never)

    expect(ut[1]!.content).toEqual([{ type: 'text', text: 'Svar' }])
  })

  it('lämnar meddelanden utan blockarray orörda (sträng-content)', () => {
    const input = [{ role: 'user', content: 'Ren text' }] as never
    expect(stripThinkingBlocks(input)).toEqual(input)
  })

  it('är idempotent — en redan städad historik ändras inte', () => {
    const once = stripThinkingBlocks([
      { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
    ] as never)
    expect(stripThinkingBlocks(once)).toEqual(once)
  })
})
