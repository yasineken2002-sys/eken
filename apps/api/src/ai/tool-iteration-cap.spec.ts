jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * TURTAKET — ett avbrutet arbete får aldrig se ut som ett färdigt svar.
 *
 * Taket låg som `= 3` på tre ställen. När det nåddes föll loopen ur, sista
 * textblocket skrevs ut, inget fel kastades och ingen markering gjordes. AI:n
 * kunde alltså SE UT att ha utfört en uppgift när den stannade halvvägs — den
 * värsta felmoden i ett system som rör pengar, för den ser ut som framgång.
 *
 * ── VAD VARJE GRUPP SKULLE FÄLLA ─────────────────────────────────────────────
 *
 * (1) PREDIKATET   faller om taket kan nås utan att markeras, eller om
 *                  markeringen börjar utlösas på ett färdigt svar.
 * (2) TAKET NÅS    faller om markeringen försvinner ur svaret.
 * (3) TAKET NÅS EJ faller om vi byggt ett larm som alltid larmar.
 * (4) ETT VÄRDE    faller om en fjärde konstant införs eller looparna driftar.
 */

const mockFinalMessage = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      stream: () => ({
        on: (event: string, cb: (d: string) => void) => {
          if (event === 'text') cb('Jag ska bara kolla en sak...')
        },
        finalMessage: mockFinalMessage,
      }),
    },
  })),
}))

import { AiAssistantController } from './ai-assistant.controller'
import {
  MAX_TOOL_ROUNDS,
  reachedToolIterationCap,
  TOOL_ITERATION_CAP_NOTICE,
  wantsAnotherToolRound,
} from './tool-iteration-cap'

describe('(1) predikatet — BÅDA villkoren krävs', () => {
  it('KANARIEFÅGEL: de två villkoren är inte utbytbara mot varandra', () => {
    // Om något av dem ensamt räckte vore det andra dekoration. Fallen nedan
    // MÅSTE skilja sig åt, annars mäter resten av filen ingenting.
    expect(reachedToolIterationCap('tool_use', MAX_TOOL_ROUNDS)).toBe(true)
    // Bara räknaren: modellen blev KLAR på precis sista varvet → fullständigt svar.
    expect(reachedToolIterationCap('end_turn', MAX_TOOL_ROUNDS)).toBe(false)
    // Bara stop_reason: modellen vill ha mer, men budgeten är inte slut.
    expect(reachedToolIterationCap('tool_use', MAX_TOOL_ROUNDS - 1)).toBe(false)
  })

  it('wantsAnotherToolRound är sant ENBART för tool_use', () => {
    expect(wantsAnotherToolRound('tool_use')).toBe(true)
    for (const r of ['end_turn', 'max_tokens', 'stop_sequence', null, undefined]) {
      expect(wantsAnotherToolRound(r)).toBe(false)
    }
  })

  it('markeringen är omöjlig att läsa som ett vanligt svar', () => {
    expect(TOOL_ITERATION_CAP_NOTICE).toContain('slutfördes inte')
    expect(TOOL_ITERATION_CAP_NOTICE).toContain('ofullständigt')
    expect(TOOL_ITERATION_CAP_NOTICE).toContain(String(MAX_TOOL_ROUNDS))
    // Ingen hedge: markeringen får inte mjukas upp till något som går att läsa förbi.
    expect(TOOL_ITERATION_CAP_NOTICE.toLowerCase()).not.toContain('kanske')
    expect(TOOL_ITERATION_CAP_NOTICE.toLowerCase()).not.toContain('möjligen')
  })
})

// ── SSE-vägen: markeringen ska synas HELA VÄGEN UT i strömmen ───────────────
//
// Grupperna 2 och 3 kör den RIKTIGA controllern och läser de RIKTIGA SSE-
// skrivningarna. Att bara pröva predikatet hade lämnat den viktigaste frågan
// obesvarad: når markeringen fram till klienten? Riggen är samma som
// sse-memory-extraction.spec.ts använder.

