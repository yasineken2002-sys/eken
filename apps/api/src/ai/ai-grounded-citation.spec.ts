/**
 * Etapp 2, PR 2.3a + 2.3b — END-TO-END-BEVIS för citat-integriteten (gap A)
 * och miss-grinden (gap B) genom operator-AI:ns båda produktionsvägar
 * (non-stream chat() + SSE streamChat), med mockad Anthropic-klient:
 *
 *   • juridisk fråga med god träff: relevansdomaren (Haiku) tillfrågas, och
 *     vid JA injiceras verifierad lagtext som EGET systemblock (efter
 *     cache-breakpointen) + svaret avslutas med den KOD-BUNDNA källraden
 *   • domaren säger NEJ (eller är otillgänglig): ärligt miss-block injiceras,
 *     INGEN källrad sätts — det fanns inget att grunda i (fail-safe)
 *   • deterministiskt svag träff: miss UTAN domaranrop (ingen Haiku-kostnad)
 *   • hallucinerat lagrum i AI-texten blir ALDRIG den auktoritativa källan
 *   • operativ fråga → varken domare, lagtextblock eller källrad
 *   • pending actions får aldrig en källrad
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

// Kontrollerbar fejk-ström för SSE-controllerns `new Anthropic().messages.stream()`.
const mockFinalMessage = jest.fn()
const streamCalls: Array<{ system: Array<{ text: string; cache_control?: unknown }> }> = []
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
import {
  evaluateLegalRetrieval,
  groundLegalCandidate,
  buildLegalGroundingMiss,
  SOURCE_SUFFIX_MARKER,
  type LegalGrounding,
} from './knowledge/grounding/legal-grounding'
import { AI_MODELS } from './ai.config'

const LEGAL_QUESTION =
  'Kan jag säga upp min hyresgäst? Hon har ett förstahands-bostadskontrakt och har bott här i ett år.'
const WEAK_LEGAL_QUESTION = 'Hur stor deposition (säkerhet) får jag kräva av en hyresgäst?'
const OPERATIONAL_QUESTION = 'Hur många lediga lägenheter har jag?'

/** Förväntad grundning om domaren säger JA (samma byggare som produktionen). */
function expectedGrounding(question: string): LegalGrounding {
  const candidate = evaluateLegalRetrieval(question)
  if (candidate?.outcome !== 'candidate') throw new Error('Frågan är ingen kandidat')
  return groundLegalCandidate(candidate.retrieved)
}

/** Den auktoritativa (kod-skrivna) källsektionen = allt efter sista markören. */
function authoritativeSourceSection(reply: string): string {
  const idx = reply.lastIndexOf(SOURCE_SUFFIX_MARKER)
  return idx === -1 ? '' : reply.slice(idx + SOURCE_SUFFIX_MARKER.length)
}

// ── Del 1: non-stream chat() ───────────────────────────────────────────────────

