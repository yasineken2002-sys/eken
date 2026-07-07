/**
 * tenantId-buggen på AI-kontraktsgenereringen (generate_lease_contract).
 *
 * Tidigare skapade AI-vägens Document.create raden MED leaseId men UTAN
 * tenantId → kontraktet blev osynligt i hyresgästportalen (getDocuments
 * filtrerar strikt på tenantId). Admin-kontraktsvägen
 * (contract-template.service) sätter redan tenantId: lease.tenantId.
 *
 * Verifierar att AI-vägen nu:
 *   • sätter tenantId på dokumentet → portal-synligt.
 *   • härleder tenantId från den faktiska leasen (server-side), ALDRIG från
 *     AI/klient-input.
 *   • bevarar org-scoping: leasen slås upp via unit.property.organizationId,
 *     en lease i annan org hittas inte och inget dokument skapas.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { ACTION_TOOLS } from './ai-tools.definition'

const LEASE = {
  id: 'lease-1',
  tenantId: 'tenant-real',
  unitId: 'unit-1',
  startDate: new Date('2026-01-01'),
  endDate: null,
  monthlyRent: 12000,
  depositAmount: 0,
  tenant: {
    type: 'INDIVIDUAL',
    firstName: 'Anna',
    lastName: 'Andersson',
    email: 'anna@example.com',
    phone: null,
    companyName: null,
  },
  unit: {
    id: 'unit-1',
    name: 'Lägenhet 1',
    unitNumber: '1',
    area: 55,
    propertyId: 'prop-1',
    property: {
      id: 'prop-1',
      name: 'Storgatan 1',
      propertyDesignation: 'Eken 1:1',
      street: 'Storgatan 1',
      postalCode: '11122',
      city: 'Stockholm',
    },
  },
}

const ORG = {
  id: 'org-1',
  name: 'Hyresvärd AB',
  street: 'Kungsgatan 1',
  postalCode: '11143',
  city: 'Stockholm',
  bankgiro: '123-4567',
}

function makeExecutor(leaseRow: typeof LEASE | null = LEASE) {
  const documentCreate = jest.fn().mockResolvedValue({ id: 'doc-1' })
  const leaseFindFirst = jest.fn().mockResolvedValue(leaseRow)
  const orgFindUnique = jest.fn().mockResolvedValue(ORG)
  const prisma = {
    lease: { findFirst: leaseFindFirst },
    organization: { findUnique: orgFindUnique },
    document: { create: documentCreate },
  }
  const pdfService = { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')) }
  const storage = { uploadFile: jest.fn().mockResolvedValue('https://r2.example/doc.pdf') }
  const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) }
  const noop = {} as never

  const executor = new ToolExecutorService(
    prisma as never, // 1 prisma
    noop, // 2 invoicesService
    pdfService as never, // 3 pdfService
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
    noop, // 16 reconciliationService
    noop, // 17 collectionExport
    noop, // 18 paymentReminders
    storage as never, // 19 storage
    noop, // 20 redis
    audit as never, // 21 audit
    noop, // 22 documentDelivery
    noop, // 23 signingService
  )
  return { executor, documentCreate, leaseFindFirst, orgFindUnique }
}

describe('generate_lease_contract — tenantId härleds från lease (portal-synlighet)', () => {
  it('ligger kvar i ACTION_TOOLS → confirm-grinden gäller (oförändrat beteende)', () => {
    expect(ACTION_TOOLS.has('generate_lease_contract')).toBe(true)
  })

  it('sätter tenantId = lease.tenantId på dokumentet → blir portal-synligt', async () => {
    const { executor, documentCreate } = makeExecutor()
    const result = await executor.executeTool(
      'generate_lease_contract',
      { leaseId: 'lease-1', contractType: 'RESIDENTIAL' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    expect(result.success).toBe(true)
    expect(documentCreate).toHaveBeenCalledTimes(1)
    const data = documentCreate.mock.calls[0][0].data
    expect(data.tenantId).toBe('tenant-real')
    expect(data.leaseId).toBe('lease-1')
    expect(data.organizationId).toBe('org-1')
    expect(data.category).toBe('CONTRACT')
  })

  it('tenantId kommer från leasen, ALDRIG från AI/klient-input', async () => {
    const { executor, documentCreate } = makeExecutor()
    // AI:n försöker injicera en annan tenantId i tool-input.
    await executor.executeTool(
      'generate_lease_contract',
      { leaseId: 'lease-1', contractType: 'RESIDENTIAL', tenantId: 'tenant-attacker' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    const data = documentCreate.mock.calls[0][0].data
    // Input-tenantId ignoreras helt — dokumentet får leasens tenant.
    expect(data.tenantId).toBe('tenant-real')
    expect(data.tenantId).not.toBe('tenant-attacker')
  })

  it('org-scoping: leasen slås upp via unit.property.organizationId', async () => {
    const { executor, leaseFindFirst } = makeExecutor()
    await executor.executeTool(
      'generate_lease_contract',
      { leaseId: 'lease-1', contractType: 'RESIDENTIAL' },
      'org-1',
      'user-1',
      'ADMIN',
    )
    const where = leaseFindFirst.mock.calls[0][0].where
    expect(where.id).toBe('lease-1')
    expect(where.unit.property.organizationId).toBe('org-1')
  })

  it('lease i annan org hittas inte → inget dokument skapas (ingen läcka)', async () => {
    const { executor, documentCreate } = makeExecutor(null)
    const result = await executor.executeTool(
      'generate_lease_contract',
      { leaseId: 'lease-1', contractType: 'RESIDENTIAL' },
      'org-2',
      'user-1',
      'ADMIN',
    )
    expect(result.success).toBe(false)
    expect(documentCreate).not.toHaveBeenCalled()
  })
})
