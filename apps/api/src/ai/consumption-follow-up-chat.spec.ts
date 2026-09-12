jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
const mockCreate = jest.fn()
const mockStream = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate, stream: mockStream },
  })),
}))

import { AiAssistantService } from './ai-assistant.service'
import { AiAssistantController } from './ai-assistant.controller'
import { CONSUMPTION_JUDGE_SYSTEM, CONSUMPTION_REPLY_NOTICE } from './consumption-reply-guard'
import { consumptionFollowUpFacts } from './consumption-follow-up-facts'
import { MAX_TOOL_ROUNDS, TOOL_ITERATION_CAP_NOTICE } from './tool-iteration-cap'

const data = {
  success: true,
  data: {
    observedAt: '2026-09-09T10:00:00.000Z',
    status: {
      enabled: true,
      enabledAt: '2026-09-08T05:00:00.000Z',
      lastCheckedAt: '2026-09-09T05:15:00.000Z',
      lastFailedAt: null,
    },
  },
}
const final = (text = 'Utebliven notis betyder inga varningar.') => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text, citations: null }],
  usage: { input_tokens: 10, output_tokens: 5 },
})
const read = (name = 'get_consumption_follow_up', id = 'status') => ({
  ...final('Jag läser underlaget.'),
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input: {} }],
})

function setup(
  responses: unknown[],
  execute = jest.fn().mockResolvedValue(data),
  judge = jest.fn().mockReturnValue('[[0,"SUPPORTED"]]'),
) {
  mockCreate.mockReset()
  mockStream.mockReset()
  const chatResponses = [...responses]
  mockCreate.mockImplementation(async (request) => {
    if (request.system === CONSUMPTION_JUDGE_SYSTEM) return final(await judge(request))
    return chatResponses.shift()
  })
  for (const response of responses) {
    mockStream.mockImplementationOnce(() => ({
      on: (event: string, cb: (text: string) => void) => {
        if (event === 'text')
          for (const block of (response as ReturnType<typeof final>).content)
            if (block.type === 'text') cb(block.text)
      },
      finalMessage: jest.fn().mockResolvedValue(response),
    }))
  }
  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'c1',
        messages: [],
        summary: null,
        summarizedUpToMessageId: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
    aiPendingAction: {
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  }
  const config = { get: jest.fn().mockReturnValue('synthetic-test-key') }
  const context = {
    buildContext: jest.fn().mockResolvedValue(''),
    getCurrentDateContext: jest.fn().mockReturnValue('Datum idag'),
  }
  const executor = { executeTool: execute }
  const memory = {
    getMemories: jest.fn().mockResolvedValue(''),
    extractAndSaveMemories: jest.fn().mockResolvedValue(undefined),
  }
  const usage = { logUsage: jest.fn().mockResolvedValue(undefined) }
  const quota = {
    checkQuota: jest.fn().mockResolvedValue(undefined),
    checkOrgDailyCostCap: jest.fn().mockResolvedValue(undefined),
    checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
  }
  const attachments = {
    buildContentBlocks: jest
      .fn()
      .mockResolvedValue({ contentBlocks: [], refBlocks: [], ids: [], encodedBytes: 0 }),
    markConsumed: jest.fn().mockResolvedValue(undefined),
    rehydrateHistoryBlocks: jest.fn().mockImplementation(async (blocks: unknown[]) => blocks),
  }
  const service = new AiAssistantService(
    prisma as never,
    config as never,
    context as never,
    executor as never,
    memory as never,
    usage as never,
    quota as never,
    {} as never,
    {} as never,
    attachments as never,
  )
  jest.spyOn(service, 'resolveLegalGrounding').mockResolvedValue(null)
  jest.spyOn(service, 'extractMemoriesInBackground').mockImplementation(() => undefined)
  jest.spyOn(service, 'enrichDoubleConfirmContext').mockResolvedValue(undefined)
  jest
    .spyOn(service, 'buildConfirmation')
    .mockReturnValue({ confirmationMessage: 'Bekräfta?', details: {} })
  jest.spyOn(service, 'recordPendingAction').mockResolvedValue(undefined)
  const controller = new AiAssistantController(
    service,
    memory as never,
    {} as never,
    context as never,
    executor as never,
    usage as never,
    quota as never,
    prisma as never,
    config as never,
    attachments as never,
  )
  const reply = { raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() } }
  const run = async (mode: string) => {
    reply.raw.write.mockClear()
    if (mode === 'chat')
      return service.chat(
        'org',
        'user',
        'ADMIN',
        'Läs förbrukningsuppföljningen och svara på min andra fråga.',
      )
    await controller.streamChat(
      'Läs förbrukningsuppföljningen och svara på min andra fråga.',
      undefined,
      undefined,
      'org',
      { sub: 'user', role: 'ADMIN' } as never,
      reply as never,
    )
    const events = reply.raw.write.mock.calls.map(([raw]: [string]) => {
      const match = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(raw)!
      return { event: match[1], data: JSON.parse(match[2]!) }
    })
    expect(events.some((event) => event.event === 'error')).toBe(false)
    return {
      reply: events
        .filter((event) => event.event === 'delta')
        .map((event) => event.data.text)
        .join(''),
      pendingAction: events.find((event) => event.event === 'pending_action')?.data,
    }
  }
  const assistant = () =>
    prisma.aiMessage.create.mock.calls
      .map(([args]) => args.data)
      .find((row) => row.role === 'assistant')
  return { run, assistant, prisma, service, execute, usage, judge, quota, reply }
}

