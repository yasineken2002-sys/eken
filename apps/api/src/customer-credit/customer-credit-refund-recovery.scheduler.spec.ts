import type { CustomerCreditRefundState } from '@prisma/client'
import type { CronErrorSink } from '../common/cron/cron-error-sink'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { CustomerCreditRefundService } from './customer-credit-refund.service'
import {
  CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH,
  CustomerCreditRefundRecoveryScheduler,
} from './customer-credit-refund-recovery.scheduler'

const NOW = new Date('2026-10-16T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR)

type Row = {
  id: string
  organizationId: string
  state: CustomerCreditRefundState
  submissionStartedAt: Date | null
  recoveryAfter: Date | null
  recoveryAttempts: number
}

/** Stateful CAS-dubbel: inga bank- eller bokföringseffekter simuleras här. */
function rig(count = 1) {
  const rows: Row[] = Array.from({ length: count }, (_, index) => ({
    id: `refund-${String(index).padStart(3, '0')}`,
    organizationId: `org-${index % 2}`,
    state: 'UNKNOWN',
    submissionStartedAt: at(-1),
    recoveryAfter: null,
    recoveryAttempts: 0,
  }))
  let now = NOW
  let beforeClaim: (() => void) | undefined
  const eligible = (row: Row) =>
    ['SUBMITTING', 'UNKNOWN', 'BANK_CONFIRMED'].includes(row.state) &&
    row.submissionStartedAt !== null &&
    row.submissionStartedAt.getTime() <= now.getTime() - HOUR / 4 &&
    (!row.recoveryAfter || row.recoveryAfter <= now)
  const store = {
    findMany: jest.fn(async ({ take }: { take: number }) =>
      rows
        .filter(eligible)
        .sort(
          (a, b) =>
            (a.recoveryAfter?.getTime() ?? 0) - (b.recoveryAfter?.getTime() ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, take)
        .map((row) => ({ ...row })),
    ),
    updateMany: jest.fn(
      async (args: {
        where: {
          id: string
          organizationId: string
          state: CustomerCreditRefundState
          submissionStartedAt: Date | null
          recoveryAttempts: number
        }
        data: { recoveryAfter: Date; recoveryAttempts: { increment: number } }
      }) => {
        beforeClaim?.()
        const row = rows.find((candidate) => candidate.id === args.where.id)!
        if (
          !eligible(row) ||
          row.organizationId !== args.where.organizationId ||
          row.state !== args.where.state ||
          row.submissionStartedAt?.getTime() !== args.where.submissionStartedAt?.getTime() ||
          row.recoveryAttempts !== args.where.recoveryAttempts
        )
          return { count: 0 }
        row.recoveryAfter = args.data.recoveryAfter
        row.recoveryAttempts += args.data.recoveryAttempts.increment
        return { count: 1 }
      },
    ),
  }
  const recover = jest.fn(async (_input: { organizationId: string; refundId: string }) => ({
    state: 'UNKNOWN' as CustomerCreditRefundState,
  }))
  const submit = jest.fn()
  const sink = { report: jest.fn(async () => undefined) }
  const prisma = { customerCreditRefund: store } as unknown as PrismaService
  const service = {
    recoverRefund: recover,
    submitRefund: submit,
  } as unknown as CustomerCreditRefundService
  const scheduler = () =>
    new CustomerCreditRefundRecoveryScheduler(prisma, service, sink as unknown as CronErrorSink)
  return {
    rows,
    store,
    recover,
    submit,
    sink,
    scheduler,
    clock: (time: Date) => {
      now = time
    },
    beforeClaim: (callback: () => void) => {
      beforeClaim = callback
    },
  }
}

describe('beständig uppföljning av påbörjade tillgodoåterbetalningar', () => {
  it('frågar endast efter påbörjade utfall, oberoende av senare policy/orgspärr', async () => {
    const r = rig()
    await r.scheduler().recoverPending(NOW)
    const where = {
      state: { in: ['SUBMITTING', 'UNKNOWN', 'BANK_CONFIRMED'] },
      submissionStartedAt: { lte: new Date('2026-10-16T11:45:00.000Z') },
      OR: [{ recoveryAfter: null }, { recoveryAfter: { lte: NOW } }],
    }
    expect(r.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, take: CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH }),
    )
    expect(r.store.updateMany).toHaveBeenCalledWith({
      where: {
        AND: [where],
        id: r.rows[0]!.id,
        organizationId: 'org-0',
        state: 'UNKNOWN',
        submissionStartedAt: at(-1),
        recoveryAttempts: 0,
      },
      data: { recoveryAfter: at(1), recoveryAttempts: { increment: 1 } },
    })
    expect(r.recover).toHaveBeenCalledWith({
      organizationId: 'org-0',
      refundId: r.rows[0]!.id,
    })
    expect(r.submit).not.toHaveBeenCalled()
  })

  it('två instanser får tillsammans bara ett anspråk och en bankkontroll', async () => {
    const r = rig()
    await Promise.all([r.scheduler().recoverPending(NOW), r.scheduler().recoverPending(NOW)])
    expect(r.recover).toHaveBeenCalledTimes(1)
    expect(r.rows[0]!.recoveryAttempts).toBe(1)
  })

  it.each(['SETTLED', 'REJECTED', 'CANCELLED'] as const)(
    'en samtidig övergång till %s stoppar en gammal kandidat',
    async (state) => {
      const r = rig()
      r.beforeClaim(() => {
        r.rows[0]!.state = state
      })
      await r.scheduler().recoverPending(NOW)
      expect(r.recover).not.toHaveBeenCalled()
      expect(r.rows[0]!.recoveryAttempts).toBe(0)
    },
  )

  it.each(['RESERVED', 'SETTLED', 'REJECTED', 'CANCELLED'] as const)(
    '%s orsakar aldrig nytt bankanrop',
    async (state) => {
      const r = rig()
      r.rows[0]!.state = state
      await r.scheduler().recoverPending(NOW)
      expect(r.recover).not.toHaveBeenCalled()
      expect(r.submit).not.toHaveBeenCalled()
    },
  )

  it('väntar minst femton minuter efter start och kräver förfallen återhämtning', async () => {
    const r = rig(3)
    r.rows[0]!.submissionStartedAt = new Date(NOW.getTime() - 14 * 60 * 1000)
    r.rows[1]!.submissionStartedAt = null
    r.rows[2]!.recoveryAfter = at(1)
    const result = await r.scheduler().recoverPending(NOW)
    expect(result.selected).toBe(0)
    expect(r.recover).not.toHaveBeenCalled()
  })

  it('sparar paus före bankkontroll även vid timeout och fortsätter till nästa organisation', async () => {
    const r = rig(2)
    const timeout = new Error('BANK_LOOKUP_UNAVAILABLE')
    r.recover.mockImplementationOnce(async () => {
      expect(r.rows[0]!.recoveryAfter).toEqual(at(1))
      expect(r.rows[0]!.recoveryAttempts).toBe(1)
      throw timeout
    })
    const result = await r.scheduler().recoverPending(NOW)
    expect(result).toMatchObject({ failed: 1, pending: 1 })
    expect(r.recover).toHaveBeenCalledTimes(2)
    expect(r.sink.report).toHaveBeenCalledWith('customer-credit-refund-recovery', timeout, {
      organizationId: 'org-0',
      detail: { refundId: r.rows[0]!.id },
    })
    await r.scheduler().recoverPending(NOW)
    expect(r.recover).toHaveBeenCalledTimes(2)
    expect(r.submit).not.toHaveBeenCalled()
  })

  it('behåller okänt saldo och backar 1 h, 4 h och därefter 24 h även efter omstart', async () => {
    const r = rig()
    await r.scheduler().recoverPending(NOW)
    expect(r.rows[0]!.recoveryAfter).toEqual(at(1))
    r.clock(at(1))
    await r.scheduler().recoverPending(at(1))
    expect(r.rows[0]!.recoveryAfter).toEqual(at(5))
    r.clock(at(5))
    await r.scheduler().recoverPending(at(5))
    expect(r.rows[0]!.recoveryAfter).toEqual(at(29))
    expect(r.rows[0]!.state).toBe('UNKNOWN')
    expect(r.sink.report).toHaveBeenCalledTimes(1)
    r.clock(at(29))
    await r.scheduler().recoverPending(at(29))
    expect(r.rows[0]!.recoveryAfter).toEqual(at(53))
    expect(r.submit).not.toHaveBeenCalled()
  })

  it.each(['SETTLED', 'REJECTED'] as const)('redovisar verifierat slututfall %s', async (state) => {
    const r = rig()
    r.recover.mockResolvedValueOnce({ state })
    const result = await r.scheduler().recoverPending(NOW)
    expect(result).toMatchObject({ recovered: 1, pending: 0, failed: 0 })
  })

  it('ett fullt pass tränger inte undan de kvarvarande raderna vid nästa pass', async () => {
    const r = rig(CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH + 1)
    const first = await r.scheduler().recoverPending(NOW)
    const second = await r.scheduler().recoverPending(NOW)
    expect(first).toMatchObject({ selected: 100, limitReached: true })
    expect(second).toMatchObject({ selected: 1, limitReached: false })
    expect(new Set(r.recover.mock.calls.map(([input]) => input.refundId)).size).toBe(101)
  })
})
