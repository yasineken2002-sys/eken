/**
 * VAKT: AI-gränsen sätter faktiskt kontexten.
 *
 * Utan det här testet kan någon ta bort `runAsAi` ur `executeTool` och allt
 * annat förblir grönt: chokepointerna fungerar, kontexten fungerar — men ingen
 * sätter den, och varje AI-utförd handling skrivs som USER igen.
 *
 * Det är samma felklass som #504 självt: mekanismen finns, men ingen kopplar in
 * den, och ingenting säger till.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { currentAiOrigin } from '../../common/ai-origin/ai-origin.context'

describe('AI-gränsen kopplar in ursprungskontexten', () => {
  it('executeTool kör verktyget i kontext, med samma id som loggraden får', async () => {
    const noop = {} as never
    const audit = {
      logToolExecution: jest.fn().mockResolvedValue(undefined),
      // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
      beginToolExecution: jest.fn().mockResolvedValue(undefined),
      completeToolExecution: jest.fn().mockResolvedValue(undefined),
    }
    const svc = new ToolExecutorService(
      {} as never,
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
      audit as never,
      noop,
      noop,
      noop,
    )

    let seen: ReturnType<typeof currentAiOrigin>
    ;(svc as unknown as { executeToolUnsafe: unknown }).executeToolUnsafe = () => {
      seen = currentAiOrigin()
      return Promise.resolve({ success: true, message: 'ok' })
    }

    await svc.executeTool('get_invoices', {}, 'org-1', 'user-1', 'OWNER')

    expect(seen).toBeDefined()
    // Samma id som verktygsloggen får — annars pekar verifikatets referens fel.
    const loggedId = (audit.logToolExecution.mock.calls[0]?.[0] as { id?: string } | undefined)?.id
    expect(loggedId).toBeDefined()
    expect(seen?.aiToolExecutionId).toBe(loggedId)
  })

  it('kontexten är borta när executeTool returnerat', async () => {
    expect(currentAiOrigin()).toBeUndefined()
  })
})
