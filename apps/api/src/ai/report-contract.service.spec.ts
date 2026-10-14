jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AiAssistantService } from './ai-assistant.service'
import { AiAssistantController } from './ai-assistant.controller'
import { AccountingService } from '../accounting/accounting.service'
import { FortnoxReadbackService } from '../fortnox/fortnox-readback.service'
import { formatFortnoxShadowForAi, type FortnoxAiSnapshot } from '../fortnox/fortnox-ai-context'
import { DataContextService } from './data-context.service'
import { PortfolioAnalysisService } from './portfolio-analysis.service'
import { ToolExecutorService } from './tools/tool-executor.service'

function rig(owner: string | null = 'EVENO') {
  const rows = [
    { account: { number: 3911, name: 'Hyra' }, debit: 0, credit: 200000 },
    { account: { number: 5010, name: 'Drift' }, debit: 60000, credit: 0 },
  ]
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(
        owner === null
          ? null
          : {
              ledgerOwner: owner,
              fiscalYearStartMonth: 7,
              name: 'O-A',
              city: 'Provstad',
              ledgerOwnerActivationId: 'ACT',
              ledgerOwnerFortnoxOrgNumber: '5560000000',
              ledgerOwnerFortnoxDatabaseNumber: 101,
            },
      ),
    },
    journalEntryLine: {
      findMany: jest.fn().mockResolvedValue(rows),
      aggregate: jest.fn().mockResolvedValue({ _sum: { credit: 120000, debit: 0 } }),
    },
    property: { count: jest.fn().mockResolvedValue(21), findMany: jest.fn().mockResolvedValue([]) },
    unit: { groupBy: jest.fn().mockResolvedValue([]) },
    tenant: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    lease: {
      count: jest.fn().mockResolvedValue(100),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { monthlyRent: 300000 }, _count: { id: 100 } }),
    },
    invoice: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(2),
    },
    openingPackage: { findMany: jest.fn().mockResolvedValue([]) },
    rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const accounting = Object.create(AccountingService.prototype) as AccountingService
  Object.assign(accounting, { prisma })
  const overdue = {
    getOverdueSnapshot: jest.fn().mockResolvedValue({ total: 9500, count: 2, over30Count: 1 }),
  }
  return { prisma, accounting, overdue }
}

