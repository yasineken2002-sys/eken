/**
 * SECURITY (AI-IDOR) — en användare får inte bekräfta (exekvera) en annan
 * användares pending AI-action inom samma org.
 *
 * confirmAction() slår upp konversationen via
 * `findFirst({ where: { id, organizationId, userId } })`. Tidigare saknades
 * `userId`, så User A kunde bekräfta User B:s åtgärd genom att skicka B:s
 * conversationId. Testet låser fast att:
 *   • where-klausulen är scopad på userId
 *   • en konversation som ägs av någon annan ger NotFoundException och INGEN
 *     verktygsexekvering sker
 */

// AiAssistantService → ToolExecutorService → InvoicesService → PdfService →
// StorageService drar in @aws-sdk/client-s3 (ESM som jest inte transformerar).
// Mocka modulerna så importkedjan blir lätt.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { AiAssistantService } from './ai-assistant.service'

function makeService(conversationLookupResult: unknown) {
  const findFirst = jest.fn().mockResolvedValue(conversationLookupResult)
  const prisma = {
    aiConversation: {
      findFirst,
      update: jest.fn(),
    },
    aiMessage: { create: jest.fn() },
  }
  const executeTool = jest.fn().mockResolvedValue({ success: true, message: 'ok' })
  const toolExecutor = { executeTool }
  const configService = { get: jest.fn().mockReturnValue('') }

  const service = new AiAssistantService(
    prisma as never,
    configService as never,
    {} as never,
    toolExecutor as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { service, findFirst, executeTool }
}

describe('AiAssistantService.confirmAction — IDOR-skydd', () => {
  it('scopar uppslaget på userId', async () => {
    const { service, findFirst } = makeService({ id: 'c1', organizationId: 'o1' })

    await service.confirmAction(
      'create_invoice',
      { foo: 'bar' },
      'c1',
      true,
      'o1',
      'user-A',
      'ADMIN',
    )

    const where = findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ id: 'c1', organizationId: 'o1', userId: 'user-A' })
  })

  it('User A kan inte bekräfta User B:s action (annans konversation → 404, ingen exekvering)', async () => {
    // findFirst returnerar null eftersom userId i where inte matchar ägaren.
    const { service, executeTool } = makeService(null)

    await expect(
      service.confirmAction('create_invoice', {}, 'c-owned-by-B', true, 'o1', 'user-A', 'ADMIN'),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(executeTool).not.toHaveBeenCalled()
  })
})
