/**
 * T4/#47 PR2 + harmonisering — DashboardService "Försenat belopp" (overdue.total).
 *
 * Skuld-summeringens REGLER (klampa-per-avi, outstanding, DEPOSIT-exkl, ingen
 * dubbelräkning) testas i overdue-debt.service.spec.ts — den delade
 * sanningskällan. Här verifieras bara att getStats EXPONERAR den delade
 * tjänstens total oförändrat (ingen regression, samma tal som månadsrapporten).
 */

import { DashboardService } from './dashboard.service'

function makeService(overdueTotal: number) {
  const prisma = {
    invoice: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
    tenant: { groupBy: jest.fn().mockResolvedValue([]) },
    property: { count: jest.fn().mockResolvedValue(0) },
    lease: { groupBy: jest.fn().mockResolvedValue([]) },
  }
  const accounting = { getRevenueTotal: jest.fn().mockResolvedValue(0) }
  const overdue = {
    getOverdueSnapshot: jest
      .fn()
      .mockResolvedValue({ total: overdueTotal, count: 2, over30Count: 1 }),
  }
  const service = new DashboardService(prisma as never, accounting as never, overdue as never)
  return { service, overdue }
}

describe('DashboardService "Försenat belopp" (delad källa)', () => {
  it('exponerar OverdueDebtService.total oförändrat, org-scopat', async () => {
    const { service, overdue } = makeService(21000)
    const stats = await service.getStats('org-1')
    expect(stats.overdue.total).toBe(21000)
    expect(overdue.getOverdueSnapshot).toHaveBeenCalledWith('org-1', expect.any(Date))
  })

  it('0 skuld → overdue.total 0', async () => {
    const { service } = makeService(0)
    expect((await service.getStats('org-1')).overdue.total).toBe(0)
  })
})
