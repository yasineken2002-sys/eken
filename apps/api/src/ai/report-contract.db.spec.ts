jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { OverdueDebtService } from '../overdue/overdue-debt.service'
import { MonthlyReportService } from '../notifications/monthly-report.service'
import { AiAuditService } from './audit/ai-audit.service'
import { ToolExecutorService } from './tools/tool-executor.service'
import { DataContextService } from './data-context.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
describe('rapportkontrakt i riktig syntetisk Postgres (inga hoppade fall)', () => {
  let prisma: PrismaService
  let accounting: AccountingService
  let org: string
  let other: string
  let user: string
  let property: string
  const orgs: string[] = []
  const sfx = randomUUID()
  const date = (s: string) => new Date(`${s}T00:00:00Z`)
  const from = date('2026-09-01')
  const to = date('2026-09-30')
  const audits: Promise<unknown>[] = []

  it('KANARIEFÅGEL: DATABASE_URL är satt och riktig DB krävs', () => {
    expect(HAR_DB).toBe(true)
  })
  beforeAll(async () => {
    if (!HAR_DB) throw new Error('Syntetisk DATABASE_URL krävs; detta prov får inte hoppas över')
    // Värdet loggas aldrig. Körledaren verifierar dessutom exakt egen DB/env före start.
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Provet kräver lokal syntetisk databas')
    prisma = new PrismaService()
    await prisma.$connect()
    accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
    async function organization(tag: string) {
      const o = await prisma.organization.create({
        data: {
          name: `Report190-${tag}-${sfx}`,
          email: `${tag}-${sfx}@example.invalid`,
          street: 'Provgatan',
          city: 'Provstad',
          postalCode: '11111',
          fiscalYearStartMonth: 7,
        },
      })
      orgs.push(o.id)
      await accounting.seedDefaultAccounts(o.id)
      return o.id
    }
    org = await organization('A')
    other = await organization('B')
    user = (
      await prisma.user.create({
        data: {
          organizationId: org,
          email: `u-${sfx}@example.invalid`,
          passwordHash: 'synthetic',
          firstName: 'Syn',
          lastName: 'Tetisk',
          role: 'OWNER',
        },
      })
    ).id
    property = (
      await prisma.property.create({
        data: {
          organizationId: org,
          name: 'P-A',
          propertyDesignation: sfx,
          type: 'RESIDENTIAL',
          street: 'Provgatan',
          city: 'Provstad',
          postalCode: '11111',
          totalArea: 100,
        },
      })
    ).id
    const unit = await prisma.unit.create({
      data: {
        propertyId: property,
        name: 'U-A',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 3000,
        status: 'OCCUPIED',
      },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: 'Prov',
        lastName: 'Hyresgäst',
        email: `t-${sfx}@example.invalid`,
      },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: org,
        unitId: unit.id,
        tenantId: tenant.id,
        startDate: date('2025-01-01'),
        tenancyStartDate: date('2025-01-01'),
        monthlyRent: 3000,
        depositAmount: 0,
        status: 'ACTIVE',
      },
    })
    // Hela avtalsaggregatet: 100 × 3000, trots detaljlistans tak30.
    const moreUnits = Array.from({ length: 99 }, (_, i) => ({
      id: randomUUID(),
      propertyId: property,
      name: `U-extra-${i}`,
      type: 'APARTMENT' as const,
      area: 50,
      monthlyRent: 3000,
      status: 'OCCUPIED' as const,
    }))
    await prisma.unit.createMany({ data: moreUnits })
    await prisma.lease.createMany({
      data: moreUnits.map((u) => ({
        organizationId: org,
        unitId: u.id,
        tenantId: tenant.id,
        startDate: date('2025-01-01'),
        tenancyStartDate: date('2025-01-01'),
        monthlyRent: 3000,
        depositAmount: 0,
        status: 'ACTIVE' as const,
      })),
    })
    await prisma.invoice.createMany({
      data: [
        {
          organizationId: org,
          tenantId: tenant.id,
          leaseId: lease.id,
          invoiceNumber: 'OTHER',
          type: 'OTHER',
          status: 'SENT',
          subtotal: 20000,
          vatTotal: 0,
          total: 20000,
          dueDate: date('2026-10-30'),
          issueDate: date('2026-09-15'),
        },
        {
          organizationId: org,
          tenantId: tenant.id,
          leaseId: lease.id,
          invoiceNumber: 'DEPOSIT',
          type: 'DEPOSIT',
          status: 'SENT',
          subtotal: 15000,
          vatTotal: 0,
          total: 15000,
          dueDate: date('2026-10-30'),
          issueDate: date('2026-09-15'),
        },
      ],
    })
    await prisma.rentNotice.create({
      data: {
        organizationId: org,
        tenantId: tenant.id,
        leaseId: lease.id,
        noticeNumber: 'RN-190',
        ocrNumber: sfx.replace(/-/g, ''),
        month: 9,
        year: 2026,
        amount: 100000,
        totalAmount: 100000,
        dueDate: date('2026-10-30'),
        status: 'SENT',
      },
    })
    async function journal(id: string, day: string, nr: number, revenue: number, deposit = 0) {
      const accounts = await prisma.account.findMany({
        where: { organizationId: id, number: { in: [1510, 3911, 2890] } },
      })
      const account = (n: number) => accounts.find((a) => a.number === n)!.id
      await prisma.journalEntry.create({
        data: {
          organizationId: id,
          date: date(day),
          description: 'Syntetisk rapportfixtur',
          source: 'MANUAL',
          series: 'A',
          verNumber: nr,
          fiscalYear: 2026,
          lines: {
            create: [
              { accountId: account(1510), debit: revenue + deposit },
              { accountId: account(3911), credit: revenue },
              ...(deposit ? [{ accountId: account(2890), credit: deposit }] : []),
            ],
          },
        },
      })
    }
    await journal(org, '2026-08-31', 1, 17)
    await journal(org, '2026-09-01', 2, 20000, 15000)
    await journal(org, '2026-09-30', 3, 100000)
    await journal(org, '2026-10-01', 4, 23)
    await journal(other, '2026-09-15', 1, 777777)
  }, 30000)
  afterEach(async () => {
    await Promise.all(audits.splice(0))
  })
  afterAll(async () => {
    if (!prisma) return
    for (const id of orgs) {
      await prisma.organization.update({
        where: { id },
        data: {
          ledgerOwner: 'EVENO',
          ledgerOwnerActivationId: null,
          ledgerOwnerFortnoxDatabaseNumber: null,
          ledgerOwnerFortnoxOrgNumber: null,
          ledgerOwnerSetAt: null,
          ledgerOwnerSetById: null,
        },
      })
      const where = { organizationId: id }
      await prisma.aiToolExecution.deleteMany({ where })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: where } })
      await prisma.journalEntry.deleteMany({ where })
      await prisma.invoice.deleteMany({ where })
      await prisma.rentNotice.deleteMany({ where })
      await prisma.fortnoxCustomerActivation.deleteMany({ where })
      await prisma.openingPackage.deleteMany({ where })
      await prisma.fortnoxConnection.deleteMany({ where })
      await prisma.lease.deleteMany({ where })
      await prisma.tenant.deleteMany({ where })
      await prisma.unit.deleteMany({ where: { property: where } })
      await prisma.property.deleteMany({ where })
      await prisma.account.deleteMany({ where })
      await prisma.user.deleteMany({ where })
      await prisma.organization.delete({ where: { id } })
    }
    await prisma.$disconnect()
  }, 30000)

  it('R02: bokförd120000 matchar resultatets intäkt; Invoice35000, hyresavi100000 och deposition räknas inte igen', async () => {
    const value = await accounting.getBookedRevenueReport(org, from, to)
    expect(value).toMatchObject({
      status: 'KNOWN',
      amountOre: 12000000,
      scope: { organizationId: org, period: { from: '2026-09-01', to: '2026-09-30' } },
    })
    const pl = await accounting.getProfitLossReport(org, '2026-09-01', '2026-09-30')
    expect(pl.revenue.total).toBe(120000)
    expect(await accounting.getBookedRevenueReport(other, from, to)).toMatchObject({
      amountOre: 77777700,
    })
    const month = new MonthlyReportService(
      prisma,
      {} as never,
      {} as never,
      new OverdueDebtService(prisma),
    )
    const ai = { generateMonthlyInsights: jest.fn().mockResolvedValue('') }
    Object.assign(month, {
      accounting,
      ai,
      pdf: { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('synthetic')) },
      dashboard: {
        getTimeseries: jest.fn().mockResolvedValue(
          Array.from({ length: 14 }, (_, i) => ({
            month: new Date(Date.UTC(2025, 8 + i, 1)).toISOString().slice(0, 7),
            revenue: 35000,
            paidRevenue: 0,
            occupancy: 100,
            newLeases: 0,
            terminatedLeases: 0,
          })),
        ),
      },
    })
    const report = await month.generatePdf(org)
    expect(report!.data.summary.revenue.current).toMatchObject({ amountOre: 12000000 })
    expect(report!.data.kpis.invoiceStatistics).toMatchObject({ total: 35000, deposit: 15000 })
    expect(ai.generateMonthlyInsights.mock.calls[0][1]).toMatch(/Bokförd intäkt: 120\s000/)
    expect(
      await accounting.getBookedRevenueReport(org, date('2026-05-01'), date('2026-05-31')),
    ).toMatchObject({ status: 'KNOWN', amountOre: 0 })
  })
  it('R01: verkligt propertyId ger beloppsfritt avstående även genom publika AI-verktygets auditväg', async () => {
    const audit = new AiAuditService(prisma)
    const original = audit.logToolExecution.bind(audit)
    jest.spyOn(audit, 'logToolExecution').mockImplementation((...args) => {
      const p = original(...args)
      audits.push(p)
      return p
    })
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, {
      prisma,
      accountingService: accounting,
      audit,
      logger: new Logger('ReportContract'),
    })
    const result = await executor.executeTool(
      'get_profit_loss_report',
      { fromDate: '2026-09-01', toDate: '2026-09-30', propertyId: property },
      org,
      { kind: 'USER', id: user },
      'OWNER',
    )
    expect(result.success).toBe(false)
    expect(result.data).toMatchObject({
      code: 'REPORT_NOT_DETERMINABLE',
      reason: 'PROPERTY_ALLOCATION_UNVERIFIED',
    })
    expect(JSON.stringify(result)).not.toContain('120000')
    await Promise.all(audits)
    expect(
      await prisma.aiToolExecution.count({
        where: { organizationId: org, toolName: 'get_profit_loss_report', success: false },
      }),
    ).toBe(1)
  })
  it('persistent FORTNOX utan connection blir inte EVENO; lokal bok och operativa avtal finns kvar', async () => {
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { organizationId: org, invoiceNumber: 'OTHER' },
    })
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'OVERDUE', dueDate: date('2026-09-01') },
    })
    await prisma.invoicePayment.create({
      data: { invoiceId: invoice.id, amount: 15000, paidAt: date('2026-09-02'), source: 'MANUAL' },
    })
    const notice = await prisma.rentNotice.findFirstOrThrow({ where: { organizationId: org } })
    await prisma.rentNotice.update({
      where: { id: notice.id },
      data: { status: 'OVERDUE', dueDate: date('2026-09-01') },
    })
    await prisma.rentNoticePayment.create({
      data: {
        rentNoticeId: notice.id,
        amount: 95500,
        paidAt: date('2026-09-02'),
        source: 'MANUAL',
      },
    })
    await prisma.invoice.updateMany({
      where: { organizationId: org, type: 'DEPOSIT' },
      data: { status: 'OVERDUE', dueDate: date('2026-09-01') },
    })
    const overdue = new OverdueDebtService(prisma)
    expect(await overdue.getOverdueSnapshot(org)).toMatchObject({ total: 9500, count: 2 })
    // Syntetiskt fullständigt ägarbeslut, därefter saknad anslutning. Inget provideranrop.
    const connection = await prisma.fortnoxConnection.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        fortnoxDatabaseNumber: 101,
        fortnoxOrgNumber: 'synthetic-190',
        exportVoucherSeries: 'E',
        connectedAt: new Date(),
      },
    })
    const opening = await prisma.openingPackage.create({
      data: {
        organizationId: org,
        status: 'EXECUTED',
        cutoverDate: date('2026-07-01'),
        sourceName: 'synthetic-zero.csv',
        sourceSha256: 'c'.repeat(64),
        createdById: user,
        executedAt: new Date(),
        reconciliationStatus: 'AVSTAMD',
        zeroOpening: true,
      },
    })
    const activation = await prisma.fortnoxCustomerActivation.create({
      data: {
        organizationId: org,
        status: 'ACTIVE',
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        fortnoxDatabaseNumber: 101,
        fortnoxOrgNumber: 'synthetic-190',
        financialYearId: 2026,
        financialYearFrom: date('2026-07-01'),
        financialYearTo: date('2027-06-30'),
        voucherSeries: 'E',
        financialYearAccountingMethod: 'ACCRUAL',
        mappingSha256: 'a'.repeat(64),
        openingPackageId: opening.id,
        fortnoxReadRunId: 'synthetic-read',
        consequencesText: 'Syntetiskt prov',
        consequencesSha256: 'b'.repeat(64),
        approvedById: user,
      },
    })
    await prisma.organization.update({
      where: { id: org },
      data: {
        ledgerOwner: 'FORTNOX',
        ledgerOwnerActivationId: activation.id,
        ledgerOwnerFortnoxDatabaseNumber: 101,
        ledgerOwnerFortnoxOrgNumber: 'synthetic-190',
        ledgerOwnerSetAt: new Date(),
        ledgerOwnerSetById: user,
      },
    })
    await prisma.fortnoxConnection.delete({ where: { id: connection.id } })
    expect(await prisma.fortnoxConnection.count({ where: { organizationId: org } })).toBe(0)
    expect(await accounting.getBookedRevenueReport(org, from, to)).toMatchObject({
      status: 'NOT_DETERMINABLE',
      reason: 'EXTERNAL_REPORT_UNAVAILABLE',
    })
    await expect(
      accounting.getProfitLossReport(org, '2026-09-01', '2026-09-30'),
    ).rejects.toMatchObject({ response: { reason: 'EXTERNAL_REPORT_UNAVAILABLE' } })
    const text = await new DataContextService(
      prisma,
      new OverdueDebtService(prisma),
      accounting,
    ).buildContext(org, 'OWNER')
    expect(text).toContain('kan inte fastställas')
    expect(text).toMatch(/Förväntad månadshyra .*300\s000/)
    expect(text).toMatch(/Förfallen skuld: .*9\s500/)
    expect(await overdue.getOverdueSnapshot(org)).toMatchObject({ total: 9500, count: 2 })
    expect(await accounting.getRevenueTotal(org, from, to)).toBe(120000)
  })
})
