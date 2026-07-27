jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AiAssistantService } from './ai-assistant.service'

/**
 * TOOL-LOOPENS PAR-INVARIANT — regressionsvakt för produktionsbuggen
 * `messages.6: tool_use ids were found without tool_result blocks immediately
 * after` (req_011CdRaYhV3vpYgC7kDpam68).
 *
 * Buggen: den icke-strömmande loopen tog `.find()` på tool_use-blocken, körde
 * ETT verktyg och lade till ETT tool_result. Begärde modellen två verktyg i
 * samma tur (parallella anrop) blev det andra obesvarat, och nästa request
 * avvisades med 400.
 *
 * Testet driver `chat()` med en mockad klient och inspekterar EXAKT det
 * `messages`-argument som skulle gått till Anthropic. Det är den kontrollen som
 * saknades: buggen syntes bara i det andra anropet i loopen.
 */

const textTurn = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
})

const toolTurn = (tools: Array<{ id: string; name: string }>) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Kollar.' },
    ...tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: {} })),
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
})

function makeService(responses: unknown[]) {
  const create = jest.fn()
  responses.forEach((r) => create.mockResolvedValueOnce(r))

  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'conv-1',
        organizationId: 'org-1',
        summary: null,
        summarizedUpToMessageId: null,
        messages: [],
      }),
      create: jest.fn().mockResolvedValue({
        id: 'conv-1',
        organizationId: 'org-1',
        summary: null,
        summarizedUpToMessageId: null,
        messages: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
    aiPendingAction: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  }
  const executeTool = jest.fn().mockResolvedValue({ success: true, message: 'ok' })

  const service = new AiAssistantService(
    prisma as never,
    { get: jest.fn().mockReturnValue('test-key') } as never,
    {
      buildContext: jest.fn().mockResolvedValue('PORTFÖLJ'),
      getCurrentDateContext: jest.fn().mockReturnValue('Idag'),
    } as never,
    { executeTool } as never,
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
      rehydrateHistoryBlocks: jest.fn(),
    } as never,
  )
  ;(service as unknown as { client: unknown }).client = { messages: { create } }
  // Juridik-grindarna är irrelevanta här och kostar ett extra modellanrop.
  ;(service as unknown as { resolveLegalGrounding: unknown }).resolveLegalGrounding = jest
    .fn()
    .mockResolvedValue(null)

  return { service, create, executeTool, prisma }
}

/** Par-invarianten på ett messages-argument: varje tool_use besvaras direkt. */
function pairsAreConsistent(messages: Array<{ role: string; content: unknown }>): boolean {
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]!.content
    if (!Array.isArray(content)) continue
    const uses = (content as Array<{ type: string; id?: string }>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id)
    if (uses.length === 0) continue

    const next = messages[i + 1]
    if (!next || next.role !== 'user' || !Array.isArray(next.content)) return false
    const answered = (next.content as Array<{ type: string; tool_use_id?: string }>)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id)
    if (uses.some((id) => !answered.includes(id))) return false
  }
  return true
}

