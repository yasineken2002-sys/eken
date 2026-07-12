/**
 * T4/#47 — getRevenueYearToDate: DELAD "bokförd intäkt räkenskapsår-till-idag"
 * (Σ 3xxx accrual) som AI-lagret och dashboarden ska rapportera identiskt.
 * Bevisar att räkenskapsår-till-idag-perioden beräknas med SAMMA formel som
 * DashboardService.fiscalYearToDate (default 1, UTC) och att summan = Σ 3xxx
 * credit−debit för den perioden.
 */

import { AccountingService } from './accounting.service'

function makeService(opts: {
  fiscalYearStartMonth?: number | null
  credit?: number
  debit?: number
}) {
  const aggregate = jest.fn().mockResolvedValue({
    _sum: { credit: opts.credit ?? 0, debit: opts.debit ?? 0 },
  })
  const organizationFindUnique = jest
    .fn()
    .mockResolvedValue(
      opts.fiscalYearStartMonth === null
        ? null
        : { fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1 },
    )
  const prisma = {
    organization: { findUnique: organizationFindUnique },
    journalEntryLine: { aggregate },
  }
  const service = new AccountingService(prisma as never, {} as never)
  return { service, aggregate }
}

describe('AccountingService.getRevenueYearToDate', () => {
  it('kalenderår (fiscalStart=1): från = 1 jan samma år, total = credit−debit', async () => {
    const { service, aggregate } = makeService({
      fiscalYearStartMonth: 1,
      credit: 250000,
      debit: 10000,
    })
    const now = new Date('2026-07-15T12:00:00Z')
    const res = await service.getRevenueYearToDate('org-1', now)

    expect(res.total).toBe(240000)
    expect(res.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(res.to).toBe(now)
    // Aggregatet grindar på [från, now] och kontospann 3xxx, dubbelt org-scopat.
    const where = aggregate.mock.calls[0][0].where
    expect(where.account).toMatchObject({
      organizationId: 'org-1',
      number: { gte: 3000, lt: 4000 },
    })
    expect(where.journalEntry.organizationId).toBe('org-1')
    expect(where.journalEntry.date.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(where.journalEntry.date.lte).toBe(now)
  })

  it('brutet räkenskapsår (fiscalStart=7), now i juli → från = 1 juli samma år', async () => {
    const { service } = makeService({ fiscalYearStartMonth: 7, credit: 100000 })
    const res = await service.getRevenueYearToDate('org-1', new Date('2026-07-15T00:00:00Z'))
    expect(res.from.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(res.total).toBe(100000)
  })

  it('brutet räkenskapsår (fiscalStart=7), now i mars → från = 1 juli FÖREGÅENDE år', async () => {
    const { service } = makeService({ fiscalYearStartMonth: 7 })
    const res = await service.getRevenueYearToDate('org-1', new Date('2026-03-15T00:00:00Z'))
    expect(res.from.toISOString()).toBe('2025-07-01T00:00:00.000Z')
  })

  it('org saknar fiscalYearStartMonth → default 1 (kalenderår)', async () => {
    const { service } = makeService({ fiscalYearStartMonth: null })
    const res = await service.getRevenueYearToDate('org-1', new Date('2026-05-10T00:00:00Z'))
    expect(res.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})
