/**
 * AI-hål #3 — SSE-chatten (GET /ai/chat/stream) extraherar nu minnen efter avslutad
 * stream, via EXAKT samma delade väg som non-stream chat().
 *
 * Del 1 (delad metod, AiAssistantService.extractMemoriesInBackground):
 *   • anropar memory.extractAndSaveMemories med (userMessage, reply, org, userId)
 *   • fire-and-forget: returnerar void synkront, väntar aldrig in extraktionen
 *   • ett extraktionsfel kastar ALDRIG (fångas) → kan inte störa svaret/streamen
 *
 * Del 2 (SSE-controllern):
 *   • efter avslutad (icke-action) stream anropas extractMemoriesInBackground med
 *     användarens meddelande + det ACKUMULERADE svaret + (org, user) från JWT
 *   • på en pending action extraheras INGET minne (precis som non-stream)
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

// Kontrollerbar fejk-ström för controllerns `new Anthropic().messages.stream()`.
const mockFinalMessage = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      stream: () => ({
        on: (event: string, cb: (d: string) => void) => {
          // Simulera att svaret strömmas i en bit (ackumuleras i assistantText).
          if (event === 'text') cb('Hej, jag hjälper dig.')
        },
        finalMessage: mockFinalMessage,
      }),
    },
  })),
}))

import { AiAssistantService } from './ai-assistant.service'
import { AiAssistantController } from './ai-assistant.controller'

// ── Del 1: delad metod ─────────────────────────────────────────────────────────
function makeService(extractImpl?: () => Promise<void>) {
  const extractAndSaveMemories = jest.fn(extractImpl ?? (() => Promise.resolve()))
  const memory = { extractAndSaveMemories }
  const service = new AiAssistantService(
    {} as never, // 1 prisma
    { get: () => '' } as never, // 2 config
    {} as never, // 3 dataContext
    {} as never, // 4 toolExecutor
    memory as never, // 5 memory
    {} as never, // 6 usage
    {} as never, // 7 quota
    {} as never, // 8 audit
    {} as never, // 9 legalRetrieval — nås aldrig (inga juridiska frågor i denna spec)
  )
  return { service, extractAndSaveMemories }
}

describe('AiAssistantService.extractMemoriesInBackground — delad väg', () => {
  it('anropar memory.extractAndSaveMemories med (userMessage, reply, org, userId)', () => {
    const { service, extractAndSaveMemories } = makeService()
    service.extractMemoriesInBackground('användarens fråga', 'AI:ns svar', 'org-1', 'user-1')
    expect(extractAndSaveMemories).toHaveBeenCalledWith(
      'användarens fråga',
      'AI:ns svar',
      'org-1',
      'user-1',
    )
  })

  it('fire-and-forget: returnerar void synkront även om extraktionen aldrig resolvar', () => {
    const { service } = makeService(() => new Promise<void>(() => {})) // resolvar aldrig
    const ret = service.extractMemoriesInBackground('q', 'a', 'org-1', 'user-1')
    expect(ret).toBeUndefined() // väntar aldrig in extraktionen
  })

  it('ett extraktionsfel kastar ALDRIG (kan inte störa svaret/streamen)', async () => {
    const { service } = makeService(() => Promise.reject(new Error('Haiku nere')))
    expect(() => service.extractMemoriesInBackground('q', 'a', 'org-1', 'user-1')).not.toThrow()
    // Flusha microtasks — en ofångad rejection skulle fälla testet.
    await new Promise((r) => setImmediate(r))
  })
})

// ── Del 2: SSE-controllern ──────────────────────────────────────────────────────
function makeController() {
  const aiService = {
    buildMessageHistoryForClaude: jest.fn().mockResolvedValue([]),
    extractMemoriesInBackground: jest.fn(),
    enrichDoubleConfirmContext: jest.fn().mockResolvedValue(undefined),
    buildConfirmation: jest.fn().mockReturnValue({ confirmationMessage: 'Bekräfta?', details: {} }),
    recordPendingAction: jest.fn().mockResolvedValue(undefined),
    // Juridiska grinden (PR 2.3b): null = ej juridisk fråga → ingen grundning.
    resolveLegalGrounding: jest.fn().mockResolvedValue(null),
  }
  const memoryService = { getMemories: jest.fn().mockResolvedValue('') }
  const dataContext = {
    buildContext: jest.fn().mockResolvedValue(''),
    getCurrentDateContext: jest.fn().mockReturnValue('Datum: idag'),
  }
  const usageService = { logUsage: jest.fn().mockResolvedValue(undefined) }
  const quotaService = {
    checkQuota: jest.fn().mockResolvedValue(undefined),
    checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
  }
  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'c1', messages: [] }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
  }
  const configService = { get: jest.fn().mockReturnValue('') }
  const controller = new AiAssistantController(
    aiService as never,
    memoryService as never,
    {} as never, // portfolioAnalysisService
    dataContext as never,
    {} as never, // toolExecutor
    usageService as never,
    quotaService as never,
    prisma as never,
    configService as never,
  )
  const reply = { raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() } }
  return { controller, aiService, reply }
}

const user = { sub: 'user-1', role: 'ADMIN', organizationId: 'org-1' } as never

describe('SSE streamChat — minnesextraktion efter avslutad stream', () => {
  afterEach(() => mockFinalMessage.mockReset())

  it('avslutad textstream → extractMemoriesInBackground anropas med (meddelande, ackumulerat svar, org, user)', async () => {
    const { controller, aiService, reply } = makeController()
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'Hej, jag hjälper dig.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    await controller.streamChat('Vad är min hyresintäkt?', undefined, 'org-1', user, reply as never)

    expect(aiService.extractMemoriesInBackground).toHaveBeenCalledTimes(1)
    expect(aiService.extractMemoriesInBackground).toHaveBeenCalledWith(
      'Vad är min hyresintäkt?', // användarens meddelande
      'Hej, jag hjälper dig.', // ACKUMULERADE svaret från streamen
      'org-1', // org från JWT
      'user-1', // user från JWT
    )
    // Extraktionen sker EFTER att svaret strömmats klart (done skickas).
    const events = reply.raw.write.mock.calls.map((c) => String(c[0]))
    expect(events.some((e) => e.includes('event: done'))).toBe(true)
  })

  it('pending action (ACTION_TOOL) → INGEN minnesextraktion (som non-stream)', async () => {
    const { controller, aiService } = makeController()
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't1', name: 'create_invoice', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2 },
    })
    const reply = { raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() } }

    await controller.streamChat('Skapa en faktura', undefined, 'org-1', user, reply as never)

    expect(aiService.extractMemoriesInBackground).not.toHaveBeenCalled()
  })
})
