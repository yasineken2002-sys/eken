// T5 B1c — bevisar per-org-isolering i AiUsageNotifier.dailyCheck:
// ett org-fel i SUSPENDED-flippen (organization.update kastar) avbryter INTE
// andra orgars trial-hantering, och larmar (Sentry, org-tagg). Samt att
// dailyCheck som helhet larmar (runCronSafely) vid outer-findMany-fel.
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))
// AiUsageNotifier → NotificationsService → MonthlyReportService → storage.service
// (AWS SDK, ESM) som jest inte kan parsa. Stubbas — samma mönster som övriga
// specar som transitivt rör storage.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { captureException } from '@sentry/nestjs'
import { AiUsageNotifierService } from './ai-usage-notifier.service'

const mockedCapture = captureException as jest.Mock

function makeService() {
  const prisma = {
    organization: { findMany: jest.fn(), update: jest.fn() },
    aiUsageLog: { count: jest.fn().mockResolvedValue(0) },
  }
  const mail = { enqueue: jest.fn().mockResolvedValue(undefined) }
  const notifications = { create: jest.fn().mockResolvedValue(undefined) }
  const svc = new AiUsageNotifierService(prisma as never, mail as never, notifications as never)
  ;(svc as unknown as { logger: unknown }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { svc, prisma }
}

beforeEach(() => mockedCapture.mockClear())

describe('AiUsageNotifierService — B1c per-org-isolering', () => {
  it('ett org-fel i SUSPENDED-flippen avbryter INTE andra orgar + larmar (org-tagg)', async () => {
    const { svc, prisma } = makeService()
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000) // trial utgången
    const now = new Date()
    prisma.organization.findMany.mockResolvedValue([
      {
        id: 'A',
        name: 'A',
        status: 'TRIAL',
        trialEndsAt: past,
        planStartedAt: now,
        suspendedAt: null,
        users: [],
      },
      {
        id: 'B',
        name: 'B',
        status: 'TRIAL',
        trialEndsAt: past,
        planStartedAt: now,
        suspendedAt: null,
        users: [],
      },
    ])
    prisma.organization.update.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === 'A') throw new Error('update-fel A')
      return {}
    })

    await (svc as unknown as { checkTrialStatus: () => Promise<void> }).checkTrialStatus()

    // Både A och B försöktes flippas → A:s fel stoppade inte B:
    expect(prisma.organization.update).toHaveBeenCalledTimes(2)

    // A larmade — INTE tyst — med org-tagg:
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [sentryErr, ctx] = mockedCapture.mock.calls[0]
    expect((sentryErr as Error).message).not.toContain('update-fel A') // skrubbat
    expect((ctx as { tags: Record<string, string> }).tags).toEqual(
      expect.objectContaining({ cron: 'ai-usage-check-trial', org: 'A' }),
    )
  })

  it('dailyCheck: outer-findMany kastar → larmar via runCronSafely, kastar INTE vidare', async () => {
    const { svc, prisma } = makeService()
    prisma.organization.findMany.mockRejectedValue(new Error('DB nere'))

    await expect(svc.dailyCheck()).resolves.toBeUndefined()

    const crons = mockedCapture.mock.calls.map(
      (c) => (c[1] as { tags: Record<string, string> }).tags.cron,
    )
    expect(crons).toContain('ai-usage-daily-check')
  })
})