describe('tool-loopen (icke-strömmande chat)', () => {
  it('ETT verktyg → ett tool_result, par-konsistent', async () => {
    const { service, create, executeTool } = makeService([
      toolTurn([{ id: 'toolu_1', name: 'get_overdue_invoices' }]),
      textTurn('Du har 3 förfallna.'),
    ])

    const res = await service.chat('org-1', 'user-1', 'ADMIN', 'Visa förfallna fakturor')
    expect(res.reply).toContain('3 förfallna')
    expect(executeTool).toHaveBeenCalledTimes(1)

    // Andra anropet är det som 400:ade i produktion.
    const second = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(pairsAreConsistent(second.messages)).toBe(true)
  })

  it('TVÅ parallella verktyg → TVÅ tool_result i samma svarstur (buggen)', async () => {
    const { service, create, executeTool } = makeService([
      toolTurn([
        { id: 'toolu_1', name: 'get_properties' },
        { id: 'toolu_2', name: 'get_tenants' },
      ]),
      textTurn('2 fastigheter, 1 hyresgäst.'),
    ])

    await service.chat('org-1', 'user-1', 'ADMIN', 'Fastigheter och hyresgäster?')

    // BÅDA verktygen ska ha körts — den gamla koden körde bara det första.
    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(['get_properties', 'get_tenants'])

    const second = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(pairsAreConsistent(second.messages)).toBe(true)

    // Svarsturen bär exakt två tool_result, i anropens ordning.
    const resultTurn = second.messages[second.messages.length - 1]!
    const ids = (resultTurn.content as Array<{ type: string; tool_use_id: string }>)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id)
    expect(ids).toEqual(['toolu_1', 'toolu_2'])
  })

  it('TRE parallella verktyg → tre resultat', async () => {
    const { service, create, executeTool } = makeService([
      toolTurn([
        { id: 'toolu_1', name: 'get_properties' },
        { id: 'toolu_2', name: 'get_tenants' },
        { id: 'toolu_3', name: 'get_available_units' },
      ]),
      textTurn('Klart.'),
    ])
    await service.chat('org-1', 'user-1', 'ADMIN', 'Allt tre, tack')
    expect(executeTool).toHaveBeenCalledTimes(3)
    const second = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(pairsAreConsistent(second.messages)).toBe(true)
  })

  it('ett verktyg som KASTAR blir ett tool_result, inte ett uteblivet svar', async () => {
    const { service, create, executeTool } = makeService([
      toolTurn([
        { id: 'toolu_1', name: 'get_properties' },
        { id: 'toolu_2', name: 'get_tenants' },
      ]),
      textTurn('Delvis klart.'),
    ])
    executeTool.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('DB nere'))

    await service.chat('org-1', 'user-1', 'ADMIN', 'Två saker')

    const second = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    // Felet får INTE lämna anropet obesvarat — det var den andra vägen till 400.
    expect(pairsAreConsistent(second.messages)).toBe(true)
    const last = second.messages[second.messages.length - 1]!
    expect((last.content as unknown[]).length).toBe(2)
  })

  it('ett BINDANDE verktyg bland läsverktyg → INGET körs, pendingAction returneras', async () => {
    const { service, create, executeTool } = makeService([
      toolTurn([
        { id: 'toolu_1', name: 'get_properties' },
        { id: 'toolu_2', name: 'create_invoice' },
      ]),
    ])

    const res = await service.chat('org-1', 'user-1', 'ADMIN', 'Hämta och skapa faktura')

    // Human-in-the-loop: en tur som föreslår något bindande kör ingenting.
    expect(executeTool).not.toHaveBeenCalled()
    expect(res.pendingAction?.toolName).toBe('create_invoice')
    // Och den turen skickas aldrig vidare till modellen, så inget halvt par kan
    // uppstå av den.
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('persisterar ALDRIG tool_use i historiken, ens när iterationstaket nås', async () => {
    // Fyra tool-turer i rad: loopen ger upp vid taket (3) med stop_reason
    // fortfarande 'tool_use'. Det var så konversationer förgiftades.
    const { service, prisma } = makeService([
      toolTurn([{ id: 'toolu_1', name: 'get_properties' }]),
      toolTurn([{ id: 'toolu_2', name: 'get_properties' }]),
      toolTurn([{ id: 'toolu_3', name: 'get_properties' }]),
      toolTurn([{ id: 'toolu_4', name: 'get_properties' }]),
    ])

    await service.chat('org-1', 'user-1', 'ADMIN', 'Loopa')

    const persisted = prisma.aiMessage.create.mock.calls
      .map(([arg]) => (arg as { data: { blocks?: unknown } }).data.blocks)
      .filter(Boolean)
    for (const blocks of persisted) {
      expect(JSON.stringify(blocks)).not.toContain('tool_use')
    }
  })
})