describe.each(['chat', 'SSE'])('%s — faktablock genom produktionsvägen', (mode) => {
  it('ger samma kontrollerade fakta trots ett falskt modellsvar, sparat även i återspelad historik', async () => {
    const f = setup([read(), final()], undefined, jest.fn().mockReturnValue('[[0,"UNSUPPORTED"]]'))
    const answer = await f.run(mode)
    const facts = consumptionFollowUpFacts(data)
    expect(answer.reply).not.toContain('Utebliven notis betyder inga varningar.')
    expect(answer.reply).toContain(CONSUMPTION_REPLY_NOTICE)
    expect(answer.reply.endsWith(facts)).toBe(true)
    expect(f.assistant().content).toBe(answer.reply)
    expect(f.assistant().blocks.at(-1).text).toBe(answer.reply)
    expect(f.assistant().blocks.some((b: { type: string }) => b.type === 'tool_use')).toBe(false)
    const history = await f.service.buildMessageHistoryForClaude({
      id: 'c1',
      organizationId: 'org',
      userId: 'user',
      summary: null,
      summarizedUpToMessageId: null,
      messages: [
        {
          id: 'saved',
          role: 'assistant',
          content: f.assistant().content,
          blocks: f.assistant().blocks,
          createdAt: new Date(),
        },
      ],
    } as never)
    expect(JSON.stringify(history)).toContain('En utebliven notis bevisar inte')
    expect(JSON.stringify(history)).not.toContain('Utebliven notis betyder inga varningar.')
    expect(f.service.extractMemoriesInBackground).toHaveBeenCalledWith(
      expect.any(String),
      answer.reply,
      'org',
      'user',
    )
  })

  it('behåller andra verktyg och svar utan att blanda in deras data i statusfakta', async () => {
    const first = read()
    first.content.push({ type: 'tool_use', id: 'properties', name: 'get_properties', input: {} })
    const f = setup(
      [first, final('Det finns två fastigheter.')],
      jest
        .fn()
        .mockImplementation(async (name) =>
          name === 'get_consumption_follow_up'
            ? data
            : { success: true, data: { ...data.data, state: 'avstängd' } },
        ),
    )
    const answer = await f.run(mode)
    expect(answer.reply).toContain('Det finns två fastigheter.')
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(answer.reply.endsWith(consumptionFollowUpFacts(data))).toBe(true)
  })

  it('tar bara bort det avvisade stycket i ett blandat svar, innan visning och lagring', async () => {
    const judge = jest.fn().mockReturnValue('[[0,"OTHER"],[1,"UNSUPPORTED"],[2,"OTHER"]]')
    const f = setup(
      [
        read(),
        final(
          'Det finns två fastigheter.\n\nInga notiser betyder inga varningar.\n\nÖppna fastighetslistan.',
        ),
      ],
      undefined,
      judge,
    )
    const answer = await f.run(mode)
    expect(answer.reply).toContain('Det finns två fastigheter.\n\nÖppna fastighetslistan.')
    expect(answer.reply).not.toContain('Inga notiser betyder inga varningar.')
    expect(JSON.stringify(f.prisma.aiMessage.create.mock.calls)).not.toContain(
      'Inga notiser betyder inga varningar.',
    )
    expect(JSON.stringify(f.reply.raw.write.mock.calls)).not.toContain(
      'Inga notiser betyder inga varningar.',
    )
  })

  it.each(['timeout', 'invalid', 'cap'])(
    'stänger grinden vid %s utan att röja utkast eller råfel',
    async (failure) => {
      const judge =
        failure === 'timeout'
          ? jest.fn().mockRejectedValue(new Error('privat anslutningsfel'))
          : jest.fn().mockReturnValue('JA')
      const f = setup([read(), final()], undefined, judge)
      if (failure === 'cap')
        f.quota.checkOrgDailyCostCap.mockRejectedValue(new Error('kostnadstak'))
      const answer = await f.run(mode)
      expect(answer.reply).toContain(CONSUMPTION_REPLY_NOTICE)
      expect(answer.reply).toContain(consumptionFollowUpFacts(data))
      expect(answer.reply).not.toMatch(/Utebliven notis betyder|privat anslutningsfel|kostnadstak/)
      if (failure === 'cap') expect(judge).not.toHaveBeenCalled()
    },
  )

  it('bokför domarkostnaden på samma organisation och användare utan en extra credit-kontroll', async () => {
    const f = setup([read(), final('Statusen kunde läsas.')])
    await f.run(mode)
    expect(f.quota.checkQuota).toHaveBeenCalledTimes(1)
    expect(f.usage.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org',
        userId: 'user',
        endpoint: 'consumption-judge',
        isAutomated: false,
        source: 'consumption_judge',
      }),
    )
    const call = mockCreate.mock.calls.find(
      ([request]) => request.system === CONSUMPTION_JUDGE_SYSTEM,
    )
    expect(call![1]).toEqual({ timeout: 30_000, maxRetries: 0 })
    expect(call![0]).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 4096,
      output_config: { effort: 'low' },
    })
    expect(call![0]).not.toHaveProperty('temperature')
    expect(JSON.parse(call![0].messages[0].content).authenticatedRole).toBe('ADMIN')
  })

  it('inväntar domen innan första synliga texten och innan assistenten sparas', async () => {
    let release!: (value: string) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const verdict = new Promise<string>((resolve) => {
      release = resolve
    })
    const judge = jest.fn().mockImplementation(() => {
      entered()
      return verdict
    })
    const f = setup([read(), final()], undefined, judge)
    const pending = f.run(mode)
    await started
    expect(f.assistant()).toBeUndefined()
    expect(f.reply.raw.write.mock.calls.some(([raw]) => raw.startsWith('event: delta\n'))).toBe(
      false,
    )
    release('[[0,"UNSUPPORTED"]]')
    const answer = await pending
    expect(answer.reply).not.toContain('Utebliven notis betyder inga varningar.')
  })

  it('ett nytt läsfel ersätter äldre lyckad status och röjer ingen rå feltext', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(data)
      .mockRejectedValueOnce(new Error('intern anslutningshemlighet'))
    const f = setup(
      [read(), read('get_consumption_follow_up', 'again'), final('Jag kan inte läsa den igen.')],
      execute,
    )
    const answer = await f.run(mode)
    const section = answer.reply.slice(answer.reply.lastIndexOf('────'))
    expect(section).toContain('Statusen kunde inte läsas')
    expect(section).not.toContain('är påslagen')
    expect(section).not.toContain('intern anslutningshemlighet')
    expect(f.assistant().blocks.at(-1).text).toBe(answer.reply)
  })

  it('ett påstående om läsning utan verktygsanrop tilldelas aldrig ett faktablock', async () => {
    const f = setup(
      [final('Jag har kontrollerat statusen, den är påslagen.')],
      undefined,
      jest.fn().mockReturnValue('[[0,"UNSUPPORTED"]]'),
    )
    const answer = await f.run(mode)
    expect(f.execute).not.toHaveBeenCalled()
    expect(answer.reply).not.toContain('Uppföljningsstatus från systemet')
    expect(f.assistant().content).not.toContain('den är påslagen')
    expect(f.assistant().blocks[0].text).toBe(answer.reply)
  })

  it('en efterföljande tur utan ny statusläsning får inte återanvända gamla fakta som nya', async () => {
    const f = setup([read(), final(), final('Ett begreppssvar.')])
    await f.run(mode)
    const second = await f.run(mode)
    expect(second.reply).toBe('Ett begreppssvar.')
  })

  it('behåller turtakets varning efter fakta och ger inget besked om en okörd läsning', async () => {
    const f = setup([
      ...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, i) =>
        read('get_consumption_follow_up', String(i)),
      ),
    ])
    const answer = await f.run(mode)
    expect(f.execute).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(answer.reply).toContain(consumptionFollowUpFacts(data))
    expect(answer.reply.endsWith(TOOL_ITERATION_CAP_NOTICE)).toBe(true)
    expect(f.assistant().blocks.at(-1).text.endsWith(TOOL_ITERATION_CAP_NOTICE)).toBe(true)
  })

  it('bekräftelsevägen bevaras; inget skrivverktyg utförs och inget falskt avslutat svar sparas', async () => {
    const f = setup([read(), read('create_property', 'action')])
    const answer = await f.run(mode)
    expect(answer.pendingAction).toBeDefined()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.assistant()).toBeUndefined()
    expect(answer.reply).not.toContain('Uppföljningsstatus från systemet')
  })
})

