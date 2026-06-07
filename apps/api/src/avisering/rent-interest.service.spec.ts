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

// Variant där referensräntan beror på det FRÅGADE datumet (effectiveFrom.lte) —
// så ett dröjsmål över en halvårsgräns får olika ränta per segment.
function makeSegmentService(opts: {
  notice: Record<string, unknown>
  rateFor: (lte: Date) => number | null
  bookReturns?: { id: string } | null
}) {
  const tx = {
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(opts.notice),
      update: jest.fn().mockResolvedValue({}),
    },
    referenceInterestRate: {
      findFirst: jest
        .fn()
        .mockImplementation((args: { where: { effectiveFrom: { lte: Date } } }) => {
          const r = opts.rateFor(args.where.effectiveFrom.lte)
          return Promise.resolve(r == null ? null : { ratePercent: new Decimal(r) })
        }),
    },
    journalEntry: { findFirst: jest.fn().mockResolvedValue(null) },
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

// H1 2026 = 2 % (effektiv 10), H2 2026 = 3 % (effektiv 11). Gräns 1 jul 2026.
const rateH1H2 = (lte: Date): number => (lte.getTime() >= Date.UTC(2026, 6, 1) ? 3 : 2)

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

  // ── Inkasso PR 4a — period-uppdelad ränta vid halvårsskifte ───────────────

  it('dröjsmål över 1 jul → summan av två segment med respektive halvårs ränta', async () => {
    // Förfaller 2026-06-15, ränta t.o.m. 2026-07-15 → 30 dagar = 15 (H1) + 15 (H2).
    // Seg1: 8000 × 0,10 × 15/365 = 32,88. Seg2: 8000 × 0,11 × 15/365 = 36,16.
    // Total = round2(32,8767 + 36,1644) = 69,04.
    const { service, accounting, tx, rentNoticeEvents } = makeSegmentService({
      notice: { ...baseNotice, dueDate: new Date('2026-06-15T00:00:00.000Z') },
      rateFor: rateH1H2,
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-07-15T00:00:00.000Z'),
    )

    expect(result?.days).toBe(30)
    expect(result?.total).toBe(69.04)
    expect(result?.delta).toBe(69.04)
    // Dagviktad effektiv ränta = (10×15 + 11×15) / 30 = 10,5.
    expect(result?.effectiveRatePercent).toBeCloseTo(10.5, 2)

    expect(result?.segments).toHaveLength(2)
    expect(result?.segments[0]).toMatchObject({
      from: '2026-06-16',
      to: '2026-06-30',
      days: 15,
      referenceRatePercent: 2,
      effectiveRatePercent: 10,
      amount: 32.88,
    })
    expect(result?.segments[1]).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-15',
      days: 15,
      referenceRatePercent: 3,
      effectiveRatePercent: 11,
      amount: 36.16,
    })

    // Bokför summan (delta mot 0). INV-A: samma tx som markeringen.
    expect(accounting.bookInterest.mock.calls[0]![0].amount).toBe(69.04)
    expect(Number(tx.rentNotice.update.mock.calls[0]![0].data.interestAccruedAmount)).toBe(69.04)
    // Segment-uppdelningen följer med i eventet (PR 4b:s export läser den).
    expect(rentNoticeEvents.record.mock.calls[0]![4].segments).toHaveLength(2)
    // Σ segment.amount === total EXAKT (ingen 1-öresdrift mot bokfört belopp).
    const segSum = result!.segments.reduce((s, seg) => s + seg.amount, 0)
    expect(Math.round(segSum * 100) / 100).toBe(result!.total)
  })

  it('dröjsmål inom ETT halvår → exakt ETT segment (ingen tom delperiod)', async () => {
    // Förfaller 2026-06-20, ränta t.o.m. 2026-06-30 → 10 dagar, helt inom H1.
    const { service } = makeSegmentService({
      notice: { ...baseNotice, dueDate: new Date('2026-06-20T00:00:00.000Z') },
      rateFor: rateH1H2,
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-06-30T00:00:00.000Z'),
    )
    expect(result?.days).toBe(10)
    expect(result?.segments).toHaveLength(1)
    expect(result?.segments[0]).toMatchObject({ from: '2026-06-21', to: '2026-06-30', days: 10 })
  })

  it('ett segment inom ETT halvår är IDENTISKT med PR 3 (ingen avrundningsdrift)', async () => {
    // Samma indata som baslinjetestet (förfaller 2026-05-01, t.o.m. 2026-05-31,
    // ränta 2 %) → 65,75. Segmenteringen får inte ändra ett halvårsinternt dröjsmål.
    const { service, accounting } = makeSegmentService({
      notice: { ...baseNotice },
      rateFor: () => 2,
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-31T00:00:00.000Z'),
    )
    expect(result?.total).toBe(65.75)
    expect(result?.segments).toHaveLength(1)
    expect(accounting.bookInterest.mock.calls[0]![0].amount).toBe(65.75)
  })

  it('idempotent: delta=0 vid omkörning (redan bokförd total) → null, ingen bokföring', async () => {
    // interestAccruedAmount = exakt den total som beräknas → delta 0.
    const { service, accounting } = makeService({
      ratePercent: 2,
      notice: { ...baseNotice, interestAccruedAmount: new Decimal(65.75) },
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-05-31T00:00:00.000Z'),
    )
    expect(result).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })

  it('saknad referensränta för NÅGOT segment → null, ingen gissad ränta', async () => {
    // H1 har ränta, H2 saknar rad → hela kravet uteblir (ett delvis räntekrav
    // är angripbart). Varken bokföring eller markering/event sker.
    const { service, accounting, tx, rentNoticeEvents } = makeSegmentService({
      notice: { ...baseNotice, dueDate: new Date('2026-06-15T00:00:00.000Z') },
      rateFor: (lte) => (lte.getTime() >= Date.UTC(2026, 6, 1) ? null : 2),
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-07-15T00:00:00.000Z'),
    )
    expect(result).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
    expect(tx.rentNotice.update).not.toHaveBeenCalled()
    expect(rentNoticeEvents.record).not.toHaveBeenCalled()
  })

  it('append-only: bokför bara FRAMÅT-deltat, ombokar aldrig historik', async () => {
    // 50 kr redan bokfört (under PR 3:s enkel-ankare). Ny total med segmentering
    // = 69,04 → ENDAST deltat 19,04 bokförs; markeringen sätts till nya totalen.
    // Ingen reversal, ingen andra post — historiken rörs inte (BFL append-only).
    const { service, accounting, tx } = makeSegmentService({
      notice: {
        ...baseNotice,
        dueDate: new Date('2026-06-15T00:00:00.000Z'),
        interestAccruedAmount: new Decimal(50),
      },
      rateFor: rateH1H2,
    })
    const result = await service.crystallizeInterest(
      'rn-1',
      'org-1',
      new Date('2026-07-15T00:00:00.000Z'),
    )
    expect(result?.delta).toBe(19.04)
    expect(result?.total).toBe(69.04)
    expect(accounting.bookInterest).toHaveBeenCalledTimes(1)
    expect(accounting.bookInterest.mock.calls[0]![0].amount).toBe(19.04)
    expect(Number(tx.rentNotice.update.mock.calls[0]![0].data.interestAccruedAmount)).toBe(69.04)
  })
})
