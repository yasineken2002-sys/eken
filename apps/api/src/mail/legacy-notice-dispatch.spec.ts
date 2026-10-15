import { noticeRecipientHash } from '../avisering/notice-dispatch'
import type { PrismaService } from '../common/prisma/prisma.service'
import { claimLegacyNoticeDispatch } from './legacy-notice-dispatch'

const ORG = 'org-legacy'
const NOTICE = 'notice-legacy'
const TO = 'tenant@example.test'

type Send = {
  id: string
  kind: 'NOTICE'
  jobId: string | null
  dispatchKey: string | null
  toHash: string | null
}

/**
 * Stateful gränsprov: simulerar ändringen medan avilåset inväntas.
 * Verklig PostgreSQL-serialisering mäts av utskicksflödets DB-prov.
 */
function rig() {
  const state = { status: 'PENDING', exists: true, sends: [] as Send[] }
  const order: string[] = []
  const tx = {
    $queryRaw: jest.fn(async () => {
      order.push('lock')
      return [{ id: NOTICE }]
    }),
    rentNotice: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; organizationId: string } }) => {
        order.push('read')
        return state.exists && where.id === NOTICE && where.organizationId === ORG
          ? { status: state.status, sends: [...state.sends] }
          : null
      }),
    },
    rentNoticeSend: {
      create: jest.fn(
        async ({ data }: { data: { kind: 'NOTICE'; jobId: string; toHash: string } }) => {
          order.push('claim')
          const send: Send = { id: 'legacy-claim', dispatchKey: null, ...data }
          state.sends.push(send)
          return send
        },
      ),
    },
  }
  const prisma = {
    ...tx,
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaService
  return { state, order, tx, prisma }
}

describe('claimLegacyNoticeDispatch', () => {
  it('sparar gammalt utskicksanspråk efter låset utan mottagaradress eller påhittat kvitto', async () => {
    const r = rig()
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')).resolves.toBe(true)
    expect(r.order).toEqual(['lock', 'read', 'claim'])
    expect(r.tx.rentNoticeSend.create).toHaveBeenCalledWith({
      data: {
        rentNoticeId: NOTICE,
        kind: 'NOTICE',
        jobId: 'job-1',
        toHash: noticeRecipientHash(TO),
      },
    })
    expect(r.state.sends).toHaveLength(1)
  })

  it('samma jobb får retry, ett annat jobb får inte ta över anspråket', async () => {
    const r = rig()
    await claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')).resolves.toBe(true)
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-2')).resolves.toBe(false)
    expect(r.tx.rentNoticeSend.create).toHaveBeenCalledTimes(1)
  })

  it('samma jobb med ändrad mottagare får inte återanvända anspråket', async () => {
    const r = rig()
    await claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')
    await expect(
      claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, 'other@example.test', 'job-1'),
    ).resolves.toBe(false)
    expect(r.tx.rentNoticeSend.create).toHaveBeenCalledTimes(1)
  })

  it('en ny tillgodoreservation som vann avilåset stoppar gamla beloppet', async () => {
    const r = rig()
    r.tx.$queryRaw.mockImplementation(async () => {
      r.order.push('lock')
      r.state.sends.push({
        id: 'prepared',
        kind: 'NOTICE',
        dispatchKey: `customer-credit-notice:${NOTICE}`,
        jobId: null,
        toHash: noticeRecipientHash(TO),
      })
      return [{ id: NOTICE }]
    })
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')).resolves.toBe(false)
    expect(r.order).toEqual(['lock', 'read'])
    expect(r.tx.rentNoticeSend.create).not.toHaveBeenCalled()
  })

  it.each(['PAID', 'CANCELLED', 'OPENING'])(
    '%s efter låsväntan stoppar gammalt betalningskrav',
    async (status) => {
      const r = rig()
      r.tx.$queryRaw.mockImplementation(async () => {
        r.state.status = status
        return [{ id: NOTICE }]
      })
      await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')).resolves.toBe(
        false,
      )
      expect(r.tx.rentNoticeSend.create).not.toHaveBeenCalled()
    },
  )

  it('annan organisation får inget anspråk på avin', async () => {
    const r = rig()
    await expect(
      claimLegacyNoticeDispatch(r.prisma, 'other-org', NOTICE, TO, 'job-1'),
    ).resolves.toBe(false)
    expect(r.tx.rentNoticeSend.create).not.toHaveBeenCalled()
  })

  it('nekar tvetydiga äldre anspråk även om ett av jobben överensstämmer', async () => {
    const r = rig()
    r.state.sends = ['job-1', 'job-2'].map((jobId) => ({
      id: jobId,
      kind: 'NOTICE',
      dispatchKey: null,
      jobId,
      toHash: noticeRecipientHash(TO),
    }))
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')).resolves.toBe(false)
    expect(r.tx.rentNoticeSend.create).not.toHaveBeenCalled()
  })

  it('DB-fel och saknad jobbnyckel får inte döljas som lyckat utskick', async () => {
    const r = rig()
    r.tx.$queryRaw.mockRejectedValueOnce(new Error('synthetic-db-failure'))
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, 'job-1')).rejects.toThrow(
      'synthetic-db-failure',
    )
    await expect(claimLegacyNoticeDispatch(r.prisma, ORG, NOTICE, TO, '')).rejects.toThrow(
      'stabil jobbidentifierare',
    )
    expect(r.tx.rentNoticeSend.create).not.toHaveBeenCalled()
  })
})
