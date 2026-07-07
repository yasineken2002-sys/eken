/**
 * Launch-readiness #19 (IDOR): leases.update fick applicera ett klient-skickat
 * tenantId RÅTT → org A kunde peka sitt avtal på org B:s hyresgäst och få tillbaka
 * offrets fulla PII (SAFE_TENANT_SELECT: personnr, namn, adress) + korrumpera data.
 * Fix: org-scopad tenant-validering INNAN applicering (speglar unitId/invoices.update).
 *
 * Bevisar: främmande orgs tenantId → nekas (404), INGEN update (ingen läcka, ingen
 * korruption); egen orgs tenantId → funkar; icke-tenant-uppdatering oförändrad.
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { LeasesService } from './leases.service'

const EXISTING = {
  id: 'lease-A',
  status: 'ACTIVE',
  organizationId: 'org-A',
  unitId: 'unit-A',
  tenantId: 'tenant-A',
  unit: { type: 'APARTMENT' },
  monthlyRent: 8000,
  depositAmount: 0,
  noticePeriodMonths: 3,
}

function makeService() {
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue(EXISTING), // findOne
      update: jest.fn().mockResolvedValue({ id: 'lease-A' }),
    },
    unit: { findFirst: jest.fn() },
    tenant: { findFirst: jest.fn() },
  }
  const noop = {} as never
  const service = new LeasesService(
    prisma as never,
    noop, // notifications
    noop, // deposits
    noop, // rentIncreases
    noop, // tenantAuth
    noop, // contracts
    noop, // contractNumbers
    noop, // activationQueue
  )
  return { service, prisma }
}

describe('LeasesService.update — tenant-org-isolation (#19)', () => {
  it('främmande orgs tenantId → 404, INGEN update (ingen PII-läcka, ingen korruption)', async () => {
    const { service, prisma } = makeService()
    prisma.tenant.findFirst.mockResolvedValue(null) // tenant-B finns inte i org-A

    await expect(
      service.update('lease-A', { tenantId: 'tenant-B' } as never, 'org-A'),
    ).rejects.toBeInstanceOf(NotFoundException)

    // Org-scopad kontroll gjordes...
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-B', organizationId: 'org-A' },
      select: { id: true },
    })
    // ...och INGEN skrivning skedde → varken läcka eller datakorruption.
    expect(prisma.lease.update).not.toHaveBeenCalled()
  })

  it('egen orgs tenantId → tillåts (uppdatering sker)', async () => {
    const { service, prisma } = makeService()
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-A2' }) // finns i org-A

    await service.update('lease-A', { tenantId: 'tenant-A2' } as never, 'org-A')

    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-A2', organizationId: 'org-A' },
      select: { id: true },
    })
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
    const data = (prisma.lease.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.tenantId).toBe('tenant-A2')
  })

  it('icke-tenant-uppdatering (t.ex. hyra) fungerar oförändrat — ingen tenant-kontroll', async () => {
    const { service, prisma } = makeService()

    await service.update('lease-A', { monthlyRent: 9000 } as never, 'org-A')

    expect(prisma.tenant.findFirst).not.toHaveBeenCalled() // inget tenantId → ingen kontroll
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })
})
