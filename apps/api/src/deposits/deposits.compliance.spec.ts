/**
 * Compliance-test för deposit-tak vid skapande av deposit-faktura via
 * /deposits-endpointen (separat från lease.create-flödet som validerar samma
 * regel innan lease skrivs). Detta endpoint kan ta ett explicit dto.amount
 * som skiljer sig från lease.depositAmount, så validering måste ske här också.
 */

import { BadRequestException } from '@nestjs/common'
import type { UnitType } from '@prisma/client'
import { DepositsService } from './deposits.service'

describe('Hyreslagen-compliance: deposits.create() — depositionstak', () => {
  function makeService(opts: { unitType: UnitType; monthlyRent: number }) {
    const lease = {
      id: 'lease-1',
      tenantId: 'tenant-1',
      depositAmount: opts.monthlyRent * 2, // standard 2 mån
      monthlyRent: opts.monthlyRent,
      unit: { type: opts.unitType },
    }

    const prisma = {
      lease: { findFirst: jest.fn().mockResolvedValue(lease) },
      deposit: {
        findUnique: jest.fn().mockResolvedValue(null), // ingen befintlig
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve({ id: 'dep-1', ...(data as Record<string, unknown>) }),
          ),
      },
      invoice: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          id: 'inv-1',
          invoiceNumber: 'F-2026-0001',
          total: 30_000,
          issueDate: new Date('2026-05-29'),
        }),
      },
      invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        return cb(prisma)
      }),
    }

    const accounting = {
      createJournalEntryForDepositInvoice: jest.fn().mockResolvedValue(undefined),
    }
    const notifications = { createForAllOrgUsers: jest.fn() }

    const service = new DepositsService(
      prisma as never,
      accounting as never,
      notifications as never,
    )
    return { service, prisma }
  }

  it('avvisar bostad när dto.amount > 3 × månadshyra (10000 × 3 = 30000 → 30001 nekas)', async () => {
    const { service } = makeService({ unitType: 'APARTMENT', monthlyRent: 10_000 })
    await expect(
      service.create({ leaseId: 'lease-1', amount: 30_001 }, 'org-1', 'user-1'),
    ).rejects.toThrow(BadRequestException)
    await expect(
      service.create({ leaseId: 'lease-1', amount: 30_001 }, 'org-1', 'user-1'),
    ).rejects.toThrow(/3 månadshyror/)
  })

  it('accepterar bostad med dto.amount = exakt 3 × månadshyra', async () => {
    const { service, prisma } = makeService({ unitType: 'APARTMENT', monthlyRent: 10_000 })
    await service.create({ leaseId: 'lease-1', amount: 30_000 }, 'org-1', 'user-1')
    expect(prisma.deposit.create).toHaveBeenCalled()
  })

  it('tillåter fri deposition för lokal (OFFICE 200000 kr på 10000 hyra)', async () => {
    const { service, prisma } = makeService({ unitType: 'OFFICE', monthlyRent: 10_000 })
    await service.create({ leaseId: 'lease-1', amount: 200_000 }, 'org-1', 'user-1')
    expect(prisma.deposit.create).toHaveBeenCalled()
  })

  it('avvisar dto.amount = 0 (befintlig regel — depositionsbelopp måste vara > 0)', async () => {
    const { service } = makeService({ unitType: 'APARTMENT', monthlyRent: 10_000 })
    await expect(
      service.create({ leaseId: 'lease-1', amount: 0 }, 'org-1', 'user-1'),
    ).rejects.toThrow(/större än 0/)
  })
})
