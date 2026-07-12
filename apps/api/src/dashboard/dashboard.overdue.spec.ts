/**
 * T4/#47 PR2 — DashboardService "Försenat belopp" (overdue.total).
 *
 * Låser skuld-sammansättningen:
 *   • Σ computeRentDebt(n).outstanding över OVERDUE-avier, KLAMPAD PER AVI innan
 *     summering (en överbetald avi bidrar 0, aldrig negativt — Σmax(0,x) ≠
 *     max(0,Σx)),
 *   • outstanding (det OBETALDA), inte totalAmount — delbetald avi räknar bara
 *     resten,
 *   • DEPOSIT exkluderas i queryn (where type≠DEPOSIT),
 *   • + OVERDUE Invoice.total (exkl. DEPOSIT), utan dubbelräkning,
 *   • allt org-scopat.
 */

import { DashboardService } from './dashboard.service'

function makeService(opts: {
  overdueNotices: Array<Record<string, unknown>>
  invoiceOverdueTotal: number
}) {
  const rentNoticeFindMany = jest.fn().mockResolvedValue(opts.overdueNotices)
  const prisma = {
    invoice: {
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { total: opts.invoiceOverdueTotal } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rentNotice: { findMany: rentNoticeFindMany },
    organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
    tenant: { groupBy: jest.fn().mockResolvedValue([]) },
    property: { count: jest.fn().mockResolvedValue(0) },
    lease: { groupBy: jest.fn().mockResolvedValue([]) },
  }
  const accounting = { getRevenueTotal: jest.fn().mockResolvedValue(0) }
  const service = new DashboardService(prisma as never, accounting as never)
  return { service, rentNoticeFindMany }
}

const RENT = (totalAmount: number, allocations: number[] = []) => ({
  type: 'RENT',
  totalAmount,
  consumptionAmount: 0,
  miscChargeAmount: 0,
  reminderFeeAmount: 0,
  interestAccruedAmount: 0,
  payments: allocations.map((amount) => ({ amount })),
})

describe('DashboardService "Försenat belopp"', () => {
  it('summerar outstanding per avi, klampar PER AVI, plus OVERDUE Invoice', async () => {
    const { service } = makeService({
      overdueNotices: [
        RENT(10000), //           obetald            → 10000
        RENT(10000, [4000]), //   delbetald          → 6000 (bara resten)
        RENT(10000, [12000]), //  ÖVERbetald (−2000) → 0 (klampad, ej negativ)
      ],
      invoiceOverdueTotal: 5000, // OVERDUE Invoice
    })

    const stats = await service.getStats('org-1')

    // Per-avi-klampning: 10000 + 6000 + 0 + 5000 = 21000.
    // (Klampning av SUMMAN i stället hade gett (10000+6000−2000)+5000 = 19000.)
    expect(stats.overdue.total).toBe(21000)
  })

  it('delbetald avi räknar bara resten (outstanding, inte totalAmount)', async () => {
    const { service } = makeService({
      overdueNotices: [RENT(8000, [3000])],
      invoiceOverdueTotal: 0,
    })
    expect((await service.getStats('org-1')).overdue.total).toBe(5000)
  })

  it('betald/överbetald avi bidrar 0, inte negativt', async () => {
    const { service } = makeService({
      overdueNotices: [RENT(5000, [5000]), RENT(5000, [9000])],
      invoiceOverdueTotal: 0,
    })
    expect((await service.getStats('org-1')).overdue.total).toBe(0)
  })

  it('queryn exkluderar DEPOSIT och är org-scopad (ingen läcka)', async () => {
    const { service, rentNoticeFindMany } = makeService({
      overdueNotices: [],
      invoiceOverdueTotal: 0,
    })
    await service.getStats('org-XYZ')
    const where = rentNoticeFindMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      organizationId: 'org-XYZ',
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })
  })

  it('ingen avi + ingen faktura → 0', async () => {
    const { service } = makeService({ overdueNotices: [], invoiceOverdueTotal: 0 })
    expect((await service.getStats('org-1')).overdue.total).toBe(0)
  })
})
