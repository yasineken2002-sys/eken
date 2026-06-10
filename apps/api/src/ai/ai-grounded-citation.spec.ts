/**
 * Etapp 2, PR 2.3a — END-TO-END-BEVIS för citat-integriteten (gap A) genom
 * operator-AI:ns båda produktionsvägar (non-stream chat() + SSE streamChat),
 * med mockad Anthropic-klient:
 *
 *   • juridisk fråga → verifierad lagtext injiceras som EGET systemblock
 *     (efter cache-breakpointen — invaliderar aldrig det cachade prefixet)
 *   • svaret avslutas med den KOD-BUNDNA källraden, byggd ur de hämtade
 *     chunkarnas metadata INNAN AI:n svarade
 *   • även när den mockade "AI:n" (mot instruktion) hallucinerar ett lagrum i
 *     sin text är den auktoritativa källsektionen exakt den metadata-byggda —
 *     AI-texten kan inte påverka den
 *   • operativ fråga → inget lagtextblock, ingen källrad
 *   • pending actions får aldrig en källrad
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

// Kontrollerbar fejk-ström för SSE-controllerns `new Anthropic().messages.stream()`.
const mockFinalMessage = jest.fn()
const streamCalls: Array<{ system: Array<{ text: string }> }> = []
let streamedText = 'Du kan inte säga upp henne fritt — hon har förlängningsrätt.'
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      stream: (args: { system: Array<{ text: string }> }) => {
        streamCalls.push(args)
        return {
          on: (event: string, cb: (d: string) => void) => {
            if (event === 'text') cb(streamedText)
          },
          finalMessage: mockFinalMessage,
        }
      },
    },
  })),
}))

import { AiAssistantService } from './ai-assistant.service'
import { AiAssistantController } from './ai-assistant.controller'
import { buildLegalGrounding, SOURCE_SUFFIX_MARKER } from './knowledge/grounding/legal-grounding'

const LEGAL_QUESTION =
  'Kan jag säga upp min hyresgäst? Hon har ett förstahands-bostadskontrakt och har bott här i ett år.'
const OPERATIONAL_QUESTION = 'Hur många lediga lägenheter har jag?'

/** Den auktoritativa (kod-skrivna) källsektionen = allt efter sista markören. */
function authoritativeSourceSection(reply: string): string {
  const idx = reply.lastIndexOf(SOURCE_SUFFIX_MARKER)
  return idx === -1 ? '' : reply.slice(idx + SOURCE_SUFFIX_MARKER.length)
}

// ── Del 1: non-stream chat() ───────────────────────────────────────────────────

function makeService(claudeResponse: unknown) {
  const create = jest.fn().mockResolvedValue(claudeResponse)
  const prisma = {
    aiConversation: {
      create: jest.fn().mockResolvedValue({
        id: 'c1',
        organizationId: 'o1',
        userId: 'u1',
        summary: null,
        summarizedUpToMessageId: null,
        messages: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
    aiPendingAction: {
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  }
  const service = new AiAssistantService(
    prisma as never,
    { get: jest.fn().mockReturnValue('test-key') } as never,
    {
      buildContext: jest.fn().mockResolvedValue('PORTFÖLJ'),
      getCurrentDateContext: jest.fn().mockReturnValue('Idag: 2026-06-10'),
    } as never,
    {} as never,
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
  )
  ;(service as unknown as { client: unknown }).client = { messages: { create } }
  return { service, create, prisma }
}

const textResponse = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
})

describe('chat() — kod-bunden källa på grundade svar', () => {
  it('juridisk fråga: lagtexten injiceras som eget systemblock efter cache-breakpointen', async () => {
    const expected = buildLegalGrounding(LEGAL_QUESTION)
    expect(expected).not.toBeNull()

    const { service, create } = makeService(textResponse('Hon har förlängningsrätt.'))
    await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    expect(create).toHaveBeenCalledTimes(1)
    const system = create.mock.calls[0][0].system as Array<{
      text: string
      cache_control?: unknown
    }>
    expect(system).toHaveLength(3)
    // Cache-breakpointen sitter kvar på första blocket; lagtexten ligger sist.
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[2]!.cache_control).toBeUndefined()
    expect(system[2]!.text).toBe(expected!.contextBlock)
    expect(system[2]!.text).toContain('VERIFIERAD LAGTEXT')
  })

  it('svaret avslutas med den kod-bundna källraden och persisteras med den', async () => {
    const expected = buildLegalGrounding(LEGAL_QUESTION)!
    const { service, prisma } = makeService(textResponse('Hon har förlängningsrätt.'))
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    expect(authoritativeSourceSection(res.reply)).toBe(expected.sourceCitation)
    expect(res.reply.startsWith('Hon har förlängningsrätt.')).toBe(true)
    // Persisterat assistant-meddelande innehåller källraden (historiken visar källan).
    const assistantRow = (prisma.aiMessage.create as jest.Mock).mock.calls
      .map((c) => c[0].data)
      .find((d: { role: string }) => d.role === 'assistant')
    expect(assistantRow.content).toBe(res.reply)
  })

  it('BEVIS gap A: hallucinerat lagrum i AI-texten blir ALDRIG den auktoritativa källan', async () => {
    const expected = buildLegalGrounding(LEGAL_QUESTION)!
    const { service } = makeService(
      textResponse('Enligt 999 § hyreslagen (SFS 9999:999) kan du säga upp henne imorgon.'),
    )
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    const source = authoritativeSourceSection(res.reply)
    expect(source).toBe(expected.sourceCitation) // exakt metadata-byggd, oavsett AI-text
    expect(source).not.toContain('9999:999')
    expect(source).not.toContain('999 §')
  })

  it('operativ fråga: inget lagtextblock, ingen källrad', async () => {
    const { service, create } = makeService(textResponse('Du har 3 lediga lägenheter.'))
    const res = await service.chat('o1', 'u1', 'ADMIN', OPERATIONAL_QUESTION)

    const system = create.mock.calls[0][0].system as Array<{ text: string }>
    expect(system).toHaveLength(2)
    expect(res.reply).toBe('Du har 3 lediga lägenheter.')
    expect(res.reply).not.toContain(SOURCE_SUFFIX_MARKER)
  })

  it('pending action får ALDRIG en källrad (även på juridisk fråga)', async () => {
    const { service } = makeService({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'create_invoice',
          input: { amount: 100, tenantName: 'Anna', dueDate: '2026-07-01', description: 'Hyra' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)
    expect(res.pendingAction).toBeDefined()
    expect(res.reply).toBe('')
  })
})

// ── Del 2: SSE streamChat ──────────────────────────────────────────────────────

function makeController() {
  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'c1', messages: [] }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
  }
  const controller = new AiAssistantController(
    {
      buildMessageHistoryForClaude: jest.fn().mockResolvedValue([]),
      extractMemoriesInBackground: jest.fn(),
      enrichDoubleConfirmContext: jest.fn().mockResolvedValue(undefined),
      buildConfirmation: jest
        .fn()
        .mockReturnValue({ confirmationMessage: 'Bekräfta?', details: {} }),
      recordPendingAction: jest.fn().mockResolvedValue(undefined),
    } as never,
    { getMemories: jest.fn().mockResolvedValue('') } as never,
    {} as never,
    {
      buildContext: jest.fn().mockResolvedValue(''),
      getCurrentDateContext: jest.fn().mockReturnValue('Datum: idag'),
    } as never,
    {} as never,
    { logUsage: jest.fn().mockResolvedValue(undefined) } as never,
    {
      checkQuota: jest.fn().mockResolvedValue(undefined),
      checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
    } as never,
    prisma as never,
    { get: jest.fn().mockReturnValue('test-key') } as never,
  )
  const reply = { raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() } }
  return { controller, prisma, reply }
}

