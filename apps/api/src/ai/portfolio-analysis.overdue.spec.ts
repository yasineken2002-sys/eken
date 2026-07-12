/**
 * T4/#47 — Portföljanalysens revenue-/risks-sektioner läser nu DELADE
 * OverdueDebtService för "Förfallen skuld" i stället för sin blinda Invoice-only-
 * OVERDUE-summa. Bevisar (via privata fetchData, ingen Anthropic-anrop):
 *   • revenue- och risks-sektionen rapporterar snapshotens tal,
 *   • det gamla "Totalt förfallet" (Invoice-only) är borta,
 *   • snapshoten hämtas EN gång och org-scopat,
 *   • occupancy-analys hämtar ingen skuld (ingen onödig query).
 */

import { PortfolioAnalysisService } from './portfolio-analysis.service'

const twelveMonthsAgo = new Date('2025-07-01T00:00:00Z')
const now = new Date('2026-07-01T00:00:00Z')
const sixtyDaysFromNow = new Date('2026-08-30T00:00:00Z')
const thirtyDaysFromNow = new Date('2026-07-31T00:00:00Z')

function makePrisma() {
  return {
    invoice: {
      findMany: jest.fn().mockImplementation((args: { where?: Record<string, unknown> }) => {
        // risks-sektionen: OVERDUE-fakturor (detaljlista)
        if (args?.where?.['status'] === 'OVERDUE') {
          return Promise.resolve([
            {
              invoiceNumber: 'F-1',
              total: 5000,
              dueDate: new Date('2026-05-01T00:00:00Z'),
              tenant: { firstName: 'A', lastName: 'B', companyName: null, email: 'a@b.se' },
              customer: null,
            },
          ])
        }
        // revenue-sektionen: 12-mån-fakturor (inkl. en OVERDUE med FEL blind-summa)
        return Promise.resolve([
          {
            status: 'PAID',
            total: 10000,
            issueDate: new Date('2026-06-01T00:00:00Z'),
            paidAt: new Date('2026-06-05T00:00:00Z'),
            tenant: null,
          },
          {
            status: 'OVERDUE',
            total: 5000,
            issueDate: new Date('2026-05-01T00:00:00Z'),
            paidAt: null,
            tenant: null,
          },
        ])
      }),
      count: jest.fn().mockResolvedValue(2),
    },
    unit: { findMany: jest.fn().mockResolvedValue([]) },
    lease: { findMany: jest.fn().mockResolvedValue([]) },
  }
}

function makeService(getOverdueSnapshot: jest.Mock) {
  const prisma = makePrisma()
  const service = new PortfolioAnalysisService(
    prisma as never,
    {} as never, // usage — ej rörd i fetchData
    {} as never, // quota — ej rörd i fetchData
    { getOverdueSnapshot } as never,
    {
      getRevenueYearToDate: jest
        .fn()
        .mockResolvedValue({ total: 0, from: new Date(), to: new Date() }),
    } as never, // accounting — bokförd intäkt (egen spec nedan täcker talet)
  )
  return { service, prisma }
}

describe('PortfolioAnalysisService — förfallen skuld via delade OverdueDebtService', () => {
  it('full-analys: revenue + risks rapporterar snapshoten, inte Invoice-only-talet', async () => {
    const getOverdueSnapshot = jest
      .fn()
      .mockResolvedValue({ total: 21000, count: 3, over30Count: 1 })
    const { service, prisma } = makeService(getOverdueSnapshot)

    const data = await (
      service as unknown as {
        fetchData: (
          orgId: string,
          type: string,
          now: Date,
          a: Date,
          b: Date,
          c: Date,
        ) => Promise<string>
      }
    ).fetchData('org-1', 'full', now, twelveMonthsAgo, sixtyDaysFromNow, thirtyDaysFromNow)

    // revenue: snapshotens total (21000), inte den blinda Invoice-only-summan (5000)
    expect(data).toContain(
      'Förfallen skuld (nuläge, hyresavier + fakturor, exkl. deposition): 21000.00 SEK (3 poster)',
    )
    // risks: samma snapshot-aggregat
    expect(data).toContain(
      'Förfallen skuld totalt (hyresavier + fakturor, exkl. deposition): 21000.00 SEK, 3 poster, varav 1 äldre än 30 dagar',
    )
    // Det gamla, felaktiga labelet är borta
    expect(data).not.toContain('Totalt förfallet:')
    // Detaljlistan finns kvar men tydligt märkt som Invoice-delmängd
    expect(data).toContain('Förfallna fakturaposter (urval, exkl. hyresavier och depositioner):')

    // Detaljlist-queryn exkluderar DEPOSIT symmetriskt med OverdueDebtService.
    const overdueDetailCall = (prisma.invoice.findMany as jest.Mock).mock.calls.find(
      (c: [{ where?: Record<string, unknown> }]) => c[0]?.where?.['status'] === 'OVERDUE',
    )
    expect(overdueDetailCall?.[0].where).toMatchObject({ type: { not: 'DEPOSIT' } })

    // EN hämtning, org-scopad
    expect(getOverdueSnapshot).toHaveBeenCalledTimes(1)
    expect(getOverdueSnapshot).toHaveBeenCalledWith('org-1', now)
  })

  it('occupancy-analys hämtar ingen förfallen skuld (ingen onödig query)', async () => {
    const getOverdueSnapshot = jest.fn()
    const { service } = makeService(getOverdueSnapshot)
    await (
      service as unknown as {
        fetchData: (o: string, t: string, n: Date, a: Date, b: Date, c: Date) => Promise<string>
      }
    ).fetchData('org-1', 'occupancy', now, twelveMonthsAgo, sixtyDaysFromNow, thirtyDaysFromNow)
    expect(getOverdueSnapshot).not.toHaveBeenCalled()
  })
})
