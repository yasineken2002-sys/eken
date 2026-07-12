/**
 * T4/#47 — OverdueDebtService: DELAD sanningskälla för "Försenat belopp"
 * (dashboard + månadsrapport). Låser samma regler som PR2:
 *   • Σ computeRentDebt(n).outstanding för OVERDUE-avier, KLAMPAT PER AVI
 *     (Σmax(0,x) ≠ max(0,Σx) — överbetald avi bidrar 0, aldrig negativt),
 *   • outstanding (det obetalda), inte totalAmount — delbetald → bara resten,
 *   • DEPOSIT exkluderas i queryn (where type≠DEPOSIT), org-scopat,
 *   • + OVERDUE Invoice.total (type≠DEPOSIT), utan dubbelräkning,
 *   • count räknar bara poster med kvarvarande skuld; over30Count via dueDate.
 */

import { OverdueDebtService } from './overdue-debt.service'

const DAY = 86_400_000

function makeService(opts: {
  notices: Array<Record<string, unknown>>
  invoices: Array<Record<string, unknown>>
}) {
  const rentNoticeFindMany = jest.fn().mockResolvedValue(opts.notices)
  const invoiceFindMany = jest.fn().mockResolvedValue(opts.invoices)
  const prisma = {
    rentNotice: { findMany: rentNoticeFindMany },
    invoice: { findMany: invoiceFindMany },
  }
  return { service: new OverdueDebtService(prisma as never), rentNoticeFindMany, invoiceFindMany }
}

// dueDate default: nyligen förfallen (ej >30 dagar) om inget anges.
const RENT = (totalAmount: number, allocations: number[] = [], daysOverdue = 5) => ({
  type: 'RENT',
  totalAmount,
  consumptionAmount: 0,
  miscChargeAmount: 0,
  reminderFeeAmount: 0,
  interestAccruedAmount: 0,
  dueDate: new Date(Date.now() - daysOverdue * DAY),
  payments: allocations.map((amount) => ({ amount })),
})
const INV = (total: number, daysOverdue = 5) => ({
  total,
  dueDate: new Date(Date.now() - daysOverdue * DAY),
})

describe('OverdueDebtService.getOverdueSnapshot', () => {
  const NOW = new Date()

  it('summerar outstanding per avi (klampat) + OVERDUE Invoice; räknar poster', async () => {
    const { service } = makeService({
      notices: [
        RENT(10000), //          obetald            → 10000
        RENT(10000, [4000]), //  delbetald          → 6000
        RENT(10000, [12000]), // ÖVERbetald (−2000) → 0 (klampad, räknas ej)
      ],
      invoices: [INV(5000)],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    // 10000 + 6000 + 0 + 5000 = 21000. (Klampning av SUMMAN → 19000.)
    expect(snap.total).toBe(21000)
    // Två avier med skuld (0-avin räknas ej) + en faktura = 3 poster.
    expect(snap.count).toBe(3)
  })

  it('delbetald avi räknar bara resten (outstanding, inte totalAmount)', async () => {
    const { service } = makeService({ notices: [RENT(8000, [3000])], invoices: [] })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.total).toBe(5000)
    expect(snap.count).toBe(1)
  })

  it('betald/överbetald avi bidrar 0 och räknas inte', async () => {
    const { service } = makeService({
      notices: [RENT(5000, [5000]), RENT(5000, [9000])],
      invoices: [],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.total).toBe(0)
    expect(snap.count).toBe(0)
  })

  it('over30Count räknar poster förfallna för mer än 30 dagar', async () => {
    const { service } = makeService({
      notices: [RENT(1000, [], 40), RENT(1000, [], 10)],
      invoices: [INV(1000, 45)],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.count).toBe(3)
    expect(snap.over30Count).toBe(2) // avin (40 d) + fakturan (45 d)
  })

  it('queryn exkluderar DEPOSIT och är org-scopad på båda källorna', async () => {
    const { service, rentNoticeFindMany, invoiceFindMany } = makeService({
      notices: [],
      invoices: [],
    })
    await service.getOverdueSnapshot('org-XYZ', NOW)
    expect(rentNoticeFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-XYZ',
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })
    expect(invoiceFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-XYZ',
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })
  })

  it('OVERDUE Invoice med total <= 0 höjer varken belopp eller count (symmetri med avi-loopen)', async () => {
    const { service } = makeService({
      notices: [],
      invoices: [INV(0), INV(3000)],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.total).toBe(3000)
    expect(snap.count).toBe(1) // 0-fakturan räknas inte
  })

  it('inga poster → nollad snapshot', async () => {
    const { service } = makeService({ notices: [], invoices: [] })
    expect(await service.getOverdueSnapshot('org-1', NOW)).toEqual({
      total: 0,
      count: 0,
      over30Count: 0,
    })
  })
})
