/**
 * T1.3 — härdning av applyDueIncreases (zombie-skrivningsbuggen).
 *
 * Före T1.3 skrev cronen monthlyRent på leaseId oavsett status och flippade
 * APPLIED: en höjning vars avtal hunnit förnyas (EXPIRED) konsumerades tyst —
 * gamla (döda) avtalet fick nya hyran, nya avtalet ingenting. Bevisar:
 *   A) urvalet kräver lease.status ACTIVE,
 *   B) race-fönstret läcks inte: blir avtalet icke-ACTIVE mellan läsning och
 *      skrivning (updateMany count 0) förblir höjningen ACCEPTED — den ägs
 *      då av succession-VOID-steget,
 *   C) normalflödet applicerar + flippar APPLIED som förut.
 */

// rent-increases.service importerar transitivt StorageService (→ @aws-sdk,
// ESM som jest inte transformerar) via NotificationsService — mocka bort.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { RentIncreasesService } from './rent-increases.service'

function makeService(opts: { updateCount: number }) {
  const tx = {
    lease: { updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount }) },
    rentIncrease: { update: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    rentIncrease: {
      findMany: jest.fn().mockResolvedValue([{ id: 'ri-1', leaseId: 'lease-1', newRent: 12000 }]),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const noop = {} as never
  const service = new RentIncreasesService(prisma as never, noop, noop)
  return { service, prisma, tx }
}

describe('T1.3 · applyDueIncreases skriver aldrig mot icke-ACTIVE avtal', () => {
  it('A: urvalet filtrerar på lease.status ACTIVE', async () => {
    const { service, prisma } = makeService({ updateCount: 1 })
    await service.applyDueIncreases(new Date('2026-07-01'))

    expect(prisma.rentIncrease.findMany.mock.calls[0]![0].where).toMatchObject({
      status: 'ACCEPTED',
      lease: { status: 'ACTIVE' },
    })
  })

  it('B: race-fönstret — updateMany count 0 → höjningen förblir ACCEPTED', async () => {
    const { service, tx } = makeService({ updateCount: 0 })
    const applied = await service.applyDueIncreases(new Date('2026-07-01'))

    expect(applied).toBe(0)
    expect(tx.lease.updateMany).toHaveBeenCalledWith({
      where: { id: 'lease-1', status: 'ACTIVE' },
      data: { monthlyRent: 12000 },
    })
    // APPLIED får INTE flippas — höjningen ägs av succession-VOID-steget
    expect(tx.rentIncrease.update).not.toHaveBeenCalled()
  })

  it('C: normalflödet applicerar hyran och flippar APPLIED', async () => {
    const { service, tx } = makeService({ updateCount: 1 })
    const applied = await service.applyDueIncreases(new Date('2026-07-01'))

    expect(applied).toBe(1)
    expect(tx.rentIncrease.update).toHaveBeenCalledWith({
      where: { id: 'ri-1' },
      data: { status: 'APPLIED' },
    })
  })
})
