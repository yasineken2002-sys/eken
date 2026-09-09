import { Test } from '@nestjs/testing'
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants'
import {
  readingReviewFollowUpState,
  nextReadingReviewFollowUp,
  readingReviewFollowUpTime,
} from '@eken/shared'
import { getConsumptionFollowUp, ConsumptionFollowUpToolSchema } from './consumption-follow-up'
import { TOOLS, ACTION_TOOLS } from './ai-tools.definition'
import { TENANT_TOOLS } from './tenant-ai-tools.definition'
import { buildToolCatalog } from './ai-tools.catalog'
import { ToolExecutorService } from './tool-executor.service'
import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAuditService } from '../audit/ai-audit.service'
import { ROLES_KEY } from '../../common/guards/roles.guard'
import { ReadingReviewFollowUpController } from '../../consumption/reading-review-follow-up.controller'
import { ReadingReviewFollowUpService } from '../../consumption/reading-review-follow-up.service'
import type { CronErrorSink } from '../../common/cron/cron-error-sink'

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

const now = new Date('2026-10-26T07:00:00Z')
const off = {
  consumptionReviewFollowUpEnabled: false,
  consumptionReviewFollowUpEnabledAt: null,
  consumptionReviewFollowUpCheckedAt: null,
  consumptionReviewFollowUpErrorAt: null,
}
function setup(row: object | null = off) {
  const db = { organization: { findUnique: jest.fn().mockResolvedValue(row) } }
  const prisma = db as unknown as PrismaService
  const api = new ReadingReviewFollowUpService(prisma, {} as CronErrorSink)
  return {
    db,
    prisma,
    api,
    run: (input: Record<string, unknown> = {}, role = 'VIEWER') =>
      getConsumptionFollowUp(prisma, 'session-org', role, input),
  }
}
beforeEach(() => jest.useFakeTimers().setSystemTime(now))
afterEach(() => jest.useRealTimers())

it.each(['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'])(
  '%s läser exakt API-status; endast ägare får hänvisning till eget reglage',
  async (role) => {
    const f = setup()
    const result = await f.run({}, role)
    expect(result.data.status).toEqual(await f.api.getStatus('session-org'))
    expect(result.data.humanPath).toMatchObject({
      route: '/consumption?tab=review',
      canChangeSetting: role === 'OWNER',
      canAssistantChangeSetting: false,
      canRunNow: false,
      settingRole: { role: 'OWNER', label: 'Ägare' },
    })
    expect(f.db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'session-org' },
      select: {
        consumptionReviewFollowUpEnabled: true,
        consumptionReviewFollowUpEnabledAt: true,
        consumptionReviewFollowUpCheckedAt: true,
        consumptionReviewFollowUpErrorAt: true,
      },
    })
    expect(result.data.observedAt).toBe(now.toISOString())
    expect([result.data.humanPath.settingRole.role]).toEqual(
      Reflect.getMetadata(ROLES_KEY, ReadingReviewFollowUpController.prototype.update),
    )
  },
)

it.each([
  ['off', { ...off, consumptionReviewFollowUpCheckedAt: now }],
  [
    'waiting',
    { ...off, consumptionReviewFollowUpEnabled: true, consumptionReviewFollowUpEnabledAt: now },
  ],
  [
    'checked',
    {
      ...off,
      consumptionReviewFollowUpEnabled: true,
      consumptionReviewFollowUpCheckedAt: new Date('2026-10-25T06:00:00Z'),
    },
  ],
  [
    'overdue',
    {
      ...off,
      consumptionReviewFollowUpEnabled: true,
      consumptionReviewFollowUpCheckedAt: new Date('2026-10-24T06:00:00Z'),
    },
  ],
  [
    'failed',
    { ...off, consumptionReviewFollowUpEnabled: true, consumptionReviewFollowUpErrorAt: now },
  ],
] as const)('tillstånd %s överensstämmer med webbens funktion', async (state, row) => {
  const result = await setup(row).run()
  expect(result.data.state).toBe(state)
  expect(result.data.state).toBe(readingReviewFollowUpState(result.data.status, now.getTime()))
  expect(result.data.limitations).toEqual({
    provesReadingCorrectness: false,
    approvesBilling: false,
    provesNotificationDelivery: false,
    includesCurrentReviewQueue: false,
    includesFailureCause: false,
    includesHistoricalFindingCount: false,
    includesDisabledAt: false,
    includesRunningState: false,
    collectsNewReadings: false,
  })
})

it('en oförändrad DB-rad blir försenad när tiden går och statusläsningen kör ingen analys', async () => {
  // DB-attrappen HAR inga avläsnings-, notis- eller skrivmetoder.
  const f = setup({
    ...off,
    consumptionReviewFollowUpEnabled: true,
    consumptionReviewFollowUpCheckedAt: now,
  })
  jest.setSystemTime(now.getTime() + 26 * 60 * 60 * 1000)
  expect((await f.run()).data.state).toBe('checked')
  jest.setSystemTime(now.getTime() + 26 * 60 * 60 * 1000 + 1)
  expect((await f.run()).data.state).toBe('overdue')
})

