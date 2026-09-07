/**
 * ETT VÄRDE MODELLEN VALT ÄR EN GISSNING — INTE ETT LÖFTE.
 *
 * Sex `as never` i `tool-executor.service.ts` påstod att ett fält från en
 * språkmodell var ett giltigt Prisma-enumvärde. Castet gör ingen kontroll; det
 * tystar typcheckaren. Ett påhittat värde föll därför först i POSTGRES, som ett
 * 500-fel med ett meddelande varken operatören eller modellen kan använda.
 *
 * Det här provet mäter BETEENDET vid ett värde utanför enumen: ett svar
 * modellen kan rätta, inte ett databasfel. Ett per verktyg och fält.
 *
 * ── VARFÖR TOMMA BEROENDEN RÄCKER ───────────────────────────────────────────
 *
 * Valideringen ligger FÖRE all exekvering. Ett avslag syns därför som ett
 * `{ success: false }` med grindens egen text, medan ett INSLÄPP faller på något
 * helt annat — en TypeError från en attrapp som inte har metoden. Skillnaden
 * mellan de två utfallen är exakt den gräns provet mäter, och det är också
 * kanariefågeln: hade valideringen tagits bort skulle fallen nedan kasta i
 * stället för att svara.
 *
 * `update_maintenance_status` är undantaget som behöver en riktig träff i
 * databasen före valideringen (ärendet slås upp först), och prövas därför mot en
 * attrapp som svarar på just det uppslaget.
 */

jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  RENT_NOTICE_STATUSES,
  AI_SETTABLE_MAINTENANCE_STATUSES,
} from '@eken/shared'

import { ToolExecutorService } from './tool-executor.service'

type Utfall = { success: boolean; message?: string }
type Unsafe = (
  toolName: string,
  toolInput: Record<string, unknown>,
  organizationId: string,
  userId: string,
  userRole: string,
) => Promise<Utfall>

/**
 * Beroendena fylls positionsvis. `beroenden` skriver över de positioner ett
 * enskilt prov behöver — resten är tomma objekt, som ovan.
 */
function makeExecutor(beroenden: Record<number, unknown> = {}): Unsafe {
  const Ctor = ToolExecutorService as unknown as new (...args: never[]) => ToolExecutorService
  const args = Array.from({ length: 40 }, (_, i) => beroenden[i] ?? {})
  const instans = new Ctor(...(args as never[]))
  return (instans as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(instans)
}

/** Positionen för `prisma` i konstruktorn — härledd, inte gissad. */
const PRISMA_POSITION = (() => {
  const kalla = ToolExecutorService.toString()
  // Konstruktorns parameterlista, i deklarationsordning.
  const params = /constructor\s*\(([^)]*)\)/.exec(kalla)?.[1] ?? ''
  const namn = params
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const i = namn.findIndex((p) => /(?<![\p{L}\p{N}_$])prisma(?![\p{L}\p{N}_$])/iu.test(p))
  return i
})()

async function kor(run: Unsafe, verktyg: string, input: Record<string, unknown>): Promise<Utfall> {
  return run(verktyg, input, 'org-1', 'user-1', 'OWNER')
}

