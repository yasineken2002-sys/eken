/**
 * H4 — AI-verktyget apply_rent_increase går genom RentIncreasesService.create()
 * och skriver ALDRIG direkt på lease.monthlyRent (JB 12 kap 54 a §).
 *
 * Verifierar att executeTool('apply_rent_increase'):
 *   • anropar rentIncreasesService.create() med leaseId/newRent/reason/effectiveDate
 *   • INTE anropar prisma.lease.update (ingen ensidig direkt höjning)
 *   • returnerar ett DRAFT-svar som hänvisar till send-notice (54 a §-flödet)
 *   • avvisar saknat effectiveDate
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

function makeExecutor() {
  const create = jest.fn().mockResolvedValue({
    id: 'ri-1',
    currentRent: 10000,
    newRent: 10500,
  })
  const leaseUpdate = jest.fn()
  const prisma = { lease: { update: leaseUpdate, findFirst: jest.fn() } }
  const rentIncreasesService = { create }
  const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) }

  // Konstruktorns positionsordning (21 deps). Endast prisma(1),
  // rentIncreasesService(6) och audit(21) behöver vara riktiga mocks.
  const noop = {} as never
  const executor = new ToolExecutorService(
    prisma as never, // 1 prisma
    noop, // 2 invoicesService
    noop, // 3 pdfService
    noop, // 4 tenantsService
    noop, // 5 leasesService
    rentIncreasesService as never, // 6 rentIncreasesService
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
  )
  return { executor, create, leaseUpdate }
}

describe('apply_rent_increase — JB 54 a §-säker (H4)', () => {
  it('går genom RentIncreasesService.create() och rör aldrig lease.monthlyRent', async () => {
    const { executor, create, leaseUpdate } = makeExecutor()

    const result = await executor.executeTool(
      'apply_rent_increase',
      {
        leaseId: 'lease-1',
        tenantName: 'Anna',
        currentRent: 10000,
        newRent: 10500,
        effectiveDate: '2026-10-01',
        reason: 'Indexjustering enligt avtal',
      },
      'org-1',
      'user-1',
      'ADMIN',
    )

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatchObject({
      leaseId: 'lease-1',
      newRent: 10500,
      reason: 'Indexjustering enligt avtal',
      effectiveDate: '2026-10-01',
    })
    expect(create.mock.calls[0][1]).toBe('org-1')
    // INGEN direkt hyreshöjning
    expect(leaseUpdate).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.message).toContain('send-notice')
    expect(result.message).toContain('INTE ändrad')
  })

  it('avvisar saknat effectiveDate utan att skapa något', async () => {
    const { executor, create } = makeExecutor()

    const result = await executor.executeTool(
      'apply_rent_increase',
      { leaseId: 'lease-1', tenantName: 'Anna', currentRent: 10000, newRent: 10500 },
      'org-1',
      'user-1',
      'ADMIN',
    )

    expect(result.success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})