const period = ['2026-09-01', '2026-09-30'] as const
describe('verkliga rapporttjänster och promptbyggare', () => {
  it('R01: propertyId får inte organisationens 140000; samma metod ger lokal org-rapport utan filter', async () => {
    const { prisma, accounting } = rig()
    await expect(accounting.getProfitLossReport('O-A', ...period, 'P-A')).rejects.toMatchObject({
      response: { status: 'NOT_DETERMINABLE', reason: 'PROPERTY_ALLOCATION_UNVERIFIED' },
    })
    expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
    expect((await accounting.getProfitLossReport('O-A', ...period)).result).toBe(140000)
    expect(prisma.journalEntryLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          journalEntry: {
            organizationId: 'O-A',
            date: { gte: new Date(period[0]), lte: new Date(period[1]) },
          },
        },
      }),
    )
  })

  it.each(['FORTNOX', 'UNKNOWN', null])(
    'owner %s avstår i resultat/moms/balans och bokförd intäkt',
    async (owner) => {
      const { prisma, accounting } = rig(owner)
      for (const read of [
        () => accounting.getProfitLossReport('O-A', ...period),
        () => accounting.getVatReport('O-A', ...period),
        () => accounting.getBalanceSheet('O-A', period[1]),
      ]) {
        await expect(read()).rejects.toMatchObject({ response: { status: 'NOT_DETERMINABLE' } })
      }
      const value = await accounting.getBookedRevenueReport(
        'O-A',
        new Date(period[0]),
        new Date(period[1]),
      )
      expect(value.status).toBe('NOT_DETERMINABLE')
      expect(value).not.toHaveProperty('amountOre')
      expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
      expect(prisma.journalEntryLine.aggregate).not.toHaveBeenCalled()
    },
  )

  it('bokförd intäkt skiljer verklig nolla från läsfel och använder brutet år', async () => {
    const { prisma, accounting } = rig()
    prisma.journalEntryLine.aggregate.mockResolvedValueOnce({ _sum: { credit: 0, debit: 0 } })
    const zero = await accounting.getBookedRevenueYearToDate(
      'O-A',
      new Date('2026-10-14T08:00:00Z'),
    )
    expect(zero).toMatchObject({
      status: 'KNOWN',
      amountOre: 0,
      scope: { period: { from: '2026-07-01', to: '2026-10-14' } },
    })
    prisma.journalEntryLine.aggregate.mockRejectedValueOnce(new Error('syntetiskt läsfel'))
    const missing = await accounting.getBookedRevenueReport(
      'O-A',
      new Date(period[0]),
      new Date(period[1]),
    )
    expect(missing).toMatchObject({ status: 'NOT_DETERMINABLE', reason: 'READ_FAILED' })
    expect(missing).not.toHaveProperty('amountOre')
  })

  it('AI-verktygets verkliga läsfall använder samma beloppsfria avstående', async () => {
    const { prisma, accounting } = rig()
    const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, {
      prisma,
      accountingService: accounting,
      audit: { logToolExecution: jest.fn().mockResolvedValue(undefined) },
    })
    const answer = await executor.executeTool(
      'get_profit_loss_report',
      { fromDate: period[0], toDate: period[1], propertyId: 'P-A' },
      'O-A',
      { kind: 'USER', id: 'U-A' },
      'OWNER',
    )
    expect(answer.success).toBe(false)
    expect(answer.data).toEqual({
      status: 'NOT_DETERMINABLE',
      code: 'REPORT_NOT_DETERMINABLE',
      // Publika tool-result passerar befintlig prompt-injection-inramning.
      reason: '⟦OSÄKER⟧PROPERTY_ALLOCATION_UNVERIFIED⟦/OSÄKER⟧',
      message:
        '⟦OSÄKER⟧Fastighetens resultat kan inte fastställas: verifierad fastighetsfördelning saknas.⟦/OSÄKER⟧',
    })
    expect(JSON.stringify(answer)).not.toContain('140000')
    expect(JSON.stringify(answer)).toContain('PROPERTY_ALLOCATION_UNVERIFIED')
  })

  it.each(
    ['get_vat_report', 'get_profit_loss_report', 'get_balance_sheet'].flatMap((name) =>
      ['FORTNOX', 'UNKNOWN'].map((owner) => [name, owner]),
    ),
  )(
    '%s: publikt AI-verktyg ger kontrollerat beloppsfritt avstående för %s',
    async (name, owner) => {
      const { prisma, accounting } = rig(owner)
      const executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
      Object.assign(executor, {
        prisma,
        accountingService: accounting,
        audit: { logToolExecution: jest.fn().mockResolvedValue(undefined) },
      })
      const result = await executor.executeTool(
        name,
        { fromDate: period[0], toDate: period[1], asOfDate: period[1] },
        'O-A',
        { kind: 'USER', id: 'U-A' },
        'OWNER',
      )
      expect(result.success).toBe(false)
      expect(result.data).toEqual({
        status: 'NOT_DETERMINABLE',
        code: 'REPORT_NOT_DETERMINABLE',
        reason:
          owner === 'FORTNOX'
            ? '⟦OSÄKER⟧EXTERNAL_REPORT_UNAVAILABLE⟦/OSÄKER⟧'
            : '⟦OSÄKER⟧OWNER_UNVERIFIED⟦/OSÄKER⟧',
        message: expect.any(String),
      })
      expect(result.message).toContain('kan inte fastställas')
      expect(result.message).not.toContain('Åtgärden misslyckades')
      expect(JSON.stringify(result)).not.toContain('120000')
      expect(JSON.stringify(result)).not.toContain('140000')
      expect(prisma.journalEntryLine.findMany).not.toHaveBeenCalled()
    },
  )

  it('DataContext behåller skuldsnapshot9500 och hela avtalsaggregatet300000 utan extern anslutning', async () => {
    const { prisma, accounting, overdue } = rig('FORTNOX')
    const context = new DataContextService(prisma as never, overdue as never, accounting)
    const text = await context.buildContext('O-A', 'ACCOUNTANT')
    expect(text).toContain('kan inte fastställas')
    expect(text).toContain(
      new Intl.NumberFormat('sv-SE', {
        style: 'currency',
        currency: 'SEK',
        maximumFractionDigits: 0,
      }).format(9500),
    )
    expect(text).toContain(
      new Intl.NumberFormat('sv-SE', {
        style: 'currency',
        currency: 'SEK',
        maximumFractionDigits: 0,
      }).format(300000),
    )
    expect(prisma.journalEntryLine.aggregate).not.toHaveBeenCalled()
    expect(prisma.lease.aggregate).toHaveBeenCalledWith({
      where: { organizationId: 'O-A', status: 'ACTIVE' },
      _sum: { monthlyRent: true },
      _count: { id: true },
    })
  })

  it('portföljens verkliga promptunderlag avstår från extern intäkt och behåller operativ skuld', async () => {
    const { prisma, accounting, overdue } = rig('FORTNOX')
    const portfolio = Object.create(PortfolioAnalysisService.prototype) as PortfolioAnalysisService
    Object.assign(portfolio, { prisma, accounting, overdue })
    const now = new Date('2026-10-14')
    const text = await (
      portfolio as unknown as {
        fetchData: (
          org: string,
          kind: string,
          now: Date,
          before: Date,
          after: Date,
          later: Date,
        ) => Promise<string>
      }
    ).fetchData('O-A', 'revenue', now, now, now, now)
    expect(text).toContain('kan inte fastställas')
    expect(text).toContain('9500.00 SEK')
    expect(text).not.toContain('120000')
  })
})