const user = { sub: 'user-1', role: 'ADMIN', organizationId: 'org-1' } as never

/** Plockar ut alla SSE-events ur write-anropen. */
function parseEvents(write: jest.Mock): Array<{ event: string; data: { text?: string } }> {
  return write.mock.calls.map(([raw]: [string]) => {
    const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(raw)
    return { event: m![1]!, data: JSON.parse(m![2]!) }
  })
}

describe('SSE streamChat — kod-bunden källa på grundade svar', () => {
  beforeEach(() => {
    streamCalls.length = 0
    mockFinalMessage.mockReset()
    streamedText = 'Du kan inte säga upp henne fritt — hon har förlängningsrätt.'
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: streamedText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  })

  it('juridisk fråga: lagtextblock i system + källsuffix som sista delta + persisterat', async () => {
    const expected = buildLegalGrounding(LEGAL_QUESTION)!
    const { controller, prisma, reply } = makeController()

    await controller.streamChat(LEGAL_QUESTION, undefined, 'org-1', user, reply as never)

    // Systemblocken: cachat prefix + datum + lagtext (sist, utan cache_control).
    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]!.system).toHaveLength(3)
    expect(streamCalls[0]!.system[2]!.text).toBe(expected.contextBlock)

    // Källsuffixet skickas som ett sista delta (skrivet av KOD, efter AI-texten).
    const events = parseEvents(reply.raw.write as jest.Mock)
    const deltas = events.filter((e) => e.event === 'delta')
    expect(deltas[deltas.length - 1]!.data.text).toBe(
      `${SOURCE_SUFFIX_MARKER}${expected.sourceCitation}`,
    )
    expect(events[events.length - 1]!.event).toBe('done')

    // Persisterat assistant-meddelande slutar med den kod-bundna källraden.
    const assistantRow = (prisma.aiMessage.create as jest.Mock).mock.calls
      .map((c) => c[0].data)
      .find((d: { role: string }) => d.role === 'assistant')
    expect(authoritativeSourceSection(assistantRow.content)).toBe(expected.sourceCitation)
  })

  it('BEVIS gap A (SSE): hallucinerat lagrum i streamad AI-text ändrar inte källsektionen', async () => {
    const expected = buildLegalGrounding(LEGAL_QUESTION)!
    streamedText = 'Enligt 999 § hyreslagen (SFS 9999:999) kan du vräka direkt.'
    const { controller, prisma, reply } = makeController()

    await controller.streamChat(LEGAL_QUESTION, undefined, 'org-1', user, reply as never)

    const assistantRow = (prisma.aiMessage.create as jest.Mock).mock.calls
      .map((c) => c[0].data)
      .find((d: { role: string }) => d.role === 'assistant')
    const source = authoritativeSourceSection(assistantRow.content)
    expect(source).toBe(expected.sourceCitation)
    expect(source).not.toContain('9999:999')
  })

  it('operativ fråga: inga lagtextblock och inget källsuffix', async () => {
    streamedText = 'Du har 3 lediga lägenheter.'
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: streamedText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const { controller, reply } = makeController()

    await controller.streamChat(OPERATIONAL_QUESTION, undefined, 'org-1', user, reply as never)

    expect(streamCalls[0]!.system).toHaveLength(2)
    const deltas = parseEvents(reply.raw.write as jest.Mock).filter((e) => e.event === 'delta')
    for (const d of deltas) {
      expect(d.data.text).not.toContain(SOURCE_SUFFIX_MARKER)
    }
  })
})
