/**
 * Inkasso PR 5 — RentBadDebtService (kundförlust).
 *
 * Täcker:
 *   • BEFARAD: 1515/1510 atomisk omklassning (claim + verifikat + markering),
 *   • KONSTATERAD: 6352/1515 atomisk avskrivning + WRITTEN_OFF-flip,
 *   • INV-A: bokföring null → kastar, ingen flip/markering,
 *   • idempotens (redan befarad / redan WRITTEN_OFF), race-säker claim,
 *   • bostadshyra (momsfri) fungerar; LOKALHYRA (vatAmount>0) VÄGRAS (revisorfråga),
 *   • konstaterad kräver befarad först; org-scoping (NotFound i annan org),
 *   • cron: momsfri inkasso-redo omklassas, momspliktig räknas som manuell.
 */

import { RentBadDebtService } from './rent-bad-debt.service'
import { Decimal } from '@prisma/client/runtime/library'

function notice(over: Record<string, unknown> = {}) {
  return {
    id: 'rn-1',
    noticeNumber: 'AVI-2026-07-0001',
    status: 'OVERDUE',
    type: 'RENT',
    collectionStage: 'INKASSO_READY',
    probableLossAt: null,
    vatAmount: new Decimal(0), // momsfri = bostadshyra
    totalAmount: new Decimal(8000),
    consumptionAmount: new Decimal(300),
    reminderFeeAmount: new Decimal(60),
    interestAccruedAmount: new Decimal(140),
    paidAmount: null,
    lines: [{ vatRate: 0 }], // momsfri förbrukningsrad
    ...over,
  }
}

function makeService(
  opts: {
    notice?: Record<string, unknown> | null
    claimCount?: number
    probableEntry?: { lines: Array<{ debit?: number; credit?: number }> } | null
    reclassReturnsNull?: boolean
    writeOffReturnsNull?: boolean
  } = {},
) {
  const tx = {
    rentNotice: { updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }) },
  }
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(opts.notice === undefined ? notice() : opts.notice),
      findMany: jest.fn().mockResolvedValue([]),
    },
    journalEntry: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.probableEntry === undefined
            ? { lines: [{ debit: 8500 }, { credit: 8500 }] }
            : opts.probableEntry,
        ),
    },
  }
  const accounting = {
    bookBadDebtReclassification: jest
      .fn()
      .mockResolvedValue(opts.reclassReturnsNull ? null : { id: 'je-befarad' }),
    bookBadDebtWriteOff: jest
      .fn()
      .mockResolvedValue(opts.writeOffReturnsNull ? null : { id: 'je-konstaterad' }),
  }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const service = new RentBadDebtService(
    prisma as never,
    accounting as never,
    rentNoticeEvents as never,
  )
  return { service, prisma, tx, accounting, rentNoticeEvents }
}

