/**
 * #325 — EN SANNINGSKÄLLA, MÄTT ÖVER YTORNA.
 *
 * `overdue-debt.service.spec.ts` bevisar att RÄKNINGEN är rätt. Den här filen
 * bevisar något annat: att de ytor som rapporterar siffran till en människa
 * visar SAMMA tal, och att talet är restskulden.
 *
 * Varför det behöver mätas separat: varje konsument stubbar `OverdueDebtService`
 * i sin egen spec (dashboard.overdue.spec.ts, data-context.overdue.spec.ts,
 * portfolio-analysis.overdue.spec.ts). De testerna kan alla vara gröna medan
 * ytorna ändå visar olika tal, eftersom ingen av dem kör den RIKTIGA tjänsten.
 * Här körs den riktiga tjänsten över ETT prisma-underlag och matas till
 * konsumenterna — divergerar någon yta faller filen.
 *
 * UNDERLAGET är ärendets fall: en faktura på 10 000 kr med 9 000 kr allokerat,
 * status OVERDUE (nåbar via PATCH /invoices/:id/status, kanten PARTIAL →
 * OVERDUE). Rätt svar är 1 000 kr på varje yta. Före #325 sa de 10 000.
 */

// MonthlyReportService drar in StorageService → @aws-sdk/client-s3, som är ESM
// och inte transformeras av jest-konfigen. Rapporten rör aldrig lagringen i det
// här testet (logoStorageKey är null), så modulen attrappas vid gränsen.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { OverdueDebtService } from './overdue-debt.service'
import { DashboardService } from '../dashboard/dashboard.service'
import { DataContextService } from '../ai/data-context.service'
import { PortfolioAnalysisService } from '../ai/portfolio-analysis.service'
import { MonthlyReportService } from '../notifications/monthly-report.service'

const FAKTURERAT = 10000
const ALLOKERAT = 9000
const RESTSKULD = FAKTURERAT - ALLOKERAT // 1000

/** Den RIKTIGA tjänsten över ärendets underlag — ingen stubbad snapshot. */
function realOverdueService() {
  const prisma = {
    rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: {
      findMany: jest.fn().mockResolvedValue([
        {
          total: FAKTURERAT,
          dueDate: new Date(Date.now() - 5 * 86_400_000),
          payments: [{ amount: ALLOKERAT }],
        },
      ]),
    },
  }
  return new OverdueDebtService(prisma as never)
}

