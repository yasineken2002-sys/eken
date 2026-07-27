jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AiAssistantService } from './ai-assistant.service'
import { AI_MODELS, CHAT_PROFILE_TEXT, CHAT_PROFILE_VISION } from './ai.config'
import { getPricing } from './usage/ai-pricing'

/**
 * MODELLVAL PER MEDDELANDE — Sonnet för text, Opus 5 för bilagor.
 *
 * Chatten körde Opus 5 för allt, vilket kostade ~11× Sonnet-priset även för ren
 * text. Nu avgör bilagan: bär meddelandet bild/dokument går det till Opus 5 för
 * vision-upplösningen, annars till Sonnet.
 *
 * Det som kan gå fel och som testet därför bevakar:
 *  • fel modell för fallet (dyrt, eller oläsbar bild)
 *  • tokentak/effort som följer med FEL modell — Opus 5 gav TOMT SVAR vid 2048,
 *    och `effort` finns inte alls på Sonnet 4.5 och avvisas av API:t
 *  • modellbyte MITT I en tool-loop
 *  • kostnadsloggen som bokför fel modell → fel pris → fel kostnadstak
 */

const textTurn = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
})

const toolTurn = (id: string, name: string) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Kollar.' },
    { type: 'tool_use', id, name, input: {} },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
})

/** Ett bilageblock, som det ser ut efter buildContentBlocks. */
const PDF_BLOCK = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
}

