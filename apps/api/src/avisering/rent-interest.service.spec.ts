/**
 * Inkasso PR 3 — RentInterestService.crystallizeInterest.
 *
 * Täcker:
 *   • ränta från dagen EFTER förfallodagen (dagräkning),
 *   • dynamisk referensränta ur tabellen + 8 procentenheter,
 *   • beräkningsbas = obetalt KAPITAL (hyra + förbrukning), aldrig avgift/ränta,
 *   • bokförd 1510/8131 (via accounting.bookInterest),
 *   • INV-A: bokföring null → kastar, ingen markering/event,
 *   • idempotens per kristalliseringspunkt + inkrementell delta-bokföring.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { RentInterestService } from './rent-interest.service'

const baseNotice = {
  id: 'rn-1',
  noticeNumber: 'AVI-2026-05-0001',
  type: 'RENT',
  status: 'OVERDUE',
  dueDate: new Date('2026-05-01T00:00:00.000Z'),
  totalAmount: new Decimal(8000),
  consumptionAmount: new Decimal(0),
  reminderFeeAmount: new Decimal(60),
  interestAccruedAmount: new Decimal(0),
}

function makeService(
  opts: {
    notice?: Record<string, unknown> | null
    ratePercent?: number | null
    existingJournal?: boolean
    bookReturns?: { id: string } | null
  } = {},
) {
  const notice = opts.notice === undefined ? { ...baseNotice } : opts.notice
  const tx = {
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(notice),
      update: jest.fn().mockResolvedValue({}),
    },
    referenceInterestRate: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.ratePercent == null ? null : { ratePercent: new Decimal(opts.ratePercent) },
        ),
    },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(opts.existingJournal ? { id: 'je-existing' } : null),
    },
  }
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  }
  const accounting = {
    bookInterest: jest
      .fn()
      .mockResolvedValue(opts.bookReturns === undefined ? { id: 'je-int' } : opts.bookReturns),
  }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const service = new RentInterestService(
    prisma as never,
    accounting as never,
    rentNoticeEvents as never,
  )
  return { service, tx, accounting, rentNoticeEvents }
}

describe('crystallizeInterest', () => {
  it('beräknar ränta från dag efter förfallo, dynamisk ränta+8, bas=kapital', async () => {
    // referensränta 2 % → effektiv 10 %. 30 dagar. bas 8000 (EXKL avgift 60).
    // 8000 × 0,10 × 30/365 = 65,75.
    const { service, accounting, tx, rentNoticeEvents } = makeService({ ratePercent: 2 })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-31T00:00:00.000Z'),
    )

    expect(result).toMatchObject({ delta: 65.75, total: 65.75, effectiveRatePercent: 10, days: 30 })

    const feeArg = accounting.bookInterest.mock.calls[0]![0]
    expect(feeArg).toMatchObject({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'interest:rn-1:2026-05-31',
      amount: 65.75,
    })
    // Markering uppdateras atomiskt (i samma tx).
    expect(tx.rentNotice.update.mock.calls[0]![0].data.interestAccruedThrough).toBeInstanceOf(Date)
    expect(Number(tx.rentNotice.update.mock.calls[0]![0].data.interestAccruedAmount)).toBe(65.75)
    // Event loggar bas (kapital, inte avgift) + effektiv ränta.
    expect(rentNoticeEvents.record.mock.calls[0]![4]).toMatchObject({
      base: 8000,
      effectiveRatePercent: 10,
      days: 30,
      interestDelta: 65.75,
    })
  })

  it('referensräntan läses DYNAMISKT ur tabellen (+8): 3 % → effektiv 11 %', async () => {
    const { service, accounting, tx } = makeService({ ratePercent: 3 })
    await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31T00:00:00.000Z'))
    // Tabellen frågas med effectiveFrom <= förfallodatum, senaste raden.
    const where = tx.referenceInterestRate.findFirst.mock.calls[0]![0]
    expect(where.where.effectiveFrom.lte).toBeInstanceOf(Date)
    expect(where.orderBy).toMatchObject({ effectiveFrom: 'desc' })
    // 8000 × 0,11 × 30/365 = 72,33.
    expect(accounting.bookInterest.mock.calls[0]![0].amount).toBeCloseTo(72.33, 2)
  })

  it('1 dag efter förfallo ger exakt 1 räntedag', async () => {
    const { service, accounting } = makeService({ ratePercent: 2 })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-02T00:00:00.000Z'),
    )
    expect(result?.days).toBe(1)
    // 8000 × 0,10 × 1/365 = 2,19.
    expect(accounting.bookInterest.mock.calls[0]![0].amount).toBeCloseTo(2.19, 2)
  })

  it('inkrementell delta: redan bokförd ränta dras av', async () => {
    const { service, accounting, tx } = makeService({
      ratePercent: 2,
      notice: { ...baseNotice, interestAccruedAmount: new Decimal(50) },
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-31T00:00:00.000Z'),
    )
    // total 65,75 − redan bokfört 50 = delta 15,75.
    expect(result).toMatchObject({ delta: 15.75, total: 65.75 })
    expect(accounting.bookInterest.mock.calls[0]![0].amount).toBe(15.75)
    expect(Number(tx.rentNotice.update.mock.calls[0]![0].data.interestAccruedAmount)).toBe(65.75)
  })

  it('INV-A: bokföring null (saknat 1510/8131) → kastar, ingen markering/event', async () => {
    const { service, tx, rentNoticeEvents } = makeService({ ratePercent: 2, bookReturns: null })
    await expect(
      service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31T00:00:00.000Z')),
    ).rejects.toThrow()
    expect(tx.rentNotice.update).not.toHaveBeenCalled()
    expect(rentNoticeEvents.record).not.toHaveBeenCalled()
  })

  it('idempotent: redan kristalliserad punkt → null, ingen bokföring', async () => {
    const { service, accounting } = makeService({ ratePercent: 2, existingJournal: true })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-31T00:00:00.000Z'),
    )
    expect(result).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })

  it('ingen referensränta i tabellen → null, ingen gissad ränta', async () => {
    const { service, accounting } = makeService({ ratePercent: null })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-31T00:00:00.000Z'),
    )
    expect(result).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })

  it('betald avi → ingen ränta', async () => {
    const { service, accounting } = makeService({
      ratePercent: 2,
      notice: { ...baseNotice, status: 'PAID' },
    })
    expect(
      await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31T00:00:00.000Z')),
    ).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })

  it('throughDate före/på förfallo (0 dagar) → null', async () => {
    const { service, accounting } = makeService({ ratePercent: 2 })
    expect(
      await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-01T00:00:00.000Z')),
    ).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })
})