function makeService(
  claudeResponse: unknown,
  opts: { judgeText?: string; judgeError?: boolean } = {},
) {
  // Routar per modell: Haiku (AI_MODELS.MEMORY) = relevansdomaren, övriga = chatten.
  const create = jest.fn().mockImplementation((args: { model: string }) => {
    if (args.model === AI_MODELS.MEMORY) {
      if (opts.judgeError) return Promise.reject(new Error('Haiku nere'))
      return Promise.resolve({
        content: [{ type: 'text', text: opts.judgeText ?? 'JA' }],
        usage: { input_tokens: 5, output_tokens: 1 },
      })
    }
    return Promise.resolve(claudeResponse)
  })
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

/** Plockar ut chat-anropen (icke-domare) ur create-mocken. */
function chatCalls(create: jest.Mock): Array<{ model: string; system: Array<unknown> }> {
  return create.mock.calls.map(([args]) => args).filter((a) => a.model !== AI_MODELS.MEMORY)
}
function judgeCalls(create: jest.Mock): Array<{ model: string }> {
  return create.mock.calls.map(([args]) => args).filter((a) => a.model === AI_MODELS.MEMORY)
}

describe('chat() — kod-bunden källa på grundade svar (domare: JA)', () => {
  it('juridisk fråga: domaren tillfrågas och lagtexten injiceras som eget systemblock', async () => {
    const expected = expectedGrounding(LEGAL_QUESTION)

    const { service, create } = makeService(textResponse('Hon har förlängningsrätt.'))
    await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    expect(judgeCalls(create)).toHaveLength(1)
    const chats = chatCalls(create)
    expect(chats).toHaveLength(1)
    const system = chats[0]!.system as Array<{ text: string; cache_control?: unknown }>
    expect(system).toHaveLength(3)
    // Cache-hierarkin (PR 2.4): prefix-breakpointen kvar på första blocket,
    // lagtextblocket sist med EGET breakpoint, datumblocket emellan ocachat.
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]!.cache_control).toBeUndefined()
    expect(system[2]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[2]!.text).toBe(expected.contextBlock)
    expect(system[2]!.text).toContain('VERIFIERAD LAGTEXT')
    // Max 4 breakpoints per request: TOOLS (1, låst av tool-caching.spec) +
    // dessa 2 i system = 3 totalt. Fler än 2 i system får aldrig smyga in.
    expect(system.filter((b) => b.cache_control).length).toBe(2)
  })

  it('svaret avslutas med den kod-bundna källraden och persisteras med den', async () => {
    const expected = expectedGrounding(LEGAL_QUESTION)
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
    const expected = expectedGrounding(LEGAL_QUESTION)
    const { service } = makeService(
      textResponse('Enligt 999 § hyreslagen (SFS 9999:999) kan du säga upp henne imorgon.'),
    )
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    const source = authoritativeSourceSection(res.reply)
    expect(source).toBe(expected.sourceCitation) // exakt metadata-byggd, oavsett AI-text
    expect(source).not.toContain('9999:999')
    expect(source).not.toContain('999 §')
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

describe('chat() — MISS-GRINDEN (gap B): svag/fel träff → ärlighet, ingen källrad', () => {
  it('domaren säger NEJ → miss-block injiceras och INGEN källrad sätts', async () => {
    const { service, create } = makeService(
      textResponse('Jag hittar inte den exakta regeln — stäm av med jurist.'),
      { judgeText: 'NEJ' },
    )
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    const system = chatCalls(create)[0]!.system as Array<{
      text: string
      cache_control?: unknown
    }>
    expect(system).toHaveLength(3)
    expect(system[2]!.text).toContain('UTAN TILLRÄCKLIGT LAGSTÖD')
    expect(system[2]!.text).not.toContain('VERIFIERAD LAGTEXT (hämtad')
    // PR 2.4: även miss-blocket bär breakpointet (samma kodväg som lagtexten).
    expect(system[2]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(res.reply).not.toContain(SOURCE_SUFFIX_MARKER)
    expect(res.reply).not.toContain('Detta svar bygger på verifierad lagtext')
  })

  it('fail-safe: domaren kraschar → miss (hellre jurist-hänvisning än overifierad grund)', async () => {
    const { service, create } = makeService(textResponse('Det bör en jurist bekräfta.'), {
      judgeError: true,
    })
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)

    const system = chatCalls(create)[0]!.system as Array<{ text: string }>
    expect(system[2]!.text).toContain('UTAN TILLRÄCKLIGT LAGSTÖD')
    expect(res.reply).not.toContain(SOURCE_SUFFIX_MARKER)
  })

  it('fail-safe: ogiltigt domarsvar ("Kanske") → miss', async () => {
    const { service, create } = makeService(textResponse('Det bör en jurist bekräfta.'), {
      judgeText: 'Kanske',
    })
    const res = await service.chat('o1', 'u1', 'ADMIN', LEGAL_QUESTION)
    expect((chatCalls(create)[0]!.system as Array<{ text: string }>)[2]!.text).toContain(
      'UTAN TILLRÄCKLIGT LAGSTÖD',
    )
    expect(res.reply).not.toContain(SOURCE_SUFFIX_MARKER)
  })

  it('deterministiskt svag träff → miss UTAN domaranrop (ingen Haiku-kostnad)', async () => {
    const { service, create } = makeService(
      textResponse('Det finns ingen exakt lagregel om depositionens storlek.'),
    )
    const res = await service.chat('o1', 'u1', 'ADMIN', WEAK_LEGAL_QUESTION)

    expect(judgeCalls(create)).toHaveLength(0) // steg 1 fällde — steg 2 kostar aldrig
    const system = chatCalls(create)[0]!.system as Array<{ text: string }>
    expect(system).toHaveLength(3)
    expect(system[2]!.text).toContain('UTAN TILLRÄCKLIGT LAGSTÖD')
    expect(res.reply).not.toContain(SOURCE_SUFFIX_MARKER)
  })

  it('operativ fråga: varken domare, lagtextblock eller källrad', async () => {
    const { service, create } = makeService(textResponse('Du har 3 lediga lägenheter.'))
    const res = await service.chat('o1', 'u1', 'ADMIN', OPERATIONAL_QUESTION)

    expect(judgeCalls(create)).toHaveLength(0)
    const system = chatCalls(create)[0]!.system as Array<{
      text: string
      cache_control?: unknown
    }>
    expect(system).toHaveLength(2)
    // Utan grundning finns bara prefix-breakpointet i system (+ TOOLS = 2 totalt).
    expect(system.filter((b) => b.cache_control).length).toBe(1)
    expect(res.reply).toBe('Du har 3 lediga lägenheter.')
    expect(res.reply).not.toContain(SOURCE_SUFFIX_MARKER)
  })
})

// ── Del 2: SSE streamChat ──────────────────────────────────────────────────────

function makeController(groundingResult: unknown) {
  const resolveLegalGrounding = jest.fn().mockResolvedValue(groundingResult)
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
      resolveLegalGrounding,
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
  return { controller, prisma, reply, resolveLegalGrounding }
}

const user = { sub: 'user-1', role: 'ADMIN', organizationId: 'org-1' } as never

/** Plockar ut alla SSE-events ur write-anropen. */
function parseEvents(write: jest.Mock): Array<{ event: string; data: { text?: string } }> {
  return write.mock.calls.map(([raw]: [string]) => {
    const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(raw)
    return { event: m![1]!, data: JSON.parse(m![2]!) }
  })
}

describe('SSE streamChat — delad grind + kod-bunden källa', () => {
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

  it('grundad fråga: delad grind anropas, lagtextblock i system + källsuffix som sista delta', async () => {
    const expected = expectedGrounding(LEGAL_QUESTION)
    const { controller, prisma, reply, resolveLegalGrounding } = makeController(expected)

    await controller.streamChat(LEGAL_QUESTION, undefined, 'org-1', user, reply as never)

    // Exakt samma delade grind som non-stream chat().
    expect(resolveLegalGrounding).toHaveBeenCalledWith(LEGAL_QUESTION, 'org-1', 'user-1')

    // Systemblocken: cachat prefix + datum + lagtext (sist, eget breakpoint PR 2.4).
    expect(streamCalls).toHaveLength(1)
    expect(streamCalls[0]!.system).toHaveLength(3)
    expect(streamCalls[0]!.system[2]!.text).toBe(expected.contextBlock)
    expect(streamCalls[0]!.system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(streamCalls[0]!.system[2]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(streamCalls[0]!.system.filter((b) => b.cache_control).length).toBe(2)

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
    const expected = expectedGrounding(LEGAL_QUESTION)
    streamedText = 'Enligt 999 § hyreslagen (SFS 9999:999) kan du vräka direkt.'
    const { controller, prisma, reply } = makeController(expected)

    await controller.streamChat(LEGAL_QUESTION, undefined, 'org-1', user, reply as never)

    const assistantRow = (prisma.aiMessage.create as jest.Mock).mock.calls
      .map((c) => c[0].data)
      .find((d: { role: string }) => d.role === 'assistant')
    const source = authoritativeSourceSection(assistantRow.content)
    expect(source).toBe(expected.sourceCitation)
    expect(source).not.toContain('9999:999')
  })

  it('MISS (gap B, SSE): miss-block injiceras men INGET källsuffix strömmas eller persisteras', async () => {
    streamedText = 'Jag hittar inte den exakta regeln — det bör en jurist bekräfta.'
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: streamedText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const miss = buildLegalGroundingMiss('judge-rejected')
    const { controller, prisma, reply } = makeController(miss)

    await controller.streamChat(LEGAL_QUESTION, undefined, 'org-1', user, reply as never)

    expect(streamCalls[0]!.system).toHaveLength(3)
    expect(streamCalls[0]!.system[2]!.text).toContain('UTAN TILLRÄCKLIGT LAGSTÖD')
    const deltas = parseEvents(reply.raw.write as jest.Mock).filter((e) => e.event === 'delta')
    for (const d of deltas) {
      expect(d.data.text).not.toContain(SOURCE_SUFFIX_MARKER)
    }
    const assistantRow = (prisma.aiMessage.create as jest.Mock).mock.calls
      .map((c) => c[0].data)
      .find((d: { role: string }) => d.role === 'assistant')
    expect(assistantRow.content).not.toContain('Detta svar bygger på verifierad lagtext')
  })

  it('operativ fråga (grind → null): inga extra systemblock och inget källsuffix', async () => {
    streamedText = 'Du har 3 lediga lägenheter.'
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: streamedText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const { controller, reply } = makeController(null)

    await controller.streamChat(OPERATIONAL_QUESTION, undefined, 'org-1', user, reply as never)

    expect(streamCalls[0]!.system).toHaveLength(2)
    const deltas = parseEvents(reply.raw.write as jest.Mock).filter((e) => e.event === 'delta')
    for (const d of deltas) {
      expect(d.data.text).not.toContain(SOURCE_SUFFIX_MARKER)
    }
  })
})
