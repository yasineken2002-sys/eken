/**
 * "KONSUMERAT" ÄR INTE "UTFÖRT".
 *
 * MÄTT DEFEKT: `consumePendingAction` committar anspråket, `executeTool` körs
 * som ett SEPARAT steg efteråt. Dör processen emellan är anspråket förbrukat
 * utan att något utfördes — och svaret sa ändå "Åtgärden är redan utförd".
 * Uppmätt mot riktig PG 18.6:
 *
 *     anspråk committat → krasch → nytt försök
 *       → 'already-consumed', AiToolExecution 0 rader, JournalEntry 0 rader
 *
 * ARBETSFÖRDELNING: den här specen äger MEKANIKEN (vilket svar som ges i vilket
 * läge). Att grenen över huvud taget FRÅGAR efter en körning innan den påstår
 * något ägs av `check-ai-journal-source.mjs` (R3) — en spec kan inte se att
 * någon kopplar bort frågan och låter påståendet stå kvar.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ConflictException } from '@nestjs/common'
import { AiAssistantService } from './ai-assistant.service'

function makeService(opts: {
  körningFinns: boolean
  effekter?: Array<{ entityType: string; rowCount: number }>
  /** null = PÅBÖRJAD (raden skrevs före körningen och stängdes aldrig). */
  completedAt?: Date | null
}) {
  const executeTool = jest.fn().mockResolvedValue({ success: true, message: 'ok' })
  const körning = opts.körningFinns
    ? {
        id: 'ex1',
        createdAt: new Date('2026-08-28T10:00:00Z'),
        completedAt:
          opts.completedAt === undefined ? new Date('2026-08-28T10:00:01Z') : opts.completedAt,
        effects: opts.effekter ?? [],
      }
    : null
  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', organizationId: 'o1', userId: 'u1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
    aiPendingAction: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
      // REDAN KONSUMERAD — det läge både normalfallet och kraschfallet ger.
      findFirst: jest.fn().mockResolvedValue({
        id: 'pa1',
        consumedAt: new Date('2026-08-28T09:59:00Z'),
        expiresAt: new Date(Date.now() + 600_000),
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    aiToolExecution: { findFirst: jest.fn().mockResolvedValue(körning) },
  }
  const service = new AiAssistantService(
    prisma as never,
    { get: jest.fn().mockReturnValue('') } as never,
    {} as never,
    { executeTool } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      buildContentBlocks: jest
        .fn()
        .mockResolvedValue({ contentBlocks: [], refBlocks: [], ids: [] }),
      markConsumed: jest.fn().mockResolvedValue(undefined),
      rehydrateHistoryBlocks: jest.fn(),
    } as never,
  )
  return { service, executeTool, prisma }
}

const ARGS = ['update_tenant', { tenantId: 't-1' }, 'c1', true, 'o1', 'u1', 'ADMIN'] as const