function makeController() {
  const aiService = {
    buildMessageHistoryForClaude: jest.fn().mockResolvedValue([]),
    extractMemoriesInBackground: jest.fn(),
    enrichDoubleConfirmContext: jest.fn().mockResolvedValue(undefined),
    buildConfirmation: jest.fn().mockReturnValue({ confirmationMessage: 'Bekräfta?', details: {} }),
    recordPendingAction: jest.fn().mockResolvedValue(undefined),
    resolveLegalGrounding: jest.fn().mockResolvedValue(null),
  }
  const usageService = { logUsage: jest.fn().mockResolvedValue(undefined) }
  const controller = new AiAssistantController(
    aiService as never,
    { getMemories: jest.fn().mockResolvedValue('') } as never,
    {} as never,
    {
      buildContext: jest.fn().mockResolvedValue(''),
      getCurrentDateContext: jest.fn().mockReturnValue('Datum: idag'),
    } as never,
    { executeTool: jest.fn().mockResolvedValue({ ok: true }) } as never,
    usageService as never,
    {
      checkQuota: jest.fn().mockResolvedValue(undefined),
      checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
    } as never,
    {
      aiConversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'c1', messages: [] }),
        update: jest.fn().mockResolvedValue({}),
      },
      aiMessage: { create: jest.fn().mockResolvedValue({}) },
    } as never,
    { get: jest.fn().mockReturnValue('') } as never,
    {
      buildContentBlocks: jest
        .fn()
        .mockResolvedValue({ contentBlocks: [], refBlocks: [], ids: [] }),
      markConsumed: jest.fn().mockResolvedValue(undefined),
      rehydrateHistoryBlocks: jest.fn(),
    } as never,
  )
  const reply = { raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() } }
  return { controller, reply, usageService }
}

const user = { sub: 'user-1', role: 'ADMIN', organizationId: 'org-1' } as never

/** Allt som skrevs till SSE-strömmen, som en sträng. */
const strömmen = (reply: { raw: { write: jest.Mock } }) =>
  reply.raw.write.mock.calls.map((c) => String(c[0])).join('')

describe('(2) NEGATIVKONTROLL — en körning som NÅR taket', () => {
  afterEach(() => mockFinalMessage.mockReset())

  it('markeringen syns i SSE-strömmen: både som delta OCH som iteration_cap', async () => {
    const { controller, reply, usageService } = makeController()
    // Modellen vill ha verktyg i VARJE tur → taket nås.
    mockFinalMessage.mockResolvedValue({
      content: [
        { type: 'text', text: 'Jag ska bara kolla en sak...' },
        { type: 'tool_use', id: 't1', name: 'get_properties', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    await controller.streamChat(
      'Sammanställ allt',
      undefined,
      undefined,
      'org-1',
      user,
      reply as never,
    )

    const ut = strömmen(reply)
    // 1. Den STRUKTURERADE signalen.
    expect(ut).toContain('event: iteration_cap')
    // 2. Den SYNLIGA texten — bärande kanalen. En klient som inte känner till
    //    den nya händelsen ignorerar den tyst; markeringen måste finnas ändå.
    expect(ut).toContain('slutfördes inte')
    expect(ut).toContain('ofullständigt')

    // 3. Och den blev MÄTBAR.
    expect(usageService.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ capReached: true, toolRounds: MAX_TOOL_ROUNDS }),
    )
  })

  it('modellen anropas N+1 gånger och verktyg körs N — ingen omgång kastas bort', async () => {
    // Innan fixen anropades modellen N gånger och den N:te omgångens
    // verktygsresultat skickades ALDRIG till modellen: arbete utfördes och
    // kastades. SSE-vägen gav då effektivt N−1 användbara omgångar, medan
    // tjänstevägen gav N — samma tal, olika betydelse.
    const { controller, reply } = makeController()
    mockFinalMessage.mockResolvedValue({
      content: [
        { type: 'text', text: 'kollar...' },
        { type: 'tool_use', id: 't1', name: 'get_properties', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    })

    await controller.streamChat(
      'Sammanställ allt',
      undefined,
      undefined,
      'org-1',
      user,
      reply as never,
    )

    // finalMessage = ett modellanrop per varv. N verktygsomgångar + det sista
    // anropet som får svara ⇒ N+1.
    expect(mockFinalMessage).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1)
  })
})

describe('(3) NEGATIVKONTROLL — en körning som INTE når taket', () => {
  afterEach(() => mockFinalMessage.mockReset())

  it('avslutat svar → INGEN markering, varken som delta eller händelse', async () => {
    // Ett larm som alltid larmar läses snart inte alls.
    const { controller, reply, usageService } = makeController()
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'Här är svaret.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    await controller.streamChat(
      'Hur många fastigheter?',
      undefined,
      undefined,
      'org-1',
      user,
      reply as never,
    )

    const ut = strömmen(reply)
    expect(ut).toContain('event: done')
    expect(ut).not.toContain('event: iteration_cap')
    expect(ut).not.toContain('slutfördes inte')
    expect(usageService.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ capReached: false }),
    )
  })

  it('en pending action markeras ALDRIG som avbruten', async () => {
    // Den turen är inte avbruten — den väntar på en bekräftelse. Att påstå att
    // den misslyckades vore ett falskt larm på systemets vanligaste bindande väg.
    const { controller, reply } = makeController()
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't1', name: 'create_invoice', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2 },
    })

    await controller.streamChat(
      'Skapa en faktura',
      undefined,
      undefined,
      'org-1',
      user,
      reply as never,
    )

    const ut = strömmen(reply)
    expect(ut).toContain('event: pending_action')
    expect(ut).not.toContain('event: iteration_cap')
    expect(ut).not.toContain('slutfördes inte')
  })
})

