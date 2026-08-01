/**
 * R1 — AI-VÄGENS ANDRA LAGER.
 *
 * `export_for_collection` anropar `CollectionExportService.exportForInvoice()`
 * SYNKRONT, förbi kön och därmed förbi enqueue-grinden som skyddar HTTP-vägen.
 * Både FAR och säkerhetsgranskningen fångade att R1:s docblock påstod att alla
 * anropare passerar tjänstegrinden — vilket inte stämde för just den vägen.
 *
 * MANAGER stoppas där ändå idag, men av `MANAGER_ALLOWED_ACTIONS` /
 * `ACCOUNTING_ONLY_ACTIONS` — två fristående listor i AI-lagret. Att förlita sig
 * på en enda lista är precis vad R1 finns till för att sluta göra, så vägen fick
 * samma delade grind vid sitt anropsställe.
 *
 * DET HÄR TESTET BEVISAR ATT GRINDEN FAKTISKT SITTER DÄR — oberoende av
 * AI-listorna. Utan det vilade påståendet bara på kommentartext, vilket
 * säkerhetsgranskningen uttryckligen påpekade ("inte bara kommentartext").
 *
 * Grinden mockas för att kunna observeras: körs den, med rätt argument, och
 * stoppar den anropet när den nekar? Om någon i framtiden tar bort raden faller
 * testet — även om AI-listorna fortfarande råkar blockera MANAGER.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

// Grinden mockas så anropet går att observera. `requireActual` behålls så
// COLLECTION_ACTION_ROLES och övriga exporter är de riktiga.
jest.mock('../../common/authz/collections-authz', () => ({
  ...jest.requireActual('../../common/authz/collections-authz'),
  assertMayActOnCollections: jest.fn(),
}))

import { ForbiddenException } from '@nestjs/common'
import { ToolExecutorService } from './tool-executor.service'
import { assertMayActOnCollections } from '../../common/authz/collections-authz'

const gate = assertMayActOnCollections as jest.MockedFunction<typeof assertMayActOnCollections>

function makeExecutor(collectionExport: Record<string, unknown>) {
  const noop = {} as never
  const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) }
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
    collectionExport as never, // 17 collectionExport
    noop,
    noop,
    noop,
    audit as never, // 21 audit
    noop,
    noop,
    noop,
  )
}

async function run(collectionExport: Record<string, unknown>, role: string) {
  const executor = makeExecutor(collectionExport)
  return (
    executor as unknown as {
      executeToolUnsafe: (
        name: string,
        input: Record<string, unknown>,
        orgId: string,
        userId: string,
        userRole: string,
      ) => Promise<{ success: boolean; message: string }>
    }
  ).executeToolUnsafe('export_for_collection', { invoiceId: 'inv-1' }, 'org-1', 'user-1', role)
}

describe('R1 · AI-vägens inkassogrind', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // clearAllMocks nollställer ANROP men inte implementationer — utan den här
    // raden läcker föregående tests "kasta"-implementation in i nästa.
    gate.mockImplementation(() => undefined)
  })

  it('grinden ANROPAS på den synkrona export-vägen, med rätt aktör och handling', async () => {
    const exportForInvoice = jest
      .fn()
      .mockResolvedValue({ invoiceId: 'inv-1', invoiceNumber: 'F-1', pdfUrl: 'u' })
    await run({ exportForInvoice }, 'ACCOUNTANT')

    expect(gate).toHaveBeenCalledWith('ACCOUNTANT', 'exportera underlag till inkasso')
  })

  it('grinden körs FÖRE exporten — nekar den, sker ingen export', async () => {
    // Simulerar framtiden säkerhetsgranskningen varnade för: någon lägger till
    // export_for_collection i MANAGER_ALLOWED_ACTIONS och städar bort den ur
    // ACCOUNTING_ONLY_ACTIONS. Då är den här grinden det enda som står kvar —
    // och den ska hålla.
    gate.mockImplementation(() => {
      throw new ForbiddenException('nekad')
    })
    const exportForInvoice = jest.fn()

    await expect(run({ exportForInvoice }, 'MANAGER')).rejects.toBeInstanceOf(ForbiddenException)
    expect(exportForInvoice).not.toHaveBeenCalled()
  })

  it('behörig roll släpps igenom och exporten körs som förut', async () => {
    const exportForInvoice = jest
      .fn()
      .mockResolvedValue({ invoiceId: 'inv-1', invoiceNumber: 'F-1', pdfUrl: 'u' })
    const res = await run({ exportForInvoice }, 'OWNER')

    expect(res.success).toBe(true)
    expect(exportForInvoice).toHaveBeenCalledWith('inv-1', 'org-1')
  })
})