describe('enum-validering i ägarens verktygsexekverare', () => {
  const run = makeExecutor()

  describe('get_maintenance_tickets', () => {
    it('okänd status avvisas med de giltiga värdena i texten', async () => {
      const r = await kor(run, 'get_maintenance_tickets', { status: 'PAGAENDE' })
      expect(r.success).toBe(false)
      expect(r.message).toContain('PAGAENDE')
      for (const v of MAINTENANCE_STATUSES) expect(r.message).toContain(v)
    })

    it('okänd prioritet avvisas', async () => {
      const r = await kor(run, 'get_maintenance_tickets', { priority: 'AKUT' })
      expect(r.success).toBe(false)
      expect(r.message).toContain('AKUT')
      for (const v of MAINTENANCE_PRIORITIES) expect(r.message).toContain(v)
    })
  })

  describe('create_maintenance_ticket', () => {
    it('okänd kategori avvisas — den skrivs INTE tyst om till OTHER', async () => {
      // Ägarvägen kräver bekräftelse. En tyst omskrivning hade gjort att det
      // godkända och det skrivna skiljer sig åt; hyresgästvägen faller med rätt
      // tillbaka på OTHER, och skillnaden är avsiktlig.
      const r = await kor(run, 'create_maintenance_ticket', {
        title: 'Trasigt tak',
        description: 'Det läcker in vatten genom taket i trapphuset.',
        propertyId: 'p-1',
        propertyName: 'Ekhagen 1',
        category: 'SKADEDJUR',
      })
      expect(r.success).toBe(false)
      expect(r.message).toContain('SKADEDJUR')
      expect(r.message).not.toContain('OTHER skapad')
      for (const v of MAINTENANCE_CATEGORIES) expect(r.message).toContain(v)
    })

    it('okänd prioritet avvisas', async () => {
      const r = await kor(run, 'create_maintenance_ticket', {
        title: 'Trasigt tak',
        description: 'Det läcker in vatten genom taket i trapphuset.',
        propertyId: 'p-1',
        propertyName: 'Ekhagen 1',
        priority: 'MYCKET_HOG',
      })
      expect(r.success).toBe(false)
      expect(r.message).toContain('MYCKET_HOG')
    })
  })

  describe('update_maintenance_status', () => {
    const medArende = () =>
      makeExecutor({
        [PRISMA_POSITION]: {
          maintenanceTicket: {
            findFirst: async () => ({ id: 't-1', status: 'NEW', ticketNumber: 'AR-1' }),
          },
        },
      })

    it('okänd status avvisas', async () => {
      const r = await kor(medArende(), 'update_maintenance_status', {
        ticketId: 't-1',
        ticketNumber: 'AR-1',
        newStatus: 'KLAR',
      })
      expect(r.success).toBe(false)
      expect(r.message).toContain('KLAR')
    })

    /**
     * DEN AVGÖRANDE. `NEW` ÄR ett giltigt Prisma-värde, alltså hade en
     * validering mot hela enumen släppt igenom det — och därmed VIDGAT vad AI:n
     * får göra under sken av att bara ta bort ett cast. De två mängderna svarar
     * på olika frågor; provet är skillnaden mellan dem.
     */
    it('NEW avvisas trots att det är ett giltigt Prisma-värde', async () => {
      expect(MAINTENANCE_STATUSES).toContain('NEW')
      expect(AI_SETTABLE_MAINTENANCE_STATUSES).not.toContain('NEW')

      const r = await kor(medArende(), 'update_maintenance_status', {
        ticketId: 't-1',
        ticketNumber: 'AR-1',
        newStatus: 'NEW',
      })
      expect(r.success).toBe(false)
      expect(r.message).toContain('NEW')
    })
  })

  describe('get_rent_notices', () => {
    it('okänd avistatus avvisas', async () => {
      const r = await kor(run, 'get_rent_notices', { status: 'FORFALLEN' })
      expect(r.success).toBe(false)
      expect(r.message).toContain('FORFALLEN')
      for (const v of RENT_NOTICE_STATUSES) expect(r.message).toContain(v)
    })
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET, inte mot regeln.
   *
   * Proven ovan är gröna om exekveraren svarar `{ success: false }`. Det gör den
   * också om den föll på något helt annat, till exempel för att riggen aldrig
   * nådde valideringen. Det här kräver att ett GILTIGT värde tar en ANNAN väg —
   * alltså att sonden kan ge något annat än avslag. Kan den inte det mäter
   * proven ovan ingenting.
   */
  it('KANARIEFÅGEL: ett giltigt värde avvisas INTE av enum-grinden', async () => {
    let utfall: unknown
    try {
      utfall = await kor(run, 'get_maintenance_tickets', { status: 'NEW' })
    } catch (e) {
      utfall = e
    }
    // Med tomma beroenden faller ett giltigt värde på attrappen (TypeError) i
    // stället för att avvisas. Det som INTE får hända är enum-grindens text.
    const text = utfall instanceof Error ? utfall.message : JSON.stringify(utfall)
    expect(text).not.toContain('Okänd ärendestatus')
  })

  it('KANARIEFÅGEL: prisma-positionen hittades i konstruktorn', () => {
    // Hittas den inte blir `beroenden[-1]` aldrig satt, attrappen försvinner,
    // och update-proven faller på fel sak medan de fortfarande är gröna.
    expect(PRISMA_POSITION).toBeGreaterThanOrEqual(0)
  })
})
