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
  credits: [],
  payments: [],
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
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'rn-1' }]),
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
    { assertAutomaticEffectAllowed: jest.fn().mockResolvedValue(undefined) } as never,
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
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'rn-1' }]),
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
    { assertAutomaticEffectAllowed: jest.fn().mockResolvedValue(undefined) } as never,
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
        credits: [],
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

// Gränserna är svenska kalenderdagar även när UTC-datumet ännu är det gamla.
describe('kundtillgodo i räntebasen', () => {
  const payment = (amount: number, paidAt: string, source = 'CUSTOMER_CREDIT') => ({
    amount: new Decimal(amount),
    paidAt: new Date(paidAt),
    source,
  })

  it('25 kr tillgodo före förfall gör att en avi på 1000 kr bär ränta på 975 kr', async () => {
    const { service, rentNoticeEvents } = makeService({
      ratePercent: 2,
      notice: {
        ...baseNotice,
        totalAmount: new Decimal(1000),
        payments: [payment(25, '2026-04-30T12:00:00Z')],
      },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31'))
    expect(result).toMatchObject({ total: 8.01, delta: 8.01, days: 30 })
    expect(result?.segments).toEqual([expect.objectContaining({ base: 975, days: 30 })])
    expect(rentNoticeEvents.record.mock.calls[0]![4]).toMatchObject({
      base: 975,
      baseBeforeCustomerCredit: 1000,
    })
  })

  it('sent tillgodo ändrar bara räntedagar från betalningsdagen, aldrig de första 15 dagarna', async () => {
    const { service, accounting } = makeService({
      ratePercent: 2,
      notice: {
        ...baseNotice,
        interestAccruedAmount: new Decimal(32.88),
        payments: [payment(1000, '2026-05-17T12:00:00Z')],
      },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31'))
    expect(result).toMatchObject({ total: 61.64, delta: 28.76 })
    expect(result?.segments).toEqual([
      expect.objectContaining({ from: '2026-05-02', to: '2026-05-16', days: 15, base: 8000 }),
      expect.objectContaining({ from: '2026-05-17', to: '2026-05-31', days: 15, base: 7000 }),
    ])
    expect(accounting.bookInterest).toHaveBeenCalledWith(expect.objectContaining({ amount: 28.76 }))
  })

  it('använder svensk betalningsdag när UTC fortfarande visar föregående dag', async () => {
    const { service } = makeService({
      ratePercent: 2,
      notice: {
        ...baseNotice,
        payments: [payment(500, '2026-05-15T22:00:00Z')],
      },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31'))
    expect(result?.total).toBe(63.56)
    expect(result?.segments).toEqual([
      expect.objectContaining({ from: '2026-05-02', to: '2026-05-15', days: 14, base: 8000 }),
      expect.objectContaining({ from: '2026-05-16', to: '2026-05-31', days: 16, base: 7500 }),
    ])
  })

  it('flera lotter samma dag och halvårsskifte ger en sammanhängande specifikation', async () => {
    const { service } = makeSegmentService({
      rateFor: rateH1H2,
      notice: {
        ...baseNotice,
        totalAmount: new Decimal(1000),
        dueDate: new Date('2026-06-29T00:00:00Z'),
        payments: [
          payment(100, '2026-07-02T10:00:00Z'),
          payment(100, '2026-07-01T10:00:00Z'),
          payment(100, '2026-07-02T12:00:00Z'),
          payment(500, '2026-07-04T12:00:00Z'),
        ],
      },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-07-03'))
    expect(result).toMatchObject({ total: 0.97, days: 4 })
    expect(result?.segments).toEqual([
      expect.objectContaining({ from: '2026-06-30', to: '2026-06-30', days: 1, base: 1000 }),
      expect.objectContaining({ from: '2026-07-01', to: '2026-07-01', days: 1, base: 900 }),
      expect.objectContaining({ from: '2026-07-02', to: '2026-07-03', days: 2, base: 700 }),
    ])
    expect(result?.segments.reduce((sum, segment) => sum + segment.amount, 0)).toBeCloseTo(0.97, 2)
  })

  it('full täckning före förfall ger ingen ränta även om statuscachen ännu inte är PAID', async () => {
    const { service, accounting, tx } = makeService({
      ratePercent: 2,
      notice: {
        ...baseNotice,
        totalAmount: new Decimal(1000),
        payments: [payment(1000, '2026-04-30T12:00:00Z')],
      },
    })
    await expect(
      service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31')),
    ).resolves.toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
    expect(tx.rentNotice.update).not.toHaveBeenCalled()
  })

  it('bevarar tidigare räntedagar men klampar senare bas till noll vid full kapitaltäckning', async () => {
    const { service } = makeService({
      ratePercent: 2,
      notice: { ...baseNotice, payments: [payment(9000, '2026-05-17T12:00:00Z')] },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31'))
    expect(result?.total).toBe(32.88)
    expect(result?.segments).toEqual([
      expect.objectContaining({ days: 15, base: 8000 }),
      expect.objectContaining({ days: 15, base: 0, amount: 0 }),
    ])
  })

  it('lägger ingen avrundningsrest på dagar där tillgodo redan täcker hela kapitalet', async () => {
    const { service } = makeSegmentService({
      rateFor: rateH1H2,
      notice: {
        ...baseNotice,
        totalAmount: new Decimal(1000),
        dueDate: new Date('2026-06-29T00:00:00Z'),
        payments: [payment(100, '2026-07-01T10:00:00Z'), payment(900, '2026-07-02T10:00:00Z')],
      },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-07-03'))
    expect(result?.total).toBe(0.55)
    expect(result?.segments).toEqual([
      expect.objectContaining({ base: 1000, amount: 0.27 }),
      expect.objectContaining({ base: 900, amount: 0.28 }),
      expect.objectContaining({ base: 0, amount: 0 }),
    ])
  })

  it('läser status efter avilåset så en full reglering under låsväntan stoppar räntan', async () => {
    const { service, tx, accounting } = makeService({ ratePercent: 2 })
    tx.$queryRaw.mockImplementation(async () => {
      tx.rentNotice.findFirst.mockResolvedValue({ ...baseNotice, status: 'PAID' })
      return [{ id: 'rn-1' }]
    })
    await expect(
      service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31')),
    ).resolves.toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })

  it('ändrar inte övriga betalningskällors befintliga räntepolicy', async () => {
    const { service } = makeService({
      ratePercent: 2,
      notice: {
        ...baseNotice,
        payments: [
          payment(1000, '2026-04-30T12:00:00Z', 'BANK_RECONCILIATION'),
          payment(1000, '2026-04-30T12:00:00Z', 'MANUAL'),
        ],
      },
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-31'))
    expect(result?.total).toBe(65.75)
    expect(result?.segments).toEqual([expect.objectContaining({ base: 8000, days: 30 })])
  })
})

describe('räntedagar i Europe/Stockholm', () => {
  it.each([
    ['2026-05-01T00:00:00Z', '2026-05-01T22:00:00Z', '2026-05-02'],
    ['2026-03-29T00:00:00Z', '2026-03-29T22:00:00Z', '2026-03-30'],
    ['2026-10-25T00:00:00Z', '2026-10-25T23:00:00Z', '2026-10-26'],
    ['2026-12-31T00:00:00Z', '2026-12-31T23:00:00Z', '2027-01-01'],
  ])('%s till %s är en räntedag', async (due, through, day) => {
    const { service, accounting } = makeService({
      notice: { ...baseNotice, dueDate: new Date(due) },
      ratePercent: 2,
    })
    const result = await service.crystallizeInterest('rn-1', 'org-1', new Date(through))
    expect(result?.days).toBe(1)
    expect(result?.segments).toEqual([expect.objectContaining({ from: day, to: day, days: 1 })])
    expect(accounting.bookInterest).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: `interest:rn-1:${day}` }),
    )
  })

  it('ingen ränta under förfallodagen, även när datumet sparats som svensk midnatt', async () => {
    const { service, accounting } = makeService({
      notice: { ...baseNotice, dueDate: new Date('2026-04-30T22:00:00Z') },
      ratePercent: 2,
    })
    expect(
      await service.crystallizeInterest('rn-1', 'org-1', new Date('2026-05-01T21:59:59Z')),
    ).toBeNull()
    expect(accounting.bookInterest).not.toHaveBeenCalled()
  })
})
