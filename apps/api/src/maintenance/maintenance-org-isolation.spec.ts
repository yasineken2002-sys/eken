/**
 * IDOR-svep (#5/#19-klassen): maintenance.create OCH .update applicerade
 * klient-skickade relations-id (propertyId/unitId/tenantId) RÅTT → org A kunde
 * koppla sitt ärende till org B:s enhet/hyresgäst och få tillbaka offrets tenant-
 * PII (include: email/phone). Fix: org-scopad validering innan skrivning.
 *
 * Bevisar per metod: främmande orgs id → 404 + skriv-metoden anropas ALDRIG
 * (ingen läcka, ingen korruption); egen orgs id → funkar oförändrat.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { MaintenanceService } from './maintenance.service'

function make() {
  const prisma = {
    property: { findFirst: jest.fn() },
    unit: { findFirst: jest.fn() },
    tenant: { findFirst: jest.fn() },
    maintenanceTicketSequence: { upsert: jest.fn().mockResolvedValue({ lastNumber: 1 }) },
    maintenanceTicket: {
      create: jest.fn().mockResolvedValue({ id: 't1', ticketNumber: 'UND-00001' }),
      update: jest.fn().mockResolvedValue({ id: 't1' }),
    },
  }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  const service = new MaintenanceService(prisma as never, notifications as never, {} as never)
  return { service, prisma }
}

describe('MaintenanceService — org-isolation av relations-id (#5)', () => {
  it('create: främmande orgs tenantId → 404, INGEN ticket skapad', async () => {
    const { service, prisma } = make()
    prisma.tenant.findFirst.mockResolvedValue(null) // finns ej i org-A
    await expect(
      service.create({ propertyId: 'p-A', tenantId: 't-B', title: 'x' } as never, 'org-A', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.maintenanceTicket.create).not.toHaveBeenCalled()
  })

  it('create: egen orgs id → ticket skapas', async () => {
    const { service, prisma } = make()
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    prisma.tenant.findFirst.mockResolvedValue({ id: 't-A' })
    await service.create({ propertyId: 'p-A', tenantId: 't-A', title: 'x' } as never, 'org-A', 'u1')
    expect(prisma.maintenanceTicket.create).toHaveBeenCalledTimes(1)
  })

  it('update: främmande orgs unitId → 404, INGEN update', async () => {
    const { service, prisma } = make()
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 't1', organizationId: 'org-A' } as never)
    prisma.unit.findFirst.mockResolvedValue(null) // enheten finns ej i org-A
    await expect(
      service.update('t1', { unitId: 'unit-B' } as never, 'org-A'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.maintenanceTicket.update).not.toHaveBeenCalled()
  })

  it('update: egen orgs unitId → update sker', async () => {
    const { service, prisma } = make()
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 't1', organizationId: 'org-A' } as never)
    prisma.unit.findFirst.mockResolvedValue({ id: 'unit-A' })
    await service.update('t1', { unitId: 'unit-A' } as never, 'org-A')
    expect(prisma.maintenanceTicket.update).toHaveBeenCalledTimes(1)
  })
})