describe('reclassifyToProbableLoss (befarad)', () => {
  it('momsfri bostadshyra: bokför 1515/1510 atomiskt, markerar probableLossAt, loggar', async () => {
    const { service, tx, accounting, rentNoticeEvents } = makeService()
    const res = await service.reclassifyToProbableLoss('rn-1', 'org-1', 'user-1')
    expect(res).toEqual({ booked: true })

    // Race-säker claim på (probableLossAt null, ej PAID/CANCELLED).
    const claim = tx.rentNotice.updateMany.mock.calls[0]![0]
    expect(claim.where).toMatchObject({ id: 'rn-1', organizationId: 'org-1', probableLossAt: null })
    expect(claim.data.probableLossAt).toBeInstanceOf(Date)

    // Belopp = 8000 + 300 + 60 + 140 = 8500, atomiskt (tx), idempotent sourceId.
    const arg = accounting.bookBadDebtReclassification.mock.calls[0]![0]
    expect(arg).toMatchObject({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'bad-debt-probable:rn-1',
      amount: 8500,
    })
    expect(arg.tx).toBe(tx)

    const ev = rentNoticeEvents.record.mock.calls[0]!
    expect(ev[1]).toBe('NOTE_ADDED')
    expect(ev[4]).toMatchObject({
      action: 'bad-debt-probable',
      amount: 8500,
      journalEntryId: 'je-befarad',
    })
  })

  it('LOKALHYRA (vatAmount>0) VÄGRAS — momsåterkrav öppen revisorfråga', async () => {
    const { service, tx } = makeService({ notice: notice({ vatAmount: new Decimal(2000) }) })
    await expect(service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')).rejects.toThrow(
      /momspliktig|revisorfråga/,
    )
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('momspliktig FÖRBRUKNING (rad vatRate>0) VÄGRAS även om hyran är momsfri', async () => {
    const { service, tx } = makeService({
      notice: notice({ vatAmount: new Decimal(0), lines: [{ vatRate: 0 }, { vatRate: 25 }] }),
    })
    await expect(service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')).rejects.toThrow(
      /momspliktig|revisorfråga/,
    )
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('vägrar om avin inte är inkasso-redo', async () => {
    const { service } = makeService({ notice: notice({ collectionStage: 'REMINDED' }) })
    await expect(service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')).rejects.toThrow(
      /endast inkasso-redo/,
    )
  })

  it('idempotent: redan befarad → no-op', async () => {
    const { service, tx, accounting } = makeService({
      notice: notice({ probableLossAt: new Date() }),
    })
    const res = await service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')
    expect(res).toEqual({ booked: false })
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(accounting.bookBadDebtReclassification).not.toHaveBeenCalled()
  })

  it('race: claim count=0 → booked:false, ingen logg', async () => {
    const { service, rentNoticeEvents } = makeService({ claimCount: 0 })
    const res = await service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')
    expect(res).toEqual({ booked: false })
    expect(rentNoticeEvents.record).not.toHaveBeenCalled()
  })

  it('INV-A: bokföring null (saknat 1510/1515) → kastar, ingen markering består', async () => {
    const { service } = makeService({ reclassReturnsNull: true })
    await expect(service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')).rejects.toThrow()
  })

  it('org-scoping: avi i annan org (findFirst null) → NotFound', async () => {
    const { service, prisma } = makeService({ notice: null })
    await expect(service.reclassifyToProbableLoss('rn-1', 'org-1', 'u')).rejects.toThrow(
      /hittades inte/,
    )
    expect(prisma.rentNotice.findFirst.mock.calls[0]![0].where).toMatchObject({
      id: 'rn-1',
      organizationId: 'org-1',
    })
  })
})

describe('confirmLoss (konstaterad)', () => {
  function befarat(over: Record<string, unknown> = {}) {
    return notice({ probableLossAt: new Date('2026-06-22'), ...over })
  }

  it('bokför 6352/1515 atomiskt (belopp från befarad-verifikat) + flippar WRITTEN_OFF', async () => {
    const { service, tx, accounting, rentNoticeEvents } = makeService({ notice: befarat() })
    const res = await service.confirmLoss('rn-1', 'org-1', 'user-1')
    expect(res).toEqual({ booked: true })

    // Belopp läses ur befarad-verifikatets debetrad (1515) = 8500.
    const arg = accounting.bookBadDebtWriteOff.mock.calls[0]![0]
    expect(arg).toMatchObject({ sourceId: 'bad-debt-writeoff:rn-1', amount: 8500 })
    expect(arg.tx).toBe(tx)

    // Race-säker flip: claim på befarad-men-ej-avskriven (probableLossAt satt).
    const claim = tx.rentNotice.updateMany.mock.calls[0]![0]
    expect(claim.where).toMatchObject({ probableLossAt: { not: null }, writtenOffAt: null })
    expect(claim.data.collectionStage).toBe('WRITTEN_OFF')
    expect(claim.data.writtenOffAt).toBeInstanceOf(Date)

    const ev = rentNoticeEvents.record.mock.calls[0]!
    expect(ev[1]).toBe('WRITTEN_OFF')
    expect(ev[4]).toMatchObject({
      action: 'bad-debt-writeoff',
      amount: 8500,
      journalEntryId: 'je-konstaterad',
    })
  })

  it('kräver befarad först (ingen probableLossAt) → vägras', async () => {
    const { service } = makeService({ notice: notice({ probableLossAt: null }) })
    await expect(service.confirmLoss('rn-1', 'org-1', 'u')).rejects.toThrow(
      /befarad förlust.*innan/,
    )
  })

  it('LOKALHYRA (vatAmount>0) VÄGRAS även vid konstaterad', async () => {
    const { service } = makeService({ notice: befarat({ vatAmount: new Decimal(2000) }) })
    await expect(service.confirmLoss('rn-1', 'org-1', 'u')).rejects.toThrow(
      /momspliktig|revisorfråga/,
    )
  })

  it('idempotent: redan WRITTEN_OFF → no-op', async () => {
    const { service, tx, accounting } = makeService({
      notice: befarat({ collectionStage: 'WRITTEN_OFF' }),
    })
    const res = await service.confirmLoss('rn-1', 'org-1', 'u')
    expect(res).toEqual({ booked: false })
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(accounting.bookBadDebtWriteOff).not.toHaveBeenCalled()
  })

  it('INV-A: bokföring null (saknat 1515/6352) → kastar, ingen flip', async () => {
    const { service } = makeService({ notice: befarat(), writeOffReturnsNull: true })
    await expect(service.confirmLoss('rn-1', 'org-1', 'u')).rejects.toThrow()
  })
})

describe('reclassifyProbableLosses (cron)', () => {
  it('urvalet kräver RENT + INKASSO_READY + probableLossAt null + ej PAID/CANCELLED', async () => {
    const { service, prisma } = makeService()
    await service.reclassifyProbableLosses()
    const where = prisma.rentNotice.findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({
      type: 'RENT',
      collectionStage: 'INKASSO_READY',
      probableLossAt: null,
      status: { notIn: ['PAID', 'CANCELLED'] },
    })
  })

  it('momsfri omklassas; momspliktig (lokalhyra) räknas som manuell, ej omklassad', async () => {
    const { service, prisma } = makeService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      { id: 'rn-fri', organizationId: 'org-1', vatAmount: new Decimal(0) },
      { id: 'rn-lokal', organizationId: 'org-1', vatAmount: new Decimal(2500) },
    ])
    const spy = jest.spyOn(service, 'reclassifyToProbableLoss').mockResolvedValue({ booked: true })
    const summary = await service.reclassifyProbableLosses()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('rn-fri', 'org-1', null)
    expect(summary.reclassified).toBe(1)
    expect(summary.manual).toBe(1)
  })
})