function makeService(opts: {
  responses: unknown[]
  withAttachment?: boolean
  history?: unknown[]
}) {
  const create = jest.fn()
  opts.responses.forEach((r) => create.mockResolvedValueOnce(r))
  const logUsage = jest.fn().mockResolvedValue(undefined)

  const conversation = {
    id: 'conv-1',
    organizationId: 'org-1',
    summary: null,
    summarizedUpToMessageId: null,
    messages: opts.history ?? [],
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

  const attachedBlocks = opts.withAttachment ? [PDF_BLOCK] : []
  const attachedRefs = opts.withAttachment
    ? [
        {
          type: 'eveno_attachment_ref',
          attachmentId: 'att-1',
          kind: 'document',
          filename: 'a.pdf',
          mimeType: 'application/pdf',
        },
      ]
    : []

  const service = new AiAssistantService(
    prisma as never,
    { get: jest.fn().mockReturnValue('test-key') } as never,
    {
      buildContext: jest.fn().mockResolvedValue('PORTFÖLJ'),
      getCurrentDateContext: jest.fn().mockReturnValue('Idag'),
    } as never,
    { executeTool: jest.fn().mockResolvedValue({ success: true, message: 'ok' }) } as never,
    {
      getMemories: jest.fn().mockResolvedValue(''),
      extractAndSaveMemories: jest.fn().mockResolvedValue(undefined),
    } as never,
    { logUsage } as never,
    {
      checkQuota: jest.fn().mockResolvedValue(undefined),
      checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
    } as never,
    {} as never,
    { retrieve: jest.fn().mockResolvedValue(null) } as never,
    {
      buildContentBlocks: jest.fn().mockResolvedValue({
        contentBlocks: attachedBlocks,
        refBlocks: attachedRefs,
        ids: opts.withAttachment ? ['att-1'] : [],
        encodedBytes: opts.withAttachment ? 1024 : 0,
      }),
      markConsumed: jest.fn().mockResolvedValue(undefined),
      rehydrateHistoryBlocks: jest.fn((blocks: unknown[]) => Promise.resolve(blocks)),
    } as never,
  )
  ;(service as unknown as { client: unknown }).client = { messages: { create } }
  ;(service as unknown as { resolveLegalGrounding: unknown }).resolveLegalGrounding = jest
    .fn()
    .mockResolvedValue(null)

  return { service, create, logUsage }
}

/** Argumenten till anrop nr `i` mot Anthropic. */
const callArgs = (create: jest.Mock, i: number) =>
  create.mock.calls[i]![0] as {
    model: string
    max_tokens: number
    output_config?: { effort: string }
    messages: Array<{ role: string; content: unknown }>
  }

describe('Modellval: text → Sonnet, bilaga → Opus 5', () => {
  it('meddelande UTAN bilaga går till Sonnet, med Sonnets tokentak och UTAN effort', async () => {
    const { service, create } = makeService({ responses: [textTurn('Skulden är 4 500 kr.')] })

    await service.chat('org-1', 'user-1', 'ADMIN', 'Vad är Anderssons skuld?')

    const args = callArgs(create, 0)
    expect(args.model).toBe('claude-sonnet-4-5')
    expect(args.model).toBe(AI_MODELS.CHAT)
    expect(args.max_tokens).toBe(CHAT_PROFILE_TEXT.maxTokens)

    // KRITISKT: effort finns inte på Sonnet 4.5 och avvisas av API:t.
    // Fältet ska vara HELT frånvarande, inte satt till undefined.
    expect(args.output_config).toBeUndefined()
    expect('output_config' in args).toBe(false)
  })

  it('meddelande MED bilaga går till Opus 5, med Opus tokentak och effort=low', async () => {
    const { service, create } = makeService({
      responses: [textTurn('Kontoutdraget visar 12 poster.')],
      withAttachment: true,
    })

    await svcChat(service)

    const args = callArgs(create, 0)
    expect(args.model).toBe('claude-opus-5')
    expect(args.model).toBe(AI_MODELS.CHAT_VISION)
    expect(args.max_tokens).toBe(CHAT_PROFILE_VISION.maxTokens)
    expect(args.output_config).toEqual({ effort: 'low' })

    // Opus-taket måste vara HÖGRE än Sonnets — det var för lågt tak som gav
    // tomt svar när modellen la hela budgeten på resonemang.
    expect(CHAT_PROFILE_VISION.maxTokens).toBeGreaterThan(CHAT_PROFILE_TEXT.maxTokens)
  })

  it('portalens hyresgäst-AI rörs inte — TENANT_CHAT står kvar på Sonnet', () => {
    expect(AI_MODELS.TENANT_CHAT).toBe('claude-sonnet-4-5')
    // Textläget använder samma modellsträng som portalen (verifierad sträng).
    expect(AI_MODELS.CHAT).toBe(AI_MODELS.TENANT_CHAT)
  })
})

/** chat() med samma argument överallt — bara modellvalet varierar. */
function svcChat(service: AiAssistantService, attachmentIds?: string[]) {
  return service.chat('org-1', 'user-1', 'ADMIN', 'Läs det här', undefined, attachmentIds)
}

describe('Modellen växlar aldrig mitt i en tool-loop', () => {
  it('alla iterationer i en bilagetur använder Opus 5', async () => {
    const { service, create } = makeService({
      responses: [toolTurn('toolu_1', 'get_overdue_invoices'), textTurn('Klart.')],
      withAttachment: true,
    })

    await svcChat(service, ['att-1'])

    expect(create).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 2; i++) {
      expect(callArgs(create, i).model).toBe('claude-opus-5')
      expect(callArgs(create, i).max_tokens).toBe(CHAT_PROFILE_VISION.maxTokens)
    }
  })

  it('alla iterationer i en textur använder Sonnet', async () => {
    const { service, create } = makeService({
      responses: [toolTurn('toolu_1', 'get_overdue_invoices'), textTurn('Klart.')],
    })

    await svcChat(service)

    expect(create).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 2; i++) {
      expect(callArgs(create, i).model).toBe('claude-sonnet-4-5')
      expect(callArgs(create, i).output_config).toBeUndefined()
    }
  })
})

describe('Kostnadsloggen bokför modellen som FAKTISKT kördes', () => {
  it('textmeddelande loggas som Sonnet', async () => {
    const { service, logUsage } = makeService({ responses: [textTurn('Svar.')] })
    await svcChat(service)
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-4-5' }))
  })

  it('bilagemeddelande loggas som Opus 5', async () => {
    const { service, logUsage } = makeService({
      responses: [textTurn('Svar.')],
      withAttachment: true,
    })
    await svcChat(service, ['att-1'])
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5' }))
  })

  it('prislistan har en egen rad för BÅDA modellerna (annars räknar taken fel)', () => {
    const sonnet = getPricing('claude-sonnet-4-5')
    const opus = getPricing('claude-opus-5')

    expect(sonnet).toEqual({ input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 })
    expect(opus).toEqual({ input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 })

    // Opus MÅSTE vara dyrare än Sonnet i tabellen — är den inte det har någon
    // råkat kopiera fel rad, och hela kostnadsargumentet för uppdelningen faller.
    expect(opus.input).toBeGreaterThan(sonnet.input)
    expect(opus.output).toBeGreaterThan(sonnet.output)
  })
})
