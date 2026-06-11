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

import { BadRequestException } from '@nestjs/common'
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
      findFirst: jest.fn().mockResolvedValue(opts.pendingFound === false ? null : { id: 'pa1' }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.consumeCount ?? 1 }),
    },
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
  )
  return { service, executeTool, prisma }
}

const ARGS = (toolInput: Record<string, unknown> = { invoiceId: 'inv-1' }) =>
  ['mark_invoice_paid', toolInput, 'c1', true, 'o1', 'u1', 'ADMIN'] as const

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
    const { service, executeTool } = makeService({ pendingFound: true, consumeCount: 0 })
    await expect(service.confirmAction(...ARGS())).rejects.toBeInstanceOf(BadRequestException)
    expect(executeTool).not.toHaveBeenCalled()
  })
})
