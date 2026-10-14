jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class {
    messages = {
      create: () => {
        throw new Error('LiveAI förbjudet i detta prov')
      },
    }
  },
}))

/**
 * T4/#47 — Portföljanalysens revenue-sektion rapporterar nu BOKFÖRD intäkt
 * (Σ 3xxx accrual via delade AccountingService.getBookedRevenueYearToDate = samma tal
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

function makeService(getBookedRevenueYearToDate: jest.Mock) {
  const prisma = makePrisma()
  const service = new PortfolioAnalysisService(
    prisma as never,
    {} as never, // usage
    {} as never, // quota
    {
      getOverdueSnapshot: jest.fn().mockResolvedValue({ total: 0, count: 0, over30Count: 0 }),
    } as never,
    { getBookedRevenueYearToDate } as never,
  )
  return { service, prisma }
}

describe('PortfolioAnalysisService — bokförd intäkt via delade getBookedRevenueYearToDate', () => {
  it('revenue-analys: rapporterar accrual-intäkten, inte kassa-blinda Σ Invoice PAID', async () => {
    const getBookedRevenueYearToDate = jest.fn().mockResolvedValue({
      status: 'KNOWN',
      scope: {
        organizationId: 'org-1',
        metric: 'BOOKED_REVENUE',
        propertyId: null,
        period: { from: '2026-01-01', to: '2026-07-01' },
      },
      source: 'EVENO_LEDGER',
      accountSystem: 'EVENO',
      accountRange: [3000, 3999],
      definition: 'CREDIT_MINUS_DEBIT',
      currency: 'SEK',
      amountOre: 25000000,
      observedAt: '2026-07-01T08:00:00Z',
      completeness: 'COMPLETE',
    })
    const { service, prisma } = makeService(getBookedRevenueYearToDate)

    const data = await (
      service as unknown as {
        fetchData: (o: string, t: string, n: Date, a: Date, b: Date, c: Date) => Promise<string>
      }
    ).fetchData('org-1', 'revenue', now, twelveMonthsAgo, sixtyDaysFromNow, thirtyDaysFromNow)

    // Samma bokförda belopp (250000), nu med käll- och periodproveniens.
    expect(data).toContain(
      'Bokförd intäkt (Σ 3xxx accrual, räkenskapsår-till-idag): ' +
        new Intl.NumberFormat('sv-SE', {
          style: 'currency',
          currency: 'SEK',
          maximumFractionDigits: 0,
        }).format(250000),
    )
    // Gamla kassa-blinda begrepp är borta.
    expect(data).not.toContain('Totalt betalt')
    expect(data).not.toContain('Månadsvis')
    // Antal fakturor läses via count (billigt), inte findMany.
    expect(data).toContain('Antal fakturor (senaste 12 mån): 7')
    expect(prisma.invoice.count).toHaveBeenCalled()

    // EN hämtning, org-scopad.
    expect(getBookedRevenueYearToDate).toHaveBeenCalledTimes(1)
    expect(getBookedRevenueYearToDate).toHaveBeenCalledWith('org-1', now)
  })

  it('occupancy-analys hämtar ingen bokförd intäkt (ingen onödig query)', async () => {
    const getBookedRevenueYearToDate = jest.fn()
    const { service } = makeService(getBookedRevenueYearToDate)
    await (
      service as unknown as {
        fetchData: (o: string, t: string, n: Date, a: Date, b: Date, c: Date) => Promise<string>
      }
    ).fetchData('org-1', 'occupancy', now, twelveMonthsAgo, sixtyDaysFromNow, thirtyDaysFromNow)
    expect(getBookedRevenueYearToDate).not.toHaveBeenCalled()
  })
})
