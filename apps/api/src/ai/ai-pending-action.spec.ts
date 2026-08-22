/**
 * SECURITY (RISK 1) — confirm binds till en server-lagrad pending action.
 *
 * Verifierar att confirmAction():
 *   • avvisar (400) en bekräftelse som inte matchar en lagrad pending action
 *     → ingen verktygsexekvering (human-in-the-loop kan inte kringgås)
 *   • exekverar när en matchande, icke-konsumerad action finns
 *   • avvisar dubbel-confirm (race): updateMany count=0 → 400, ingen exekvering
 *   • hashen är fältordnings-oberoende (kanonisk JSON)
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { BadRequestException, ConflictException } from '@nestjs/common'
import { AiAssistantService, hashPendingAction } from './ai-assistant.service'

function makeService(opts: { pendingFound?: boolean; consumeCount?: number } = {}) {
  const executeTool = jest.fn().mockResolvedValue({ success: true, message: 'ok' })
  const prisma = {
    aiConversation: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', organizationId: 'o1', userId: 'u1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiMessage: { create: jest.fn().mockResolvedValue({}) },
    aiPendingAction: {
      create: jest.fn().mockResolvedValue({}),
      // `expiresAt` i framtiden och `consumedAt: null` — annars klassar
      // consumePendingAction raden som utgången respektive redan konsumerad
      // innan anspråket ens görs, och `consumeCount` blir verkningslöst.
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.pendingFound === false
            ? null
            : { id: 'pa1', consumedAt: null, expiresAt: new Date(Date.now() + 600_000) },
        ),
      updateMany: jest.fn().mockResolvedValue({ count: opts.consumeCount ?? 1 }),
    },
    // Uppspelningssvaret läser utfallskopplingen (#562) för att kunna säga VAD
    // som hände i stället för att bara säga "ogiltig".
    aiToolExecution: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  const configService = { get: jest.fn().mockReturnValue('') }
  const service = new AiAssistantService(
    prisma as never,
    configService as never,
    {} as never,
    { executeTool } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // legalRetrieval — nås aldrig (inga juridiska frågor i denna spec)
    {
      buildContentBlocks: jest
        .fn()
        .mockResolvedValue({ contentBlocks: [], refBlocks: [], ids: [] }),
      markConsumed: jest.fn().mockResolvedValue(undefined),
      rehydrateHistoryBlocks: jest.fn(),
    } as never, // attachments (B2) — text-only i denna spec
  )
  return { service, executeTool, prisma }
}

// update_tenant: en enkel ACTION_TOOL utan dubbelbekräftelse — testet gäller
// pending-action-BINDNINGEN, inte en specifik tools confirm-nivå. (mark_invoice_paid
// kräver numera dubbelbekräftelse och skulle re-prompta i stället för att exekvera.)
const ARGS = (toolInput: Record<string, unknown> = { tenantId: 't-1', tenantName: 'A' }) =>
  ['update_tenant', toolInput, 'c1', true, 'o1', 'u1', 'ADMIN'] as const

describe('hashPendingAction', () => {
  it('är oberoende av fältordning i toolInput', () => {
    expect(hashPendingAction('t', { a: 1, b: 2 })).toBe(hashPendingAction('t', { b: 2, a: 1 }))
  })
  it('skiljer på olika toolName/toolInput', () => {
    expect(hashPendingAction('t', { a: 1 })).not.toBe(hashPendingAction('t', { a: 2 }))
    expect(hashPendingAction('t', { a: 1 })).not.toBe(hashPendingAction('u', { a: 1 }))
  })
})

describe('AiAssistantService.confirmAction — pending action-bindning (RISK 1)', () => {
  it('avvisar confirm utan matchande pending action (400) och exekverar inte', async () => {
    const { service, executeTool } = makeService({ pendingFound: false })
    await expect(service.confirmAction(...ARGS())).rejects.toBeInstanceOf(BadRequestException)
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('exekverar när en matchande pending action konsumeras', async () => {
    const { service, executeTool } = makeService({ pendingFound: true, consumeCount: 1 })
    const res = await service.confirmAction(...ARGS())
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(res.reply).toBe('ok')
  })

  it('avvisar dubbel-confirm (race: updateMany count=0) utan exekvering', async () => {
    // BETEENDEÄNDRING: en dubbel-confirm är inte "ogiltig" — åtgärden ÄR utförd.
    // Svaret säger numera det, och skiljer sig därmed från en UTGÅNGEN eller
    // OKÄND bekräftelse, där ingenting hände. Att kalla alla tre "ogiltig" var
    // vilseledande i precis det fall där någon behöver veta mest.
    const { service, executeTool } = makeService({ pendingFound: true, consumeCount: 0 })
    const fel = await service.confirmAction(...ARGS()).catch((e: unknown) => e)
    expect(fel).toBeInstanceOf(ConflictException)
    expect((fel as Error).message).toContain('redan utförd')
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('en UTGÅNGEN bekräftelse säger att åtgärden ALDRIG utfördes', async () => {
    // Den skarpa skillnaden mot fallet ovan: här hände ingenting, och den som
    // läser ska inte behöva gissa vilket av fallen det var.
    const { service, executeTool } = makeService({ pendingFound: true })
    ;(
      service as unknown as { prisma: { aiPendingAction: { findFirst: jest.Mock } } }
    ).prisma.aiPendingAction.findFirst.mockResolvedValue({
      id: 'pa1',
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    const fel = await service.confirmAction(...ARGS()).catch((e: unknown) => e)
    expect(fel).toBeInstanceOf(BadRequestException)
    expect((fel as Error).message).toContain('ALDRIG')
    expect(executeTool).not.toHaveBeenCalled()
  })
})