describe('Fortnox-underlag före den faktiska prompten', () => {
  const snapshot = (db = 101): FortnoxAiSnapshot => ({
    connection: { status: 'ACTIVE', fortnoxDatabaseNumber: 101, fortnoxCompanyName: 'A' },
    exports: null,
    latestRead: null,
    latestCompleteRead: {
      id: 'R-1',
      status: 'COMPLETE',
      financialYearId: 7,
      financialYearStart: new Date('2026-07-01'),
      financialYearEnd: new Date('2027-06-30'),
      periodFrom: new Date('2026-09-01'),
      periodTo: new Date('2026-09-30'),
      startedAt: new Date('2026-10-10T08:00:00Z'),
      completedAt: new Date('2026-10-10T08:01:00Z'),
      reason: null,
      costAccounts: [5010],
      fortnoxDatabaseNumber: db,
      coverage: {},
      uncertainties: [],
      summary: {
        totalOre: 2500000,
        byProperty: [],
        unmappedDimensions: [],
        unallocatedOre: 2500000,
        evenoExportOre: 700000,
        uncertainRemovedOre: 0,
      },
    },
  })
  it('R03: formatteraren spärrar andra företagets belopp, inte bara en varning', () => {
    const text = formatFortnoxShadowForAi(snapshot(202)).join('\n')
    expect(text).toContain('annat Fortnox-företag')
    expect(text).not.toContain('25 000')
    expect(text).not.toContain('7 000')
    expect(text).not.toContain('Summa:')
  })
  it.each(['ACCOUNTANT', 'MANAGER', 'VIEWER', 'UNKNOWN', undefined])(
    'roll %s får inga externa belopp eller läsning',
    async (role) => {
      const { prisma } = rig('FORTNOX')
      const reader = Object.create(FortnoxReadbackService.prototype) as FortnoxReadbackService
      Object.assign(reader, { prisma })
      const legacy = jest.spyOn(reader, 'aiSnapshot').mockResolvedValue(snapshot())
      const result = await reader.aiReportSnapshot('O-A', role)
      expect(result.reportUnavailable?.reason).toBe('NOT_AUTHORIZED')
      expect(legacy).not.toHaveBeenCalled()
      expect(prisma.organization.findUnique).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('2500000')
    },
  )
  it('R03: hela DataContext-vägen släpper inte in fel företags25000 eller export7000 i modellens underlag', async () => {
    const { prisma, accounting, overdue } = rig('FORTNOX')
    const reader = Object.create(FortnoxReadbackService.prototype) as FortnoxReadbackService
    Object.assign(reader, { prisma })
    jest.spyOn(reader, 'aiSnapshot').mockResolvedValue(snapshot(202))
    const text = await new DataContextService(
      prisma as never,
      overdue as never,
      accounting,
      reader,
    ).buildContext('O-A', 'OWNER')
    expect(text).toContain('matchar inte organisationens valda Fortnox-företag')
    expect(text).not.toMatch(/25[\s ]*000/)
    expect(text).not.toMatch(/7[\s ]*000/)
    expect(text).not.toContain('Summa:')
    expect(text).toMatch(/9[\s ]*500/)
  })
  it.each(['AUTH_LOST', 'DISCONNECTED'] as const)(
    '%s ändrar inte ägarval och återställer inga lokala rapportbelopp',
    async (status) => {
      const { prisma, accounting } = rig('FORTNOX')
      const reader = Object.create(FortnoxReadbackService.prototype) as FortnoxReadbackService
      Object.assign(reader, { prisma })
      const old = snapshot()
      old.connection!.status = status
      jest.spyOn(reader, 'aiSnapshot').mockResolvedValue(old)
      const result = await reader.aiReportSnapshot('O-A', 'OWNER')
      expect(result.latestCompleteRead?.summary).toBeNull()
      expect(formatFortnoxShadowForAi(result).join('\n')).not.toMatch(/25[\s ]*000/)
      expect(
        await accounting.getBookedRevenueReport('O-A', new Date(period[0]), new Date(period[1])),
      ).toMatchObject({ status: 'NOT_DETERMINABLE' })
      expect(prisma.journalEntryLine.aggregate).not.toHaveBeenCalled()
    },
  )
  it.each(['OWNER', 'ADMIN'])(
    'roll %s får historisk metadata men inga obundna rapportbelopp',
    async (role) => {
      const { prisma } = rig('FORTNOX')
      const reader = Object.create(FortnoxReadbackService.prototype) as FortnoxReadbackService
      Object.assign(reader, { prisma })
      jest.spyOn(reader, 'aiSnapshot').mockResolvedValue(snapshot())
      const result = await reader.aiReportSnapshot('O-A', role)
      expect(result.latestCompleteRead?.summary).toBeNull()
      const text = formatFortnoxShadowForAi(result).join('\n')
      expect(text).toContain('2026-09-01–2026-09-30')
      expect(text).toContain('2026-10-10')
      expect(text).not.toContain('25 000')
      expect(text).toContain('Inga rapportbelopp är fastställda')
    },
  )
})