describe('(3b) predikatet larmar INTE på ett fullständigt svar', () => {
  // ── DE HÄR TRE FÖLL BORT EN GÅNG ──────────────────────────────────────────
  //
  // När SSE-grupperna lades till ersattes ett textblock som råkade omsluta de
  // här assertionerna, och de försvann tyst. Bortfallet upptäcktes bara av att
  // en negativkontroll (uppmjukat predikat) fällde ETT test där den borde ha
  // fällt tre — alltså av att jag frågade VARFÖR utfallet såg ut som det gjorde,
  // inte bara om det var rött. Ett test som inte finns är grönt för alltid.

  it('klar inom budgeten → aldrig markering, oavsett antal omgångar', () => {
    for (let rundor = 0; rundor <= MAX_TOOL_ROUNDS; rundor++) {
      expect(reachedToolIterationCap('end_turn', rundor)).toBe(false)
    }
  })

  it('klar på PRECIS sista varvet → ingen markering', () => {
    // Det farligaste falsklarmet: budgeten är förbrukad, men svaret är komplett.
    // Ett larm som larmar här hade larmat i det VANLIGASTE fallet av alla, och
    // ett larm som alltid larmar läses snart inte alls.
    expect(reachedToolIterationCap('end_turn', MAX_TOOL_ROUNDS)).toBe(false)
  })

  it('max_tokens är en ANNAN felmod och ska inte kallas turtak', () => {
    expect(reachedToolIterationCap('max_tokens', MAX_TOOL_ROUNDS)).toBe(false)
    expect(reachedToolIterationCap('stop_sequence', MAX_TOOL_ROUNDS)).toBe(false)
  })
})

// ── (4) ETT VÄRDE ────────────────────────────────────────────────────────────

describe('(4) taket är ETT värde, delat av alla tre looparna', () => {
  const filer = [
    'ai-assistant.service.ts',
    'ai-assistant.controller.ts',
    'tenant-ai.service.ts',
  ] as const

  it('alla tre looparna läser MAX_TOOL_ROUNDS ur modulen', () => {
    const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs')
    const { join } = jest.requireActual('node:path') as typeof import('node:path')
    for (const f of filer) {
      const text: string = readFileSync(join(__dirname, f), 'utf8')
      expect(text).toContain("from './tool-iteration-cap'")
      expect(text).toContain('MAX_TOOL_ROUNDS')
    }
  })

  it('KANARIEFÅGEL: ingen fil bär en egen turtakskonstant längre', () => {
    const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs')
    const { join } = jest.requireActual('node:path') as typeof import('node:path')
    for (const f of filer) {
      const text: string = readFileSync(join(__dirname, f), 'utf8')
      // De tre gamla namnen. Står något av dem kvar har taket delats igen.
      expect(text).not.toMatch(/const\s+\w*MAX_TOOL_ITERATIONS\s*=/)
    }
  })
})
