/**
 * T4/#47 — Portföljanalysens revenue-sektion rapporterar nu BOKFÖRD intäkt
 * (Σ 3xxx accrual via delade AccountingService.getRevenueYearToDate = samma tal
 * som dashboarden), i stället för sin gamla kassa-blinda Σ Invoice PAID (missade
 * all RentNotice-betalning). Bevisar via privata fetchData (ingen Anthropic).
 */

import { PortfolioAnalysisService } from './portfolio-analysis.service'

const twelveMonthsAgo = new Date('2025-07-01T00:00:00Z')
const now = new Date('2026-07-01T00:00:00Z')
const sixtyDaysFromNow = new Date('2026-08-30T00:00:00Z')
const thirtyDaysFromNow = new Date('2026-07-31T00:00:00Z')

function makePrisma() {
  return {
    invoice: {
      // Gamla revenue-sektionen läste invoice.findMany (PAID-summa). Nya läser
      // bara invoice.count för antalet. Ett PAID-fält här skulle synas i gamla
      // "Totalt betalt" (5000) men får INTE längre presenteras som intäkt.
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(7),
    },
    unit: { findMany: jest.fn().mockResolvedValue([]) },
    lease: { findMany: jest.fn().mockResolvedValue([]) },
  }
}

function makeService(getRevenueYearToDate: jest.Mock) {
  const prisma = makePrisma()
  const service = new PortfolioAnalysisService(
    prisma as never,
    {} as never, // usage
    {} as never, // quota
    {
      getOverdueSnapshot: jest.fn().mockResolvedValue({ total: 0, count: 0, over30Count: 0 }),
    } as never,
    { getRevenueYearToDate } as never,
  )
  return { service, prisma }
}

describe('PortfolioAnalysisService — bokförd intäkt via delade getRevenueYearToDate', () => {
  it('revenue-analys: rapporterar accrual-intäkten, inte kassa-blinda Σ Invoice PAID', async () => {
    const getRevenueYearToDate = jest
      .fn()
      .mockResolvedValue({ total: 250000, from: new Date(), to: now })
    const { service, prisma } = makeService(getRevenueYearToDate)

    const data = await (
      service as unknown as {
        fetchData: (o: string, t: string, n: Date, a: Date, b: Date, c: Date) => Promise<string>
      }
    ).fetchData('org-1', 'revenue', now, twelveMonthsAgo, sixtyDaysFromNow, thirtyDaysFromNow)

    // Accrual-intäkten (250000) märkt som samma som dashboarden.
    expect(data).toContain(
      'Bokförd intäkt (Σ 3xxx accrual, räkenskapsår-till-idag): 250000.00 SEK — samma som dashboardens "Totala intäkter"',
    )
    // Gamla kassa-blinda begrepp är borta.
    expect(data).not.toContain('Totalt betalt')
    expect(data).not.toContain('Månadsvis')
    // Antal fakturor läses via count (billigt), inte findMany.
    expect(data).toContain('Antal fakturor (senaste 12 mån): 7')
    expect(prisma.invoice.count).toHaveBeenCalled()

    // EN hämtning, org-scopad.
    expect(getRevenueYearToDate).toHaveBeenCalledTimes(1)
    expect(getRevenueYearToDate).toHaveBeenCalledWith('org-1', now)
  })

  it('occupancy-analys hämtar ingen bokförd intäkt (ingen onödig query)', async () => {
    const getRevenueYearToDate = jest.fn()
    const { service } = makeService(getRevenueYearToDate)
    await (
      service as unknown as {
        fetchData: (o: string, t: string, n: Date, a: Date, b: Date, c: Date) => Promise<string>
      }
    ).fetchData('org-1', 'occupancy', now, twelveMonthsAgo, sixtyDaysFromNow, thirtyDaysFromNow)
    expect(getRevenueYearToDate).not.toHaveBeenCalled()
  })
})
