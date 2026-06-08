/**
 * AI-verktyget send_document_to_tenant (Steg 2): skapar ett dokument och
 * levererar det till en hyresgästs portal. Säkerhetskritiskt — skickar något
 * till en riktig person. Verifierar:
 *   • verktyget ligger i ACTION_TOOLS → confirm-grinden gäller (AI föreslår,
 *     människan bekräftar; exekvering sker först i confirmAction).
 *   • EXAKT 1 träff → levererar via DocumentDeliveryService med tenantId från
 *     den upplösta tenanten (server-side), org från anroparen.
 *   • >1 träff (två "Tim Johansson") → FRÅGAR vilken (kandidatlista), gissar
 *     INTE och levererar inget.
 *   • 0 träff → tydligt fel, levererar inget.
 *   • tenantId i input som inte tillhör org → avvisas, levererar inget.
 *   • category=INVOICE coercas till OTHER (annars osynligt i portalen).
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { ACTION_TOOLS } from './ai-tools.definition'

type T = {
  id: string
  type: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
  email: string
}

const TIM: T = {
  id: 'tenant-tim',
  type: 'INDIVIDUAL',
  firstName: 'Tim',
  lastName: 'Johansson',
  companyName: null,
  email: 'tim@example.com',
}
const ANNA: T = {
  id: 'tenant-anna',
  type: 'INDIVIDUAL',
  firstName: 'Anna',
  lastName: 'Berg',
  companyName: null,
  email: 'anna@example.com',
}
const TIM2: T = {
  id: 'tenant-tim2',
  type: 'INDIVIDUAL',
  firstName: 'Tim',
  lastName: 'Johansson',
  companyName: null,
  email: 'tim.j@example.com',
}

function makeExecutor(tenants: T[]) {
  const deliverToTenant = jest
    .fn()
    .mockResolvedValue({ documentId: 'doc-1', tenantId: 'tenant-tim' })
  const documentDelivery = { deliverToTenant }
  const tenantsService = { findAll: jest.fn().mockResolvedValue(tenants) }
  const pdfService = { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Hyresvärd AB' }) },
  }
  const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) }
  const noop = {} as never

  const executor = new ToolExecutorService(
    prisma as never, // 1 prisma
    noop, // 2 invoicesService
    pdfService as never, // 3 pdfService
    tenantsService as never, // 4 tenantsService
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
    noop, // 16 reconciliationService
    noop, // 17 collectionExport
    noop, // 18 paymentReminders
    noop, // 19 storage
    noop, // 20 redis
    audit as never, // 21 audit
    documentDelivery as never, // 22 documentDelivery
  )
  return { executor, deliverToTenant }
}

describe('send_document_to_tenant — confirm-grind', () => {
  it('ligger i ACTION_TOOLS → kräver mänsklig bekräftelse innan leverans', () => {
    expect(ACTION_TOOLS.has('send_document_to_tenant')).toBe(true)
  })
})

describe('send_document_to_tenant — leverans + disambiguering', () => {
  it('EXAKT 1 träff → levererar med tenantId från upplöst tenant + org från anroparen', async () => {
    const { executor, deliverToTenant } = makeExecutor([TIM, ANNA])
    const res = await executor.executeTool(
      'send_document_to_tenant',
      { tenantName: 'Tim Johansson', title: 'Information', content: 'Hej\nVälkommen.' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(res.success).toBe(true)
    expect(deliverToTenant).toHaveBeenCalledTimes(1)
    const arg = deliverToTenant.mock.calls[0][0]
    expect(arg.tenantId).toBe('tenant-tim') // härlett från resolution, ej input
    expect(arg.organizationId).toBe('org-1') // org från anroparen (JWT)
    expect(arg.name).toBe('Information')
    expect(arg.notify).toBe(true) // default
  })

  it('>1 träff → FRÅGAR vilken (kandidatlista), levererar INGET', async () => {
    const { executor, deliverToTenant } = makeExecutor([TIM, TIM2, ANNA])
    const res = await executor.executeTool(
      'send_document_to_tenant',
      { tenantName: 'Tim Johansson', title: 'Information', content: 'Hej' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(res.success).toBe(false)
    expect(deliverToTenant).not.toHaveBeenCalled()
    // kandidaterna returneras (namn/id) så människan kan välja
    const ids = (res.data as { candidates: Array<{ id: string }> }).candidates.map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['tenant-tim', 'tenant-tim2']))
    expect(res.message).toContain('flera hyresgäster')
    expect(res.message).toContain('tenant-tim')
  })

  it('0 träff → fel, levererar inget (föreslår INTE att skapa hyresgäst)', async () => {
    const { executor, deliverToTenant } = makeExecutor([ANNA])
    const res = await executor.executeTool(
      'send_document_to_tenant',
      { tenantName: 'Okänd Person', title: 'X', content: 'Y' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(res.success).toBe(false)
    expect(res.suggestCreateTenant).toBeUndefined()
    expect(deliverToTenant).not.toHaveBeenCalled()
  })

  it('tenantId som inte tillhör org → avvisas, levererar inget', async () => {
    const { executor, deliverToTenant } = makeExecutor([TIM, ANNA])
    const res = await executor.executeTool(
      'send_document_to_tenant',
      { tenantId: 'tenant-i-annan-org', title: 'X', content: 'Y' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(res.success).toBe(false)
    expect(deliverToTenant).not.toHaveBeenCalled()
  })

  it('explicit tenantId inom org levererar till exakt den tenanten', async () => {
    const { executor, deliverToTenant } = makeExecutor([TIM, TIM2, ANNA])
    const res = await executor.executeTool(
      'send_document_to_tenant',
      { tenantId: 'tenant-tim2', title: 'X', content: 'Y' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(res.success).toBe(true)
    expect(deliverToTenant.mock.calls[0][0].tenantId).toBe('tenant-tim2')
  })

  it('category=INVOICE coercas till OTHER innan leverans (annars osynligt i portalen)', async () => {
    const { executor, deliverToTenant } = makeExecutor([TIM])
    await executor.executeTool(
      'send_document_to_tenant',
      { tenantName: 'Tim', title: 'X', content: 'Y', category: 'INVOICE' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(deliverToTenant.mock.calls[0][0].category).toBe('OTHER')
  })

  it('notifyTenant=false → ingen notis begärs', async () => {
    const { executor, deliverToTenant } = makeExecutor([TIM])
    await executor.executeTool(
      'send_document_to_tenant',
      { tenantName: 'Tim', title: 'X', content: 'Y', notifyTenant: false },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(deliverToTenant.mock.calls[0][0].notify).toBe(false)
  })

  it('MANAGER får använda verktyget (paritet med compose_and_send_email), VIEWER nekas', async () => {
    const ok = makeExecutor([TIM])
    const resManager = await ok.executor.executeTool(
      'send_document_to_tenant',
      { tenantName: 'Tim', title: 'X', content: 'Y' },
      'org-1',
      'user-1',
      'MANAGER',
    )
    expect(resManager.success).toBe(true)

    const denied = makeExecutor([TIM])
    await expect(
      denied.executor.executeTool(
        'send_document_to_tenant',
        { tenantName: 'Tim', title: 'X', content: 'Y' },
        'org-1',
        'user-1',
        'VIEWER',
      ),
    ).rejects.toThrow()
    expect(denied.deliverToTenant).not.toHaveBeenCalled()
  })
})
