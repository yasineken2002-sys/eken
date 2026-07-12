/**
 * T4 / #47 PR1 — AccountingService.getRevenueTotal (dashboardens "Totala
 * intäkter", accrual).
 *
 * Låser query-formen som gör siffran korrekt:
 *   • läser huvudboken (JournalEntryLine) via EN aggregate, inte Invoice/RentNotice,
 *   • kontospann [3000,4000) → intäktsklassen (DEPOSIT/2890 exkluderas strukturellt),
 *   • DUBBELT org-scopat (account.organizationId + journalEntry.organizationId),
 *   • periodfiltret date gte/lte,
 *   • intäkt = credit − debit, avrundat till två decimaler.
 */

import { AccountingService } from './accounting.service'

function makeService(sum: { debit: number | null; credit: number | null }) {
  const aggregate = jest.fn().mockResolvedValue({ _sum: sum })
  const prisma = { journalEntryLine: { aggregate } }
  const service = new AccountingService(prisma as never, {} as never)
  return { service, aggregate }
}

describe('AccountingService.getRevenueTotal', () => {
  const from = new Date(Date.UTC(2026, 0, 1))
  const to = new Date(Date.UTC(2026, 6, 12))

  it('summerar kontoklass 3 som credit − debit, dubbelt org-scopat, i perioden', async () => {
    const { service, aggregate } = makeService({ credit: 120000, debit: 500 })

    const total = await service.getRevenueTotal('org-1', from, to)

    expect(total).toBe(119500)
    expect(aggregate).toHaveBeenCalledTimes(1)
    const arg = aggregate.mock.calls[0][0]
    // Intäktsklassen — depositioner (2890) faller utanför spannet.
    expect(arg.where.account).toEqual({
      organizationId: 'org-1',
      number: { gte: 3000, lt: 4000 },
    })
    // Andra org-scope-ledet + periodfiltret på verifikatet.
    expect(arg.where.journalEntry).toEqual({
      organizationId: 'org-1',
      date: { gte: from, lte: to },
    })
    expect(arg._sum).toEqual({ debit: true, credit: true })
  })

  it('returnerar 0 när perioden saknar intäktsrader (null-summor)', async () => {
    const { service } = makeService({ credit: null, debit: null })
    expect(await service.getRevenueTotal('org-1', from, to)).toBe(0)
  })

  it('avrundar till två decimaler (ingen float-brus)', async () => {
    const { service } = makeService({ credit: 100.1, debit: 0.2 })
    expect(await service.getRevenueTotal('org-1', from, to)).toBe(99.9)
  })
})
