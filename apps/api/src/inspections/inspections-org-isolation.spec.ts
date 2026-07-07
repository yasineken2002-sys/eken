/**
 * IDOR-svep (#5/#19-klassen; doc:en listade FELAKTIGT inspections som "OK"):
 * inspections.create applicerade klient-skickade relations-id (propertyId/unitId/
 * leaseId/tenantId) RÅTT → org A kunde koppla en besiktning till org B:s data och
 * få tillbaka offrets tenant-PII (FULL_INCLUDE → SAFE_TENANT_SELECT). Fix: org-
 * scopad validering innan skrivning.
 *
 * Bevisar: främmande orgs id → 404 + INGEN inspection.create; egen orgs id → funkar.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { InspectionsService } from './inspections.service'

function make() {
  const prisma = {
    property: { findFirst: jest.fn() },
    unit: { findFirst: jest.fn() },
    lease: { findFirst: jest.fn() },
    tenant: { findFirst: jest.fn() },
    inspection: {
      create: jest.fn().mockResolvedValue({ id: 'i1' }),
      findUnique: jest.fn().mockResolvedValue({ id: 'i1' }),
    },
    inspectionItem: { createMany: jest.fn() },
  }
  const service = new InspectionsService(prisma as never, {} as never, {} as never)
  return { service, prisma }
}

const DTO = (over: Record<string, unknown>) => ({
  type: 'PERIODIC',
  scheduledDate: '2026-05-01',
  propertyId: 'p-A',
  unitId: 'unit-A',
  ...over,
})

describe('InspectionsService.create — org-isolation av relations-id (#5)', () => {
  it('främmande orgs tenantId → 404, INGEN inspection.create', async () => {
    const { service, prisma } = make()
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    prisma.unit.findFirst.mockResolvedValue({ id: 'unit-A' })
    prisma.tenant.findFirst.mockResolvedValue(null) // finns ej i org-A
    await expect(
      service.create(DTO({ tenantId: 't-B' }) as never, 'org-A', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.inspection.create).not.toHaveBeenCalled()
  })

  it('främmande orgs unitId → 404, INGEN inspection.create', async () => {
    const { service, prisma } = make()
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    prisma.unit.findFirst.mockResolvedValue(null) // enheten finns ej i org-A
    await expect(
      service.create(DTO({ unitId: 'unit-B' }) as never, 'org-A', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.inspection.create).not.toHaveBeenCalled()
  })

  it('egen orgs id → besiktning skapas', async () => {
    const { service, prisma } = make()
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    prisma.unit.findFirst.mockResolvedValue({ id: 'unit-A' })
    prisma.tenant.findFirst.mockResolvedValue({ id: 't-A' })
    await service.create(DTO({ tenantId: 't-A' }) as never, 'org-A', 'u1')
    expect(prisma.inspection.create).toHaveBeenCalledTimes(1)
  })
})