describe('förbrukat anspråk UTAN körning — svaret får inte påstå utförande', () => {
  it('KÄRNAN: säger att utförandet inte kan bekräftas, inte att det skedde', async () => {
    const { service, executeTool } = makeService({ körningFinns: false })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(ConflictException)
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/går INTE att bekräfta/)
    // Och den får ALDRIG innehålla påståendet.
    await expect(service.confirmAction(...ARGS)).rejects.not.toThrow(/är redan utförd/)
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('säger inte heller att den INTE utfördes — auditraden skrivs fire-and-forget', async () => {
    // Frånvaron av en körning utesluter inte att arbetet gjordes: raden skrivs
    // EFTER verktygskroppen. Ett påstående åt andra hållet vore lika obelagt.
    const { service } = makeService({ körningFinns: false })
    await expect(service.confirmAction(...ARGS)).rejects.not.toThrow(
      /utfördes ALDRIG|utfördes inte/,
    )
  })

  it('pekar på vägen framåt utan att köra om något automatiskt', async () => {
    const { service, executeTool } = makeService({ körningFinns: false })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/föreslå åtgärden igen/)
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('återställer INTE anspråket — ett engångsanspråk som kan återuppstå är inget engångsanspråk', async () => {
    const { service, prisma } = makeService({ körningFinns: false })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow()
    // Ingen skrivning som nollar consumedAt.
    const skrivningar = prisma.aiPendingAction.updateMany.mock.calls
    for (const [arg] of skrivningar) {
      expect(JSON.stringify(arg?.data ?? {})).not.toContain('consumedAt":null')
    }
  })
})

describe('förbrukat anspråk MED körning — oförändrat beteende', () => {
  it('säger fortfarande "redan utförd" när det FAKTISKT är utfört', async () => {
    const { service, executeTool } = makeService({ körningFinns: true })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/är redan utförd/)
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('bär med sig VAD den orsakade, ur utfallskopplingen', async () => {
    const { service } = makeService({
      körningFinns: true,
      effekter: [{ entityType: 'JournalEntry', rowCount: 1 }],
    })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/1 JournalEntry/)
  })

  it('en körning UTAN effekter är fortfarande en körning', async () => {
    // Ett verktyg som lyckades utan att röra en rad har noll effekter men en
    // körning. Det är därför frågan ställs mot AiToolExecution och inte mot
    // AiToolEffect — annars hade varje effektlös körning sett ut som en krasch.
    const { service } = makeService({ körningFinns: true, effekter: [] })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/är redan utförd/)
  })

  it('PÅBÖRJAD läses som PÅBÖRJAD — aldrig som "inga dataändringar"', async () => {
    // KRASCHEN MELLAN FÖRRADEN OCH EFFEKTEN (steg 3b). Raden skrevs och
    // committades före körningen; processen dog innan den stängdes. Tillståndet
    // är läsbart och betyder EN sak: vi kom aldrig tillbaka.
    //
    // Före steg 3b fanns det här läget inte alls — en sådan körning hade
    // antingen saknat rad helt, eller (med rad och tom effektlista) sett ut som
    // "registrerade inga dataändringar". Det är #586:s form, och den utgången är
    // den enda som inte accepteras här.
    const { service } = makeService({ körningFinns: true, effekter: [], completedAt: null })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/PÅBÖRJADES/)
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/ODEFINIERAT/)
    await expect(service.confirmAction(...ARGS)).rejects.not.toThrow(/inga dataändringar/)
  })

  it('en tom effektlista är en UTSAGA när spåret inte kan tappas tyst', async () => {
    // `update_tenant` står `traceIntegrity: 'FÖRE_EFFEKTEN'` sedan steg 3b:
    // raden committas före effekten och stängs efteråt, så en stängd rad med
    // noll effekter betyder verkligen att inget skrevs.
    //
    // Raden bar tidigare motsatsen — den krävde ODEFINIERAT, eftersom ALLA 30
    // då var BÄST_MÖJLIGA. Att den ändras här är själva vinsten: 23 verktyg gick
    // från "kan inte påstås" till "kan påstås", utan att någon rörde
    // describeEffects.
    const { service } = makeService({ körningFinns: true, effekter: [] })
    await expect(service.confirmAction(...ARGS)).rejects.toThrow(/inga dataändringar/)
  })

  it('… men förblir ODEFINIERAD för ett verktyg vars spår ÄR best-effort', async () => {
    // `compose_and_send_email` är klass B och står kvar på BÄST_MÖJLIGA — den
    // får #607-mönstret i en egen PR. Tills dess betyder en tom lista fortfarande
    // två saker, och svaret säger det.
    const { service } = makeService({ körningFinns: true, effekter: [] })
    const bästMöjliga = [
      'compose_and_send_email',
      { tenantIds: ['t-1'] },
      'c1',
      true,
      'o1',
      'u1',
      'ADMIN',
    ] as const
    await expect(service.confirmAction(...bästMöjliga)).rejects.toThrow(/ODEFINIERAT/)
    await expect(service.confirmAction(...bästMöjliga)).rejects.not.toThrow(/inga dataändringar/)
  })
})
