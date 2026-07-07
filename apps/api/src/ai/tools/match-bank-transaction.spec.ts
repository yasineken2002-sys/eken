/**
 * AI-hål #1 — match_bank_transaction kan nu matcha hyresavier (RentNotice), inte
 * bara fakturor. Verifierar att verktyget:
 *   • DEKLARERAR rentNoticeId i schemat (Claude kan fylla det) + invoiceId/rentNoticeId
 *     är ALTERNATIVA (required = transactionId, anyOf på de två).
 *   • ligger kvar i ACTION_TOOLS → confirm-grinden gäller (AI föreslår, människan bekräftar).
 *   • dirigerar rentNoticeId till EXAKT samma manuella matchningsväg (manualMatch) som
 *     operatörens manuella matchning — ingen genväg förbi bankhärdnings-invarianterna.
 *   • skickar org-id (tenant-isolation grindas i manualMatch som övriga verktyg).
 *   • invoiceId-vägen är oförändrad.
 *   • delbetalning beskrivs korrekt (allokering, inte falsk full PAID).
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { TOOLS, ACTION_TOOLS } from './ai-tools.definition'

function makeExecutor() {
  const manualMatch = jest.fn().mockResolvedValue(undefined)
  const reconciliationService = { manualMatch }
  const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) }
  const noop = {} as never
  const executor = new ToolExecutorService(
    noop, // 1 prisma
    noop, // 2 invoicesService
    noop, // 3 pdfService
    noop, // 4 tenantsService
    noop, // 5 leasesService
    noop, // 6 rentIncreasesService
    noop, // 7 propertiesService
    noop, // 8 unitsService
    noop, // 9 accountingService
    noop, // 10 verifikationsnummer
    noop, // 11 mailService
    noop, // 12 maintenanceService
    noop, // 13 aviseringService
    noop, // 14 inspectionsService
    noop, // 15 maintenancePlanService
    reconciliationService as never, // 16 reconciliationService
    noop, // 17 collectionExport
    noop, // 18 paymentReminders
    noop, // 19 storage
    noop, // 20 redis
    audit as never, // 21 audit
    noop, // 22 documentDelivery
    noop, // 23 signingService
  )
  return { executor, manualMatch }
}

describe('match_bank_transaction — schema + confirm-grind', () => {
  const tool = TOOLS.find((t) => t.name === 'match_bank_transaction')!

  it('verktyget existerar och deklarerar rentNoticeId + invoiceId som egenskaper', () => {
    expect(tool).toBeDefined()
    const props = tool.input_schema.properties as Record<string, unknown>
    expect(props.transactionId).toBeDefined()
    expect(props.invoiceId).toBeDefined()
    expect(props.rentNoticeId).toBeDefined()
  })

  it('invoiceId/rentNoticeId är ALTERNATIVA: required = bara transactionId, INGEN toppnivå-anyOf', () => {
    expect(tool.input_schema.required).toEqual(['transactionId'])
    // DRIFTSTÖRNINGSFIX 2026-06-11: toppnivå-anyOf får Anthropics API att
    // avvisa HELA chat-requesten (400) — "exakt en av"-villkoret bärs i
    // description och grindas auktoritativt server-side (testerna nedan).
    // Svepande regressionsspärr för alla verktyg: ai-tools-schema.spec.ts.
    expect('anyOf' in tool.input_schema).toBe(false)
    const props = tool.input_schema.properties as Record<string, { description?: string }>
    expect(props.invoiceId!.description).toMatch(/EXAKT ETT/i)
    expect(props.rentNoticeId!.description).toMatch(/EXAKT ETT/i)
  })

  it('ligger kvar i ACTION_TOOLS → kräver mänsklig bekräftelse (rör pengar)', () => {
    expect(ACTION_TOOLS.has('match_bank_transaction')).toBe(true)
  })
})

describe('match_bank_transaction — RentNotice-matchning går genom manualMatch', () => {
  it('rentNoticeId dirigeras till manualMatch med { rentNoticeId } + org (samma väg som manuell matchning)', async () => {
    const { executor, manualMatch } = makeExecutor()
    const result = await executor.executeTool(
      'match_bank_transaction',
      { transactionId: 'tx-1', rentNoticeId: 'rn-1' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
    )
    expect(manualMatch).toHaveBeenCalledTimes(1)
    const [txId, target, orgId, userId] = manualMatch.mock.calls[0]
    expect(txId).toBe('tx-1')
    expect(target).toEqual({ rentNoticeId: 'rn-1' }) // INTE invoiceId
    expect(orgId).toBe('org-1') // tenant-isolation: org grindas i manualMatch
    expect(userId).toBe('user-1')
    expect(result.success).toBe(true)
    // Delbetalning beskrivs korrekt — ingen falsk "full PAID" för hyresavi.
    expect(result.message).toContain('hyresavin')
    expect(result.message).toContain('delbetalning')
  })

  it('invoiceId-vägen är OFÖRÄNDRAD: dirigeras till manualMatch med { invoiceId }', async () => {
    const { executor, manualMatch } = makeExecutor()
    const result = await executor.executeTool(
      'match_bank_transaction',
      { transactionId: 'tx-2', invoiceId: 'inv-9' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
    )
    expect(manualMatch.mock.calls[0][1]).toEqual({ invoiceId: 'inv-9' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('fakturan')
  })

  it('AI:n går ALDRIG förbi allokeringsvägen — manualMatch är den enda muteraren (inget direkt prisma-skriv)', async () => {
    // ToolExecutor är konstruerad med prisma=noop; skulle handlern försöka boka
    // direkt (förbi manualMatch) kraschade testet. Att det INTE gör det bevisar att
    // hela bokföringen/allokeringen sker i reconciliation-vägen.
    const { executor, manualMatch } = makeExecutor()
    await executor.executeTool(
      'match_bank_transaction',
      { transactionId: 'tx-3', rentNoticeId: 'rn-3' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
    )
    expect(manualMatch).toHaveBeenCalledTimes(1)
  })
})

describe('match_bank_transaction — validering', () => {
  it('avvisar när varken invoiceId eller rentNoticeId anges (manualMatch ej anropad)', async () => {
    const { executor, manualMatch } = makeExecutor()
    const result = await executor.executeTool(
      'match_bank_transaction',
      { transactionId: 'tx-1' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
    )
    expect(result.success).toBe(false)
    expect(manualMatch).not.toHaveBeenCalled()
  })

  it('avvisar när BÅDE invoiceId och rentNoticeId anges (exakt ett krävs)', async () => {
    const { executor, manualMatch } = makeExecutor()
    const result = await executor.executeTool(
      'match_bank_transaction',
      { transactionId: 'tx-1', invoiceId: 'inv-1', rentNoticeId: 'rn-1' },
      'org-1',
      'user-1',
      'ACCOUNTANT',
    )
    expect(result.success).toBe(false)
    expect(manualMatch).not.toHaveBeenCalled()
  })
})