describe('SSE — förklaring till en väntande bekräftelse', () => {
  const proposal = (parts: string[]) => ({
    ...read('create_property', 'action'),
    content: [
      ...parts.map((text) => ({ type: 'text', text, citations: null })),
      { type: 'tool_use', id: 'action', name: 'create_property', input: { name: 'Björken' } },
    ],
  })

  it('skickar alla textdelar exakt en gång före en registrerad pending action, utan exekvering', async () => {
    const parts = [
      'Jag föreslår fastigheten Björken. ',
      'Kontrollera uppgifterna innan du bekräftar.',
    ]
    const f = setup([proposal(parts)])
    const answer = await f.run('SSE')
    expect(answer.reply).toBe(parts.join(''))
    expect(answer.pendingAction).toMatchObject({
      conversationId: 'c1',
      toolName: 'create_property',
      toolInput: { name: 'Björken' },
      confirmationMessage: 'Bekräfta?',
    })
    const wire = f.reply.raw.write.mock.calls.map(([raw]: [string]) => raw)
    expect(wire.filter((raw) => raw.startsWith('event: delta\n'))).toHaveLength(1)
    expect(wire.filter((raw) => raw.startsWith('event: pending_action\n'))).toHaveLength(1)
    expect(wire.findIndex((raw) => raw.startsWith('event: delta\n'))).toBeLessThan(
      wire.findIndex((raw) => raw.startsWith('event: pending_action\n')),
    )
    expect(f.service.recordPendingAction).toHaveBeenCalledWith(
      'c1',
      'org',
      'user',
      'create_property',
      { name: 'Björken' },
    )
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.judge).not.toHaveBeenCalled()
    expect(f.assistant()).toBeUndefined()
    expect(f.service.extractMemoriesInBackground).not.toHaveBeenCalled()
  })

  it('lämnar inte ut förklaringen eller kortet innan pending-registreringen lyckats', async () => {
    const f = setup([proposal(['Förslag som ännu inte är registrerat.'])])
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    jest.spyOn(f.service, 'recordPendingAction').mockImplementation(() => {
      entered()
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const running = f.run('SSE')
    await started
    expect(
      f.reply.raw.write.mock.calls.some(([raw]) => /event: (delta|pending_action)\n/.test(raw)),
    ).toBe(false)
    release()
    const answer = await running
    expect(answer.reply).toBe('Förslag som ännu inte är registrerat.')
    expect(answer.pendingAction).toBeDefined()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('ger ingen bekräftelsetext eller pending action när registreringen misslyckas', async () => {
    const f = setup([proposal(['Det här förslaget kunde inte registreras.'])])
    jest
      .spyOn(f.service, 'recordPendingAction')
      .mockRejectedValue(new Error('syntetiskt registreringsfel'))
    // Riggans run kräver normalt ett felfritt SSE-svar. Här ska dess kontroll falla.
    await expect(f.run('SSE')).rejects.toThrow()
    const wire = f.reply.raw.write.mock.calls.map(([raw]: [string]) => raw)
    expect(
      wire.some(
        (raw) => raw.startsWith('event: error\n') && raw.includes('syntetiskt registreringsfel'),
      ),
    ).toBe(true)
    expect(wire.some((raw) => /event: (delta|pending_action)\n/.test(raw))).toBe(false)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.assistant()).toBeUndefined()
  })

  it('bevarar en textlös bekräftelse utan tomt delta eller påhittad modelltext', async () => {
    const f = setup([proposal([])])
    const answer = await f.run('SSE')
    expect(answer.reply).toBe('')
    expect(answer.pendingAction).toBeDefined()
    expect(f.reply.raw.write.mock.calls.some(([raw]) => raw.startsWith('event: delta\n'))).toBe(
      false,
    )
    expect(f.execute).not.toHaveBeenCalled()
  })
})
