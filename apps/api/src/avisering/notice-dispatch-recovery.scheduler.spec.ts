import { Prisma, type OrgStatus, type RentNoticeStatus } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { CronErrorSink } from '../common/cron/cron-error-sink'
import type { PdfQueue } from '../pdf-jobs/pdf.queue'
import {
  NOTICE_DISPATCH_RECOVERY_BATCH,
  NoticeDispatchRecoveryScheduler,
} from './notice-dispatch-recovery.scheduler'

const NOW = new Date('2026-10-15T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR)

type Row = {
  id: string
  rentNoticeId: string
  preparedAt: Date
  recoveryAfter: Date | null
  recoveryAttempts: number
  dispatchStartedAt: Date | null
  acceptedAt: Date | null
  payableAmount: Prisma.Decimal
  customerCreditAmount: Prisma.Decimal
  rentNotice: {
    organizationId: string
    status: RentNoticeStatus
    tenant: { anonymizedAt: Date | null }
    organization: { status: OrgStatus; transactionalEmailsDisabled: boolean }
  }
}

/**
 * Stateful CAS-gränsprov. Avsiktligt ingen simulerad bokföring eller rendering:
 * endast återhämtningsfält får skrivas, och kön får bara avins identitet.
 * Status-/organisationsvillkor låses separat i urvals- och claim-provet.
 */
function rig(count = 1) {
  const rows: Row[] = Array.from({ length: count }, (_, index) => ({
    id: `send-${String(index).padStart(3, '0')}`,
    rentNoticeId: `notice-${index}`,
    preparedAt: at(-1),
    recoveryAfter: null,
    recoveryAttempts: 0,
    dispatchStartedAt: null,
    acceptedAt: null,
    payableAmount: new Prisma.Decimal(975),
    customerCreditAmount: new Prisma.Decimal(25),
    rentNotice: {
      organizationId: 'org-synthetic',
      status: 'PENDING',
      tenant: { anonymizedAt: null },
      organization: { status: 'ACTIVE', transactionalEmailsDisabled: false },
    },
  }))
  let clock = NOW
  let beforeClaim: (() => void) | undefined
  const mockSendable = (row: Row) => {
    const n = row.rentNotice
    return (
      ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(n.organization.status) &&
      !n.organization.transactionalEmailsDisabled &&
      !n.tenant.anonymizedAt &&
      !['CANCELLED', 'OPENING'].includes(n.status) &&
      (n.status !== 'PAID' ||
        (row.payableAmount.isZero() && row.customerCreditAmount.greaterThan(0)))
    )
  }
  const store = {
    findMany: jest.fn(async ({ take }: { take: number }) =>
      rows
        .filter(
          (row) =>
            !row.acceptedAt &&
            (row.dispatchStartedAt !== null || mockSendable(row)) &&
            (!row.recoveryAfter || row.recoveryAfter.getTime() <= clock.getTime()),
        )
        .sort(
          (a, b) =>
            (a.recoveryAfter?.getTime() ?? 0) - (b.recoveryAfter?.getTime() ?? 0) ||
            a.preparedAt.getTime() - b.preparedAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .slice(0, take)
        .map((row) => ({ ...row })),
    ),
    updateMany: jest.fn(
      async (args: {
        where: {
          id: string
          recoveryAttempts: number
          dispatchStartedAt: Date | null
          AND: unknown[]
        }
        data: { recoveryAfter: Date; recoveryAttempts: { increment: number } }
      }) => {
        beforeClaim?.()
        const row = rows.find((r) => r.id === args.where.id)!
        if (
          row.recoveryAttempts !== args.where.recoveryAttempts ||
          row.acceptedAt ||
          (row.recoveryAfter && row.recoveryAfter > clock) ||
          (args.where.AND.length === 2 && !mockSendable(row)) ||
          row.dispatchStartedAt?.getTime() !== args.where.dispatchStartedAt?.getTime()
        ) {
          return { count: 0 }
        }
        row.recoveryAfter = args.data.recoveryAfter
        row.recoveryAttempts += args.data.recoveryAttempts.increment
        return { count: 1 }
      },
    ),
  }
  const prisma = { rentNoticeSend: store } as unknown as PrismaService
  const queue: Pick<PdfQueue, 'enqueue'> = { enqueue: jest.fn(async () => 'new-pdf-job') }
  const sink: Pick<CronErrorSink, 'report'> = { report: jest.fn(async () => undefined) }
  const newScheduler = () =>
    new NoticeDispatchRecoveryScheduler(prisma, queue as PdfQueue, sink as CronErrorSink)
  const scheduler = newScheduler()
  return {
    rows,
    store,
    queue,
    sink,
    scheduler,
    newScheduler,
    clock: (value: Date) => {
      clock = value
    },
    beforeClaim: (callback: () => void) => {
      beforeClaim = callback
    },
  }
}

describe('beständig återhämtning av förberedda aviutskick', () => {
  it('urval hittar okända utfall, och claim kräver rätt status och integritet före köning', async () => {
    const r = rig()
    await r.scheduler.recoverPending(NOW)
    const sendable = {
      rentNotice: {
        organization: {
          status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
          transactionalEmailsDisabled: false,
        },
        tenant: { anonymizedAt: null },
        status: { notIn: ['CANCELLED', 'OPENING'] },
      },
      OR: [
        { rentNotice: { status: { not: 'PAID' } } },
        { payableAmount: 0, customerCreditAmount: { gt: 0 } },
      ],
    }
    const expected = {
      kind: 'NOTICE',
      dispatchKey: { not: null },
      acceptedAt: null,
      preparedAt: { lte: new Date('2026-10-15T11:45:00.000Z') },
      AND: [
        { OR: [{ recoveryAfter: null }, { recoveryAfter: { lte: NOW } }] },
        { OR: [{ dispatchStartedAt: { not: null } }, sendable] },
      ],
    }
    expect(r.store.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected }))
    expect(r.store.updateMany).toHaveBeenCalledWith({
      where: {
        AND: [expected, sendable],
        id: 'send-000',
        recoveryAttempts: 0,
        dispatchStartedAt: null,
      },
      data: { recoveryAfter: at(1), recoveryAttempts: { increment: 1 } },
    })
    expect(r.queue.enqueue).toHaveBeenCalledWith({
      kind: 'avisering-send',
      organizationId: 'org-synthetic',
      noticeId: 'notice-0',
    })
  })

  it('helt tillgodoreglerad PAID-avi återhämtas som informationsavi', async () => {
    const r = rig()
    r.rows[0]!.rentNotice.status = 'PAID'
    r.rows[0]!.payableAmount = new Prisma.Decimal(0)
    expect((await r.scheduler.recoverPending(NOW)).queued).toBe(1)
    expect(r.queue.enqueue).toHaveBeenCalledTimes(1)
  })

  const blockCases: Array<[string, (row: Row) => void]> = [
    [
      'senare bankbetald PAID-avi',
      (row) => {
        row.rentNotice.status = 'PAID'
      },
    ],
    [
      'makulerad avi',
      (row) => {
        row.rentNotice.status = 'CANCELLED'
      },
    ],
    [
      'öppningsavi',
      (row) => {
        row.rentNotice.status = 'OPENING'
      },
    ],
    [
      'anonymiserad hyresgäst',
      (row) => {
        row.rentNotice.tenant.anonymizedAt = NOW
      },
    ],
    [
      'stängd mejlventil',
      (row) => {
        row.rentNotice.organization.transactionalEmailsDisabled = true
      },
    ],
    [
      'pausat bolag',
      (row) => {
        row.rentNotice.organization.status = 'SUSPENDED'
      },
    ],
    [
      'avslutat bolag',
      (row) => {
        row.rentNotice.organization.status = 'CANCELLED'
      },
    ],
  ]

  it.each(blockCases)(
    'påbörjat utan kvitto + %s larmar utan nytt utskick',
    async (_label, block) => {
      const r = rig()
      r.rows[0]!.dispatchStartedAt = at(-0.5)
      block(r.rows[0]!)
      expect(await r.scheduler.recoverPending(NOW)).toMatchObject({ queued: 0, unknown: 1 })
      expect(r.queue.enqueue).not.toHaveBeenCalled()
      expect(r.sink.report).toHaveBeenCalledTimes(1)
      expect(r.rows[0]!.recoveryAfter).toEqual(at(24))
    },
  )

  it.each(blockCases)('ostartat + %s ligger utanför urvalet', async (_label, block) => {
    const r = rig()
    block(r.rows[0]!)
    expect(await r.scheduler.recoverPending(NOW)).toMatchObject({
      selected: 0,
      queued: 0,
      unknown: 0,
    })
    expect(r.queue.enqueue).not.toHaveBeenCalled()
    expect(r.sink.report).not.toHaveBeenCalled()
    expect(r.rows[0]!.recoveryAfter).toBeNull()
  })

  it('stängd mejlventil mellan läsning och claim köar inte ens ett PDF-jobb', async () => {
    const r = rig()
    r.rows[0]!.dispatchStartedAt = at(-0.5)
    r.beforeClaim(() => {
      r.rows[0]!.rentNotice.organization.transactionalEmailsDisabled = true
    })
    expect(await r.scheduler.recoverPending(NOW)).toMatchObject({ queued: 0 })
    expect(r.queue.enqueue).not.toHaveBeenCalled()
  })

  it('två samtidiga svep får ett anspråk och ett PDF-jobb', async () => {
    const r = rig()
    const outcomes = await Promise.all([
      r.scheduler.recoverPending(NOW),
      r.newScheduler().recoverPending(NOW),
    ])
    expect(outcomes.map((x) => x.queued).sort()).toEqual([0, 1])
    expect(r.rows[0]!.recoveryAttempts).toBe(1)
    expect(r.queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('kvittot som kom mellan läsning och claim stoppar återförsöket', async () => {
    const r = rig()
    r.beforeClaim(() => {
      r.rows[0]!.acceptedAt = NOW
    })
    const result = await r.scheduler.recoverPending(NOW)
    expect(result.queued).toBe(0)
    expect(r.rows[0]!.recoveryAttempts).toBe(0)
    expect(r.queue.enqueue).not.toHaveBeenCalled()
  })

  it('providerstart som ändrades efter läsningen bedöms vid ett nytt pass', async () => {
    const r = rig()
    r.beforeClaim(() => {
      r.rows[0]!.dispatchStartedAt = NOW
    })
    await r.scheduler.recoverPending(NOW)
    expect(r.queue.enqueue).not.toHaveBeenCalled()
    expect(r.rows[0]!.recoveryAfter).toBeNull()
  })

  it('Redis-fel behåller pausen över omstart, isoleras och använder samma avi vid nytt försök', async () => {
    const r = rig(2)
    jest.mocked(r.queue.enqueue).mockRejectedValueOnce(new Error('synthetic-redis-outage'))
    const result = await r.scheduler.recoverPending(NOW)
    expect(result).toMatchObject({ queued: 1, failed: 1 })
    expect(r.sink.report).toHaveBeenCalledWith(
      'notice-dispatch-recovery',
      expect.objectContaining({ message: 'synthetic-redis-outage' }),
      { organizationId: 'org-synthetic', detail: { sendId: 'send-000', rentNoticeId: 'notice-0' } },
    )
    r.clock(at(0.25))
    expect((await r.newScheduler().recoverPending(at(0.25))).queued).toBe(0)
    r.clock(at(1))
    expect((await r.newScheduler().recoverPending(at(1))).queued).toBe(2)
    expect(r.rows[0]!.recoveryAfter).toEqual(at(5))
    expect(r.queue.enqueue).toHaveBeenNthCalledWith(3, {
      kind: 'avisering-send',
      organizationId: 'org-synthetic',
      noticeId: 'notice-0',
    })
  })

  it('bestående problem bromsas till dagligen och blir synliga i felsänkan', async () => {
    const r = rig()
    await r.scheduler.recoverPending(NOW)
    r.clock(at(1))
    await r.scheduler.recoverPending(at(1))
    r.clock(at(5))
    await r.scheduler.recoverPending(at(5))
    expect(r.rows[0]!.recoveryAfter).toEqual(at(29))
    expect(r.sink.report).toHaveBeenCalledTimes(1)
    expect(jest.mocked(r.sink.report).mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('upprepade återhämtningsförsök'),
      }),
    )
    r.clock(at(5.25))
    await r.newScheduler().recoverPending(at(5.25))
    expect(r.queue.enqueue).toHaveBeenCalledTimes(3)
    expect(r.sink.report).toHaveBeenCalledTimes(1)
    r.clock(at(29))
    await r.newScheduler().recoverPending(at(29))
    expect(r.queue.enqueue).toHaveBeenCalledTimes(4)
    expect(r.rows[0]!.recoveryAfter).toEqual(at(53))
  })

  it.each([23, 48])('okänt leveransutfall efter %s timmar larmas utan blind retry', async (age) => {
    const r = rig()
    r.rows[0]!.preparedAt = at(-age - 1)
    r.rows[0]!.dispatchStartedAt = at(-age)
    const result = await r.scheduler.recoverPending(NOW)
    expect(result).toMatchObject({ queued: 0, unknown: 1 })
    expect(r.rows[0]!.recoveryAfter).toEqual(at(24))
    expect(r.queue.enqueue).not.toHaveBeenCalled()
    expect(r.sink.report).toHaveBeenCalledTimes(1)
    expect(jest.mocked(r.sink.report).mock.calls[0]![1]).toEqual(
      expect.objectContaining({ message: expect.stringContaining('leveransutfall är okänt') }),
    )
    r.clock(at(0.25))
    await r.newScheduler().recoverPending(at(0.25))
    expect(r.sink.report).toHaveBeenCalledTimes(1)
  })

  it('en start inom 23-timmarsfönstret återanvänder den reserverade avin', async () => {
    const r = rig()
    r.rows[0]!.preparedAt = at(-24)
    r.rows[0]!.dispatchStartedAt = new Date(NOW.getTime() - 23 * HOUR + 1)
    expect((await r.scheduler.recoverPending(NOW)).queued).toBe(1)
    expect(r.sink.report).not.toHaveBeenCalled()
  })

  it('taket 100 blockerar inte resten bakom samma permanent misslyckade rader', async () => {
    const r = rig(NOTICE_DISPATCH_RECOVERY_BATCH + 3)
    jest.mocked(r.queue.enqueue).mockRejectedValue(new Error('synthetic-pdf-queue-outage'))
    expect(await r.scheduler.recoverPending(NOW)).toMatchObject({
      selected: 100,
      failed: 100,
      limitReached: true,
    })
    r.clock(at(0.25))
    expect(await r.scheduler.recoverPending(at(0.25))).toMatchObject({
      selected: 3,
      failed: 3,
      limitReached: false,
    })
    expect(r.rows.every((row) => row.recoveryAttempts === 1)).toBe(true)
    expect(r.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        orderBy: [
          { recoveryAfter: { sort: 'asc', nulls: 'first' } },
          { preparedAt: 'asc' },
          { id: 'asc' },
        ],
      }),
    )
  })

  it('ett DB-fel på claim rapporteras, och senare rader kan fortfarande köas', async () => {
    const r = rig(2)
    r.store.updateMany.mockRejectedValueOnce(new Error('synthetic-claim-failure'))
    expect(await r.scheduler.recoverPending(NOW)).toMatchObject({ queued: 1, failed: 1 })
    expect(r.sink.report).toHaveBeenCalledTimes(1)
    expect(r.rows[0]!.recoveryAttempts).toBe(0)
    expect(r.rows[1]!.recoveryAttempts).toBe(1)
  })

  it('fel redan vid första läsningen når runCronSafely och den beständiga sänkan', async () => {
    const r = rig()
    r.store.findMany.mockRejectedValueOnce(new Error('synthetic-read-failure'))
    await expect(r.scheduler.recoverPreparedNotices()).resolves.toBeUndefined()
    expect(r.sink.report).toHaveBeenCalledWith(
      'notice-dispatch-recovery',
      expect.objectContaining({ message: 'synthetic-read-failure' }),
    )
    expect(r.queue.enqueue).not.toHaveBeenCalled()
  })
})