describe('båda chattingångarna skickar den verkliga läsarrollen till rapportkontexten', () => {
  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'] as const)(
    '%s: chat och SSE bygger orgbunden kontext före stoppad modellgräns',
    async (role) => {
      const { prisma, accounting, overdue } = rig('FORTNOX')
      const context = new DataContextService(prisma as never, overdue as never, accounting)
      const observed = jest.spyOn(context, 'buildContext')
      const stop = new Error('SYNTHETIC_STOP_BEFORE_MODEL')
      const quota = {
        checkQuota: jest.fn().mockResolvedValue(undefined),
        checkUserDailyCostCap: jest.fn().mockResolvedValue(undefined),
      }
      const memory = { getMemories: jest.fn().mockResolvedValue('') }
      const grounding = jest.fn().mockRejectedValue(stop)
      const provider = {
        messages: { create: jest.fn().mockRejectedValue(new Error('LiveAI förbjudet')) },
      }
      const ai = Object.create(AiAssistantService.prototype) as AiAssistantService
      Object.assign(ai, {
        configService: { get: () => 'synthetic-not-a-credential' },
        quota,
        getOrCreateConversation: jest.fn().mockResolvedValue({ id: 'C-A', messages: [] }),
        dataContext: context,
        memory,
        resolveLegalGrounding: grounding,
        client: provider,
      })
      await expect(
        ai.chat('O-A', 'U-A', role, 'Vilken bokförd intäkt är verifierad?'),
      ).rejects.toBe(stop)
      expect(observed).toHaveBeenLastCalledWith('O-A', role)
      expect(await observed.mock.results[0]!.value).toContain('kan inte fastställas')
      expect(provider.messages.create).not.toHaveBeenCalled()

      const controller = Object.create(AiAssistantController.prototype) as AiAssistantController
      Object.assign(controller, {
        quotaService: quota,
        dataContext: context,
        memoryService: memory,
        prisma: {
          aiConversation: { create: jest.fn().mockResolvedValue({ id: 'C-B', messages: [] }) },
        },
        aiService: { resolveLegalGrounding: grounding },
        client: provider,
      })
      const reply = { raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() } }
      await controller.streamChat(
        'Vilken bokförd intäkt är verifierad?',
        undefined,
        undefined,
        'O-A',
        { sub: 'U-A', organizationId: 'O-A', role } as never,
        reply as never,
      )
      expect(observed).toHaveBeenNthCalledWith(2, 'O-A', role)
      expect(await observed.mock.results[1]!.value).toContain('kan inte fastställas')
      expect(reply.raw.write).toHaveBeenCalledWith(
        expect.stringContaining('SYNTHETIC_STOP_BEFORE_MODEL'),
      )
      expect(reply.raw.end).toHaveBeenCalledTimes(1)
      expect(provider.messages.create).not.toHaveBeenCalled()
    },
  )
})
