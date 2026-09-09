import { AiUsagePageService } from '../../ai-usage/ai-usage.service'
import { AiQuotaService } from './ai-quota.service'

it('månadsgrind och planvy räknar samma frågor; historiken behåller kontrollens kostnad', async () => {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        subscriptionPlan: 'STARTER',
        aiCreditsBalance: 0,
        status: 'ACTIVE',
        planStartedAt: new Date(),
        planMonthlyFee: 1,
      }),
    },
    aiUsageLog: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([
        {
          createdAt: new Date(Date.now() - 3 * 86_400_000),
          endpoint: 'stream',
          isAutomated: false,
          costUsd: 0.1,
        },
        {
          createdAt: new Date(Date.now() - 3 * 86_400_000),
          endpoint: 'consumption-judge',
          isAutomated: false,
          costUsd: 0.01,
        },
        {
          createdAt: new Date(Date.now() - 3 * 86_400_000),
          endpoint: 'memory',
          isAutomated: true,
          costUsd: 0.02,
        },
      ]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { costSek: 0 } }),
    },
  }
  const quota = new AiQuotaService(prisma as never)
  const page = new AiUsagePageService(prisma as never)
  await expect(quota.checkQuota('org')).resolves.toEqual({ creditUsed: false })
  expect((await quota.getStatus('org')).used).toBe(1)
  expect((await page.current('org')).used).toBe(1)
  for (const [args] of prisma.aiUsageLog.count.mock.calls) {
    expect(args.where).toMatchObject({
      organizationId: 'org',
      isAutomated: false,
      endpoint: { not: 'consumption-judge' },
    })
  }
  const history = await page.history('org', 7)
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ manualCalls: 1, automatedCalls: 1, costUsd: 0.13 }),
    ]),
  )
  expect(history.reduce((sum, row) => sum + row.manualCalls, 0)).toBe(1)
  // Dagliga kostnadstak ska däremot räkna domarkostnaden, utan endpoint-undantag.
  await quota.checkUserDailyCostCap('org', 'user')
  expect(prisma.aiUsageLog.aggregate.mock.calls.at(-1)![0].where).toMatchObject({
    organizationId: 'org',
    userId: 'user',
    isAutomated: false,
  })
  expect(prisma.aiUsageLog.aggregate.mock.calls.at(-1)![0].where).not.toHaveProperty('endpoint')
})
