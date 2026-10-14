jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AccountingService } from '../accounting/accounting.service'
import { MonthlyReportService } from './monthly-report.service'

function rig(owner = 'EVENO') {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Syntetisk A',
        city: 'Provstad',
        street: 'Provgatan',
        postalCode: '11111',
        logoStorageKey: null,
        ledgerOwner: owner,
        fiscalYearStartMonth: 1,
      }),
    },
    journalEntryLine: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { credit: 120000, debit: 0 } }),
    },
    property: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'P-A', name: 'Provfastighet', units: [{ status: 'OCCUPIED' }] }]),
    },
    invoice: {
      groupBy: jest.fn().mockResolvedValue([
        { type: 'OTHER', _sum: { total: 20000 } },
        { type: 'DEPOSIT', _sum: { total: 15000 } },
      ]),
      findMany: jest
        .fn()
        .mockImplementation(async (args: { where: { leaseId?: unknown } }) =>
          args.where.leaseId ? [{ total: 35000, lease: { unit: { propertyId: 'P-A' } } }] : [],
        ),
    },
    unit: { groupBy: jest.fn().mockResolvedValue([{ status: 'OCCUPIED', _count: { id: 1 } }]) },
    maintenanceTicket: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    lease: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const overdue = {
    getOverdueSnapshot: jest.fn().mockResolvedValue({ total: 9500, count: 2, over30Count: 1 }),
  }
  const accounting = new AccountingService(prisma as never, {} as never)
  const ai = { generateMonthlyInsights: jest.fn().mockResolvedValue('') }
  const pdf = { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('synthetic-pdf-stub')) }
  const service = new MonthlyReportService(
    prisma as never,
    {} as never,
    {} as never,
    overdue as never,
  )
  Object.assign(service, {
    accounting,
    ai,
    pdf,
    dashboard: {
      getTimeseries: jest.fn().mockResolvedValue(
        Array.from({ length: 14 }, (_, i) => ({
          month: new Date(Date.UTC(2025, 8 + i, 1)).toISOString().slice(0, 7),
          revenue: 35000,
          paidRevenue: 17000,
          occupancy: 100,
          newLeases: 0,
          terminatedLeases: 0,
        })),
      ),
    },
  })
  return { service, prisma, ai, pdf, accounting }
}

describe('R02: verklig månadsservice → AI-underlag och HTML-mall (inga externa anrop)', () => {
  it('bokförd120000, Invoice35000 och deposition15000 behåller skilda mått', async () => {
    const { service, ai, pdf, accounting } = rig()
    const reads = jest.spyOn(accounting, 'getBookedRevenueReport')
    const result = await service.generatePdf('O-A')
    expect(result).not.toBeNull()
    expect(result!.data.summary.revenue.current).toMatchObject({
      status: 'KNOWN',
      amountOre: 12000000,
      scope: { organizationId: 'O-A', period: { from: '2026-09-01', to: '2026-09-30' } },
    })
    expect(result!.data.kpis.invoiceStatistics).toMatchObject({ total: 35000, deposit: 15000 })
    expect(result!.data.properties[0]).toMatchObject({ propertyId: 'P-A', invoiceTotal: 35000 })
    expect(result!.data.summary.overdue.totalAmount).toBe(9500)
    expect(result!.data.summary.revenue.prevMonthPct).toBe(0)
    expect(
      reads.mock.calls.map((c) => [
        c[1].toISOString().slice(0, 10),
        c[2].toISOString().slice(0, 10),
      ]),
    ).toEqual([
      ['2026-09-01', '2026-09-30'],
      ['2026-08-01', '2026-08-31'],
      ['2025-09-01', '2025-09-30'],
    ])
    const prompt = ai.generateMonthlyInsights.mock.calls[0][1] as string
    expect(prompt).toMatch(/Bokförd intäkt: 120\s000/)
    expect(prompt).toContain(
      'Invoice-urvalet: 35000 kr, inklusive deposition; hyresavier ingår inte',
    )
    expect(prompt).toContain('deposition 15000')
    expect(prompt).toContain('inte verifierat bankinflöde')
    const html = pdf.generateFromHtml.mock.calls[0][0] as string
    expect(html).toContain('Bokförd intäkt')
    expect(html).toMatch(/120\s000/)
    expect(html).toContain('Invoice')
    expect(html).toContain('2026-09-01–2026-09-30')
  })
  it.each(['FORTNOX', 'UNKNOWN'])(
    '%s: saknad bokförd intäkt blir ej noll, fakturerat eller lokal fallback',
    async (owner) => {
      const { service, prisma, ai, pdf } = rig(owner)
      const result = await service.generatePdf('O-A')
      expect(result!.data.summary.revenue.current.status).toBe('NOT_DETERMINABLE')
      expect(result!.data.summary.revenue.current).not.toHaveProperty('amountOre')
      expect(result!.data.summary.revenue.prevMonthPct).toBeNull()
      expect(result!.data.summary.revenue.prevYearPct).toBeNull()
      expect(result!.data.kpis.invoiceStatistics.total).toBe(35000)
      expect(result!.data.summary.overdue.totalAmount).toBe(9500)
      expect(prisma.journalEntryLine.aggregate).not.toHaveBeenCalled()
      const prompt = ai.generateMonthlyInsights.mock.calls[0][1] as string
      expect(prompt).toContain('kan inte fastställas')
      expect(prompt).not.toMatch(/Bokförd intäkt: (0|35000|135000|120000)/)
      const html = pdf.generateFromHtml.mock.calls[0][0] as string
      expect(html).toContain('Ej fastställbar')
      expect(html).not.toMatch(/120\s000/)
    },
  )
})
