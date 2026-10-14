jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { NotificationsService } from './notifications.service'
import { reportFailure, type BookedRevenue } from '../ai/report-evidence'

const scope = {
  organizationId: 'O-A',
  metric: 'BOOKED_REVENUE' as const,
  propertyId: null,
  period: { from: '2026-09-01', to: '2026-09-30' },
}
const known: BookedRevenue = {
  status: 'KNOWN',
  scope,
  source: 'EVENO_LEDGER',
  accountSystem: 'EVENO',
  accountRange: [3000, 3999],
  definition: 'CREDIT_MINUS_DEBIT',
  currency: 'SEK',
  amountOre: 12000000,
  observedAt: '2026-10-01T08:00:00Z',
  completeness: 'COMPLETE',
}

async function notify(current: BookedRevenue) {
  const prisma = {
    organization: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'O-A',
          name: 'Provorganisation',
          users: [{ id: 'U-A', firstName: 'Syn', email: null }],
        },
      ]),
    },
    notification: { create: jest.fn().mockResolvedValue({ id: 'synthetic' }) },
  }
  const mail = {
    sendMonthlyReport: jest
      .fn()
      .mockRejectedValue(new Error('Externt utskick förbjudet i detta prov')),
  }
  const cronErrors = { report: jest.fn() }
  const locks = {
    runIfUnlocked: jest.fn().mockImplementation(async (_key: string, fn: () => Promise<void>) => {
      await fn()
      return { ran: true }
    }),
  }
  const monthlyReport = {
    generatePdf: jest.fn().mockResolvedValue({
      pdf: Buffer.from('synthetic'),
      data: {
        summary: { revenue: { current }, occupancy: { currentPct: 91 } },
        header: { monthLabel: 'September 2026' },
      },
    }),
  }
  const service = new NotificationsService(
    prisma as never,
    mail as never,
    {} as never,
    monthlyReport as never,
    locks as never,
    cronErrors as never,
  )
  await service.sendMonthlyReport()
  expect(locks.runIfUnlocked).toHaveBeenCalledTimes(1)
  expect(prisma.organization.findMany).toHaveBeenCalledWith({
    include: {
      users: {
        where: { role: { in: ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT'] }, isActive: true },
      },
    },
  })
  expect(monthlyReport.generatePdf).toHaveBeenCalledWith('O-A')
  expect(cronErrors.report).not.toHaveBeenCalled()
  expect(mail.sendMonthlyReport).not.toHaveBeenCalled()
  const writes = prisma.notification.create.mock.calls.map((c) => c[0].data)
  expect(writes.filter((r) => r.type === 'SYSTEM')).toHaveLength(1)
  const report = writes.find((r) => r.type === 'MONTHLY_REPORT')
  expect(report).toMatchObject({ organizationId: 'O-A', userId: 'U-A' })
  return report.message as string
}

describe('verklig månadsnotis med bokförd intäkt och bevarad mottagar-/sentinelväg', () => {
  it('EVENO: 120000 bokfört med källa och period', async () => {
    expect(await notify(known)).toBe(
      'Bokförd intäkt: 120 000 kr — källa: Evenos huvudbok, 3xxx kredit−debet, period 2026-09-01–2026-09-30, läst per 2026-10-01T08:00:00Z. Beläggning 91%. Rapporten finns som PDF-bilaga i mejlet.',
    )
  })
  it.each(['EXTERNAL_REPORT_UNAVAILABLE', 'OWNER_UNVERIFIED'] as const)(
    '%s: bakgrundsnotis lämnar inga rapportbelopp',
    async (reason) => {
      const value: BookedRevenue = { ...reportFailure(reason), scope }
      const message = await notify(value)
      expect(message).toBe(
        `Bokförd intäkt: ${reportFailure(reason).message}. Beläggning 91%. Rapporten finns som PDF-bilaga i mejlet.`,
      )
      expect(message).not.toMatch(/\d[\d\s]*kr/)
    },
  )
})