describe('#325 · alla ytor visar SAMMA tal, och talet är restskulden', () => {
  it('den delade tjänsten räknar restskulden — utgångspunkten för resten', async () => {
    const snap = await realOverdueService().getOverdueSnapshot('org-1')
    expect(snap.total).toBe(RESTSKULD)
    // NEGATIVKONTROLL: underlaget MÅSTE kunna skilja rätt från fel. Vore
    // fakturan obetald hade båda värdena varit 10 000 och hela filen bevisat
    // ingenting.
    expect(snap.total).not.toBe(FAKTURERAT)
  })

  it('DASHBOARD ("Försenat belopp") visar restskulden', async () => {
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
    const service = new DashboardService(
      prisma as never,
      { getRevenueTotal: jest.fn().mockResolvedValue(0) } as never,
      realOverdueService() as never,
    )

    const stats = await service.getStats('org-1')
    expect(stats.overdue.total).toBe(RESTSKULD)
    expect(stats.overdue.total).not.toBe(FAKTURERAT)
  })

  it('AI-DATAKONTEXT ("Förfallen skuld") visar restskulden', async () => {
    const arr = () => jest.fn().mockResolvedValue([])
    const num = () => jest.fn().mockResolvedValue(0)
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Org A', city: 'Stad' }) },
      property: { count: num(), findMany: arr() },
      unit: { groupBy: jest.fn().mockResolvedValue([]) },
      tenant: { count: num(), findMany: arr() },
      lease: { count: num(), findMany: arr() },
      invoice: { groupBy: arr(), findMany: arr() },
    }
    const service = new DataContextService(
      prisma as never,
      realOverdueService() as never,
      {
        getRevenueYearToDate: jest
          .fn()
          .mockResolvedValue({ total: 0, from: new Date(), to: new Date() }),
      } as never,
    )

    const ctx = await service.buildContext('org-1')
    // Formatteringen är svensk (1 000), så mät på siffergrupperna snarare än
    // på en rå `1000`-sträng.
    const skuldrad = ctx.split('\n').find((l) => l.startsWith('Förfallen skuld:'))
    expect(skuldrad).toBeDefined()
    expect(skuldrad).toMatch(/1[\s ]?000/)
    expect(skuldrad).not.toMatch(/10[\s ]?000/)
  })

  it('MÅNADSRAPPORT ("Förfallen skuld just nu") visar restskulden — samma tal som dashboarden', async () => {
    const arr = () => jest.fn().mockResolvedValue([])
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Org A',
          orgNumber: '556000-0001',
          street: 'Gatan 1',
          city: 'Stad',
          postalCode: '11111',
          invoiceColor: null,
          brandSecondaryColor: null,
          brandFont: null,
          logoStorageKey: null,
        }),
      },
      // Minst en fastighet krävs — annars kortsluter buildReportData till null
      // ("tom org — skicka inte tom rapport") och testet hade mätt ingenting.
      property: {
        findMany: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Fastighet', units: [] }]),
      },
      invoice: { groupBy: arr(), findMany: arr() },
      unit: { groupBy: arr() },
      maintenanceTicket: { groupBy: arr(), count: jest.fn().mockResolvedValue(0), findMany: arr() },
      lease: { findMany: arr() },
    }

    const service = new MonthlyReportService(
      prisma as never,
      {} as never, // moduleRef — onModuleInit körs inte; fälten sätts nedan
      {} as never, // storage — logoStorageKey är null, ingen hämtning sker
      realOverdueService() as never,
    )
    // onModuleInit resolvar normalt dessa via ModuleRef; här räcker
    // getTimeseries, som är allt buildReportData rör.
    ;(service as unknown as { dashboard: unknown }).dashboard = {
      getTimeseries: jest.fn().mockResolvedValue(
        Array.from({ length: 14 }, (_, i) => ({
          month: `2025-${String(i + 1).padStart(2, '0')}`,
          revenue: 0,
          occupancy: 0,
        })),
      ),
    }

    const data = await (
      service as unknown as {
        buildReportData: (orgId: string) => Promise<{
          summary: { overdue: { count: number; totalAmount: number; over30Count: number } }
        } | null>
      }
    ).buildReportData('org-1')

    expect(data).not.toBeNull()
    expect(data?.summary.overdue.totalAmount).toBe(RESTSKULD)
    expect(data?.summary.overdue.totalAmount).not.toBe(FAKTURERAT)

    // KÄRNPÅSTÅENDET: månadsrapporten och dashboarden visar SAMMA tal. Båda
    // härleds ur samma tjänst över samma underlag — divergerar de faller detta.
    const dashboardPrisma = {
      invoice: { groupBy: arr(), findMany: arr() },
      organization: { findUnique: jest.fn().mockResolvedValue({ fiscalYearStartMonth: 1 }) },
      tenant: { groupBy: arr() },
      property: { count: jest.fn().mockResolvedValue(0) },
      lease: { groupBy: arr() },
    }
    const dashboardStats = await new DashboardService(
      dashboardPrisma as never,
      { getRevenueTotal: jest.fn().mockResolvedValue(0) } as never,
      realOverdueService() as never,
    ).getStats('org-1')

    expect(data?.summary.overdue.totalAmount).toBe(dashboardStats.overdue.total)
  })

  it('AI-PORTFÖLJANALYS ("Förfallen skuld totalt") visar restskulden', async () => {
    const arr = () => jest.fn().mockResolvedValue([])
    const prisma = {
      invoice: { count: jest.fn().mockResolvedValue(0), findMany: arr() },
      unit: { findMany: arr() },
      lease: { findMany: arr() },
    }
    const service = new PortfolioAnalysisService(
      prisma as never,
      {} as never, // usage — ej rörd i fetchData
      {} as never, // quota — ej rörd i fetchData
      realOverdueService() as never,
      {
        getRevenueYearToDate: jest
          .fn()
          .mockResolvedValue({ total: 0, from: new Date(), to: new Date() }),
      } as never,
    )

    // Privata `fetchData` renderar siffran; anropa den direkt så testet inte
    // behöver en Anthropic-nyckel (samma grepp som portfolio-analysis.overdue.spec).
    const now = new Date()
    const text = await (
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
    ).fetchData('org-1', 'full', now, now, now, now)

    // Båda renderingarna (revenue-sektionen och risks-sektionen) bär samma tal.
    expect(text).toContain(
      `Förfallen skuld (nuläge, hyresavier + fakturor, exkl. deposition): ${RESTSKULD.toFixed(2)} SEK (1 poster)`,
    )
    expect(text).toContain(
      `Förfallen skuld totalt (hyresavier + fakturor, exkl. deposition): ${RESTSKULD.toFixed(2)} SEK`,
    )
    expect(text).not.toContain(`${FAKTURERAT.toFixed(2)} SEK`)
  })
})