it('schemat i svaret är samma som det registrerade dagliga cronjobbet', async () => {
  const { schedule } = (await setup().run()).data
  const options = Reflect.getMetadata(
    SCHEDULE_CRON_OPTIONS,
    ReadingReviewFollowUpService.prototype.followUpDaily,
  )
  expect(options).toMatchObject({
    cronTime: `${schedule.minute} ${schedule.hour} * * *`,
    timeZone: schedule.timeZone,
    name: 'consumption-review-follow-up',
  })
  expect(options.cronTime).toBe('15 7 * * *')
  expect(schedule.timeZone).toBe('Europe/Stockholm')
})

it.each([{ organizationId: 'other' }, { enabled: true }, { runNow: true }, { snapshot: 'old' }])(
  'inga org- eller skrivparametrar får passera: %j',
  async (input) => {
    const f = setup()
    await expect(f.run(input)).rejects.toMatchObject({ status: 400 })
    expect(f.db.organization.findUnique).not.toHaveBeenCalled()
    expect(ConsumptionFollowUpToolSchema.safeParse(input).success).toBe(false)
  },
)
it('okänd roll nekas före läsningen', async () => {
  const f = setup()
  await expect(f.run({}, 'UNKNOWN')).rejects.toMatchObject({ status: 403 })
  expect(f.db.organization.findUnique).not.toHaveBeenCalled()
})
it('saknad organisation och DB-fel blir fel, aldrig ett avstängt eller friskt läge', async () => {
  await expect(setup(null).run()).rejects.toMatchObject({ status: 404 })
  const f = setup()
  f.db.organization.findUnique.mockRejectedValue(new Error('database unavailable'))
  await expect(f.run()).rejects.toThrow('database unavailable')
})
it('finns i operatörens meny som läsverktyg, inte i handlings- eller portalmenyn', () => {
  const tool = TOOLS.find((entry) => entry.name === 'get_consumption_follow_up')!
  expect(tool.input_schema).toEqual({
    type: 'object',
    properties: {},
    additionalProperties: false,
    required: [],
  })
  expect(ACTION_TOOLS.has(tool.name)).toBe(false)
  expect(TENANT_TOOLS.some((entry) => entry.name === tool.name)).toBe(false)
  expect(buildToolCatalog().find((entry) => entry.name === tool.name)).toMatchObject({
    binding: false,
    menuLabel: 'Visa automatisk förbrukningsuppföljning',
  })
})

it('hela ToolExecutor-vägen läser om efter ändring och rapporterar fel utan påhittad status', async () => {
  const f = setup()
  const audit = { logToolExecution: jest.fn(), logSecurityEvent: jest.fn() }
  const module = await Test.createTestingModule({
    providers: [
      ToolExecutorService,
      { provide: PrismaService, useValue: f.prisma },
      { provide: AiAuditService, useValue: audit },
    ],
  })
    .useMocker(() => ({}))
    .compile()
  const executor = module.get(ToolExecutorService)
  const run = () =>
    executor.executeTool(
      'get_consumption_follow_up',
      {},
      'session-org',
      { kind: 'USER', id: 'user' },
      'VIEWER',
    )
  try {
    expect(await run()).toMatchObject({ success: true, data: { state: 'off' } })
    f.db.organization.findUnique.mockResolvedValue({
      ...off,
      consumptionReviewFollowUpEnabled: true,
      consumptionReviewFollowUpEnabledAt: now,
    })
    expect(await run()).toMatchObject({ success: true, data: { state: 'waiting' } })
    expect(audit.logToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, requiredConfirmation: false, effects: [] }),
    )
    f.db.organization.findUnique.mockRejectedValue(new Error('database unavailable'))
    const failed = await run()
    expect(failed.success).toBe(false)
    expect(failed.data).toBeUndefined()
  } finally {
    await module.close()
  }
})

it.each([
  ['2026-09-09T04:15:00Z', '2026-09-09T05:15:00Z'],
  ['2026-09-09T05:15:00Z', '2026-09-10T05:15:00Z'],
  ['2026-03-28T06:15:00Z', '2026-03-29T05:15:00Z'],
  ['2026-10-24T05:15:00Z', '2026-10-25T06:15:00Z'],
  ['2026-12-31T07:00:00Z', '2027-01-01T06:15:00Z'],
])('nästa schematid efter %s är %s, även vid sommartids- och årsskifte', (at, expected) => {
  expect(nextReadingReviewFollowUp(new Date(at))).toEqual(new Date(expected))
})

it('avstängt har ingen nästa körning; påslag och lyckad kontroll får svenska etiketter och tider', async () => {
  const f = setup({
    ...off,
    consumptionReviewFollowUpEnabledAt: new Date('2026-09-01T05:15:00Z'),
    consumptionReviewFollowUpCheckedAt: new Date('2026-10-25T06:15:00Z'),
  })
  const result = await f.run()
  expect(result.data.nextPlannedAt).toBeNull()
  expect(result.data.display.nextPlannedCheckAt).toBeNull()
  expect(result.data.display.lastEnabledAt).toMatch(/07:15.*svensk tid/)
  expect(result.data.display.lastSuccessfulCheckAt).toMatch(/07:15.*svensk tid/)
  expect(readingReviewFollowUpTime('2026-03-29T05:15:00Z')).toMatch(/07:15.*svensk tid/)
  expect(
    (
      await setup({
        ...off,
        consumptionReviewFollowUpEnabled: true,
        consumptionReviewFollowUpEnabledAt: now,
      }).run()
    ).data.nextPlannedAt,
  ).toBe('2026-10-27T06:15:00.000Z')
})
