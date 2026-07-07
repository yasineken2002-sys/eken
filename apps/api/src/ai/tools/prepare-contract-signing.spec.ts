/**
 * S2 AI-seam: AI får FÖRBEREDA en signering men ALDRIG fullborda den.
 *   • prepare_contract_signing är en ACTION_TOOL som kräver dubbelbekräftelse,
 *   • det finns INGET verktyg som signerar/förseglar (bara prepare exponeras),
 *   • handlern anropar SigningService.createSigningRequest (prepare-only),
 *   • endast OWNER/ADMIN får förbereda (bindande handling).
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ForbiddenException } from '@nestjs/common'
import { ToolExecutorService } from './tool-executor.service'
import { TOOLS, ACTION_TOOLS } from './ai-tools.definition'
import { requiresDoubleConfirmation } from '../ai-assistant.service'

describe('AI-seam: prepare_contract_signing (prepare-only)', () => {
  it('är en ACTION_TOOL', () => {
    expect(ACTION_TOOLS.has('prepare_contract_signing')).toBe(true)
  })

  it('kräver alltid dubbelbekräftelse', () => {
    expect(requiresDoubleConfirmation('prepare_contract_signing', {})).toBe(true)
  })

  it('INGET verktyg låter AI:n fullborda/signera/försegla — bara prepare finns', () => {
    const signingTools = TOOLS.filter((t) => /sign|seal/i.test(t.name)).map((t) => t.name)
    expect(signingTools).toEqual(['prepare_contract_signing'])
    // Ingen completion-/seal-verktygsnamn får finnas.
    for (const forbidden of [
      'complete_signing',
      'sign_contract',
      'seal_contract',
      'finalize_signing',
      'complete_contract_signing',
    ]) {
      expect(TOOLS.find((t) => t.name === forbidden)).toBeUndefined()
    }
  })

  function makeExecutor(createSigningRequest: jest.Mock) {
    const noop = {} as never
    const signing = { createSigningRequest } as never
    const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) } as never
    // 23 positionsargument — signingService är den 23:e (sist).
    return new ToolExecutorService(
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      audit, // 21 audit
      noop, // 22 documentDelivery
      signing, // 23 signingService
    )
  }

  it('OWNER: förbereder via createSigningRequest (prepare-only), returnerar begäran-id', async () => {
    const createSigningRequest = jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'SIGNING_IN_PROGRESS' })
    const executor = makeExecutor(createSigningRequest)

    const result = await executor.executeTool(
      'prepare_contract_signing',
      { documentId: 'doc-1' },
      'org-1',
      'user-1',
      'OWNER',
    )

    expect(createSigningRequest).toHaveBeenCalledWith('org-1', 'user-1', 'doc-1')
    expect(result.success).toBe(true)
    expect((result.data as { signingRequestId: string }).signingRequestId).toBe('req-1')
  })

  it('ACCOUNTANT (ej OWNER/ADMIN): nekas — bindande handling', async () => {
    const createSigningRequest = jest.fn()
    const executor = makeExecutor(createSigningRequest)

    await expect(
      executor.executeTool(
        'prepare_contract_signing',
        { documentId: 'doc-1' },
        'org-1',
        'user-1',
        'ACCOUNTANT',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(createSigningRequest).not.toHaveBeenCalled() // ingen förberedelse
  })
})
