/**
 * Automatisk tillgodoanvändning och beständigt utskicksunderlag mot Postgres.
 * Varje prov skapar egen syntetisk organisation. Ingen riktig mejlkö,
 * betalning eller PDF-tjänst anropas, och ekonomiska provrader bevaras.
 */
import { createHash, randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { runWithActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { claimLegacyNoticeDispatch } from '../mail/legacy-notice-dispatch'

import {
  fixture,
  receive,
  services,
  isIsolatedDatabase,
  type Fixture,
} from './customer-credit-dispatch.test-fixtures'

jest.setTimeout(30_000)

const ISOLATED = isIsolatedDatabase()
const medDb = ISOLATED ? describe : describe.skip
const Decimal = Prisma.Decimal

function preparation(f: Fixture) {
  const buildSnapshot = jest.fn(async (tx: Prisma.TransactionClient) => {
    const target = await tx.rentNotice.findUniqueOrThrow({
      where: { id: f.target.id },
      include: { payments: true },
    })
    const used = target.payments.reduce((sum, p) => sum.plus(p.amount), new Decimal(0))
    return {
      snapshot: {
        version: 1,
        html: '<html><body>Syntetiskt betalningsunderlag</body></html>',
        to: 'syntetisk@example.invalid',
        tenantName: 'Syntetisk hyresgäst',
        organizationName: 'Syntetisk organisation',
        noticeNumber: target.noticeNumber,
        ocrNumber: target.ocrNumber,
        dueDate: target.dueDate.toISOString(),
        accentColor: null,
        payableAmount: target.totalAmount.minus(used).toNumber(),
        customerCreditAmount: used.toNumber(),
      },
      toHash: createHash('sha256').update('syntetisk@example.invalid').digest('hex'),
    }
  })
  return { organizationId: f.organizationId, rentNoticeId: f.target.id, buildSnapshot }
}

async function financialState(
  prisma: PrismaService,
  organizationId: string,
  options: { includeSends?: boolean } = {},
): Promise<string> {
  return JSON.stringify(
    await Promise.all([
      prisma.customerCreditApplication.findMany({
        where: { organizationId },
        orderBy: { id: 'asc' },
      }),
      prisma.rentNoticePayment.findMany({
        where: { rentNotice: { organizationId } },
        orderBy: { id: 'asc' },
      }),
      prisma.rentNotice.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
      options.includeSends === false
        ? []
        : prisma.rentNoticeSend.findMany({
            where: { rentNotice: { organizationId } },
            orderBy: { id: 'asc' },
          }),
      prisma.journalEntry.findMany({
        where: { organizationId },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { id: 'asc' } } },
      }),
      prisma.journalEntrySequence.findMany({
        where: { organizationId },
        orderBy: [{ series: 'asc' }, { fiscalYear: 'asc' }],
      }),
    ]),
  )
}

/** Två riktiga transaktioner måste vara öppna innan någon service får fortsätta. */
function transactionBarrier() {
  let entered = 0
  let release: () => void = () => undefined
  const bothEntered = new Promise<void>((resolve) => {
    release = resolve
  })
  function wrap(prisma: PrismaService): PrismaService {
    return new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver)
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: typeof PAYMENT_TX_LIMITS,
        ) =>
          target.$transaction(async (tx) => {
            entered++
            if (entered === 2) release()
            let timer: NodeJS.Timeout | undefined
            try {
              await Promise.race([
                bothEntered,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('Två transaktioner öppnades aldrig')),
                    4000,
                  )
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
            return callback(tx)
          }, options)
      },
    })
  }
  return { wrap, entered: () => entered }
}

medDb('tillgodo och sparat utskicksunderlag i samma commit', () => {
  let prisma: PrismaService
  const others: PrismaService[] = []
  beforeAll(async () => {
    if (!ISOLATED) throw new Error('Kräver uttryckligt isolerad testdatabas')
    prisma = new PrismaService()
    await prisma.$connect()
  })
  afterAll(async () => {
    await Promise.all(others.map((other) => other.$disconnect()))
    await prisma?.$disconnect()
  })

  it('använder 25 kr och sparar samma 975 kr i underlag och bokförd skuld', async () => {
    const f = await fixture(prisma)
    await receive(prisma, f)
    const input = preparation(f)
    const send = await runWithActor('SYSTEM', () =>
      services(prisma).credit.prepareNoticeForSend(input),
    )
    expect(send).toMatchObject({
      kind: 'NOTICE',
      snapshotVersion: 1,
      dispatchKey: `customer-credit-notice:${f.target.id}`,
      snapshot: { payableAmount: 975, customerCreditAmount: 25 },
    })
    expect(send?.customerCreditAmount?.toFixed(2)).toBe('25.00')
    expect(send?.payableAmount?.toFixed(2)).toBe('975.00')
    const application = await prisma.customerCreditApplication.findFirstOrThrow({
      where: { rentNoticeId: f.target.id },
    })
    expect(application.appliedAt).toEqual(send?.preparedAt)
    expect(application.actorKind).toBe('SYSTEM')
    expect(application.requestId).toContain(send!.id)
    expect(input.buildSnapshot).toHaveBeenCalledTimes(1)
  })

  it('återanvänder helt reglerad avi efter att policyn stängts av utan andra avräkningen', async () => {
    const f = await fixture(prisma, { targetAmount: '25.00' })
    await receive(prisma, f)
    const input = preparation(f)
    const send = await runWithActor('SYSTEM', () =>
      services(prisma).credit.prepareNoticeForSend(input),
    )
    expect(send?.payableAmount?.toFixed(2)).toBe('0.00')
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })).status).toBe(
      'PAID',
    )
    await prisma.customerCreditPolicy.update({
      where: { organizationId: f.organizationId },
      data: { enabled: false, carryForwardEnabled: false },
    })
    const before = await financialState(prisma, f.organizationId)
    const replay = await services(prisma).credit.prepareNoticeForSend(input)
    expect(replay?.id).toBe(send?.id)
    expect(input.buildSnapshot).toHaveBeenCalledTimes(1)
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it('reserverar även 0 kr tillgodo och stoppar senare avräkning mot det utgivna underlaget', async () => {
    const f = await fixture(prisma)
    const send = await runWithActor('SYSTEM', () =>
      services(prisma).credit.prepareNoticeForSend(preparation(f)),
    )
    expect(send?.customerCreditAmount?.toFixed(2)).toBe('0.00')
    expect(send?.payableAmount?.toFixed(2)).toBe('1000.00')
    const credit = await receive(prisma, f)
    await expect(
      runWithActor('SYSTEM', () =>
        services(prisma).credit.applyToNextNotice({
          organizationId: f.organizationId,
          creditId: credit.id,
          rentNoticeId: f.target.id,
          requestId: randomUUID(),
          amount: new Decimal(25),
          appliedAt: new Date(),
        }),
      ),
    ).rejects.toThrow('redan förberett')
    expect(
      await prisma.customerCreditApplication.count({ where: { rentNoticeId: f.target.id } }),
    ).toBe(0)
  })

  it.each(['PENDING', 'FAILED', 'OVERDUE'] as const)(
    'försenad %s-avi utan tillgodo reserveras med oförändrat belopp och ekonomi',
    async (status) => {
      const f = await fixture(prisma)
      await prisma.rentNotice.update({
        where: { id: f.target.id },
        data: { status, dueDate: new Date(Date.now() - 24 * 60 * 60_000) },
      })
      const before = await financialState(prisma, f.organizationId, { includeSends: false })
      const input = preparation(f)
      const send = await runWithActor('SYSTEM', () =>
        services(prisma).credit.prepareNoticeForSend(input),
      )
      expect(send).toMatchObject({
        dispatchKey: `customer-credit-notice:${f.target.id}`,
        snapshot: { payableAmount: 1000, customerCreditAmount: 0 },
      })
      expect(send?.customerCreditAmount?.toFixed(2)).toBe('0.00')
      expect(send?.payableAmount?.toFixed(2)).toBe('1000.00')
      expect(input.buildSnapshot).toHaveBeenCalledTimes(1)
      expect(await prisma.rentNoticeSend.count({ where: { rentNoticeId: f.target.id } })).toBe(1)
      expect(
        await prisma.customerCreditApplication.count({
          where: { organizationId: f.organizationId },
        }),
      ).toBe(0)
      expect(await financialState(prisma, f.organizationId, { includeSends: false })).toBe(before)
    },
  )

  it.each(['PENDING', 'FAILED', 'OVERDUE'] as const)(
    'försenad %s-avi med tillgängligt tillgodo nekas utan reservation eller ekonomiska ändringar',
    async (status) => {
      const f = await fixture(prisma)
      await receive(prisma, f)
      await prisma.rentNotice.update({
        where: { id: f.target.id },
        data: { status, dueDate: new Date(Date.now() - 24 * 60 * 60_000) },
      })
      const before = await financialState(prisma, f.organizationId)
      const input = preparation(f)
      await expect(
        runWithActor('SYSTEM', () => services(prisma).credit.prepareNoticeForSend(input)),
      ).rejects.toThrow('oförändrat betalningsunderlag')
      expect(input.buildSnapshot).not.toHaveBeenCalled()
      expect(await financialState(prisma, f.organizationId)).toBe(before)
    },
  )

  it('rullar tillbaka tillgodo, avistatus och verifikat om underlaget inte kan byggas', async () => {
    const f = await fixture(prisma, { targetAmount: '25.00' })
    await receive(prisma, f)
    const before = await financialState(prisma, f.organizationId)
    const input = preparation(f)
    input.buildSnapshot.mockRejectedValueOnce(new Error('syntetiskt snapshotfel'))
    await expect(
      runWithActor('SYSTEM', () => services(prisma).credit.prepareNoticeForSend(input)),
    ).rejects.toThrow('syntetiskt snapshotfel')
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it.each(['belopp', 'mottagarhash'] as const)(
    'fel %s i callbackunderlaget rullar tillbaka även tillgodo och bokföring',
    async (fel) => {
      const f = await fixture(prisma)
      await receive(prisma, f)
      const before = await financialState(prisma, f.organizationId)
      const input = preparation(f)
      const build = input.buildSnapshot.getMockImplementation()!
      input.buildSnapshot.mockImplementationOnce(async (tx) => {
        const result = await build(tx)
        return fel === 'belopp'
          ? { ...result, snapshot: { ...result.snapshot, payableAmount: 1000 } }
          : { ...result, toHash: 'a'.repeat(64) }
      })
      await expect(
        runWithActor('SYSTEM', () => services(prisma).credit.prepareNoticeForSend(input)),
      ).rejects.toThrow('giltigt sparat underlag')
      expect(await financialState(prisma, f.organizationId)).toBe(before)
    },
  )

  it('stängd policy ger null och skriver inget utskicksunderlag', async () => {
    const f = await fixture(prisma, { carry: false })
    await receive(prisma, f)
    const before = await financialState(prisma, f.organizationId)
    const input = preparation(f)
    expect(await services(prisma).credit.prepareNoticeForSend(input)).toBeNull()
    expect(input.buildSnapshot).not.toHaveBeenCalled()
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it('aktiv tillgodopolicy förändrar inte depositionsavins utskick', async () => {
    const f = await fixture(prisma)
    await prisma.rentNotice.update({ where: { id: f.target.id }, data: { type: 'DEPOSIT' } })
    const before = await financialState(prisma, f.organizationId)
    const input = preparation(f)
    expect(await services(prisma).credit.prepareNoticeForSend(input)).toBeNull()
    expect(input.buildSnapshot).not.toHaveBeenCalled()
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it('ett påbörjat äldre aviutskick fryser beloppet innan den nya vägen hinner förbereda', async () => {
    const f = await fixture(prisma)
    await receive(prisma, f)
    await prisma.rentNoticeSend.create({
      data: { rentNoticeId: f.target.id, kind: 'NOTICE', jobId: 'syntetiskt-legacy-utskick' },
    })
    const before = await financialState(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () => services(prisma).credit.prepareNoticeForSend(preparation(f))),
    ).rejects.toThrow('tidigare betalningsunderlag')
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it('osäker kandidat faller stängt när avin redan har en manuell delbetalning', async () => {
    const f = await fixture(prisma)
    await receive(prisma, f)
    await runWithActor('SYSTEM', () =>
      prisma.rentNoticePayment.create({
        data: { rentNoticeId: f.target.id, amount: 10, paidAt: new Date(), source: 'MANUAL' },
      }),
    )
    const before = await financialState(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () => services(prisma).credit.prepareNoticeForSend(preparation(f))),
    ).rejects.toThrow('oförändrat betalningsunderlag')
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it('bankdata som inte längre är färsk stoppar hela förberedelsen', async () => {
    const f = await fixture(prisma)
    await receive(prisma, f)
    await prisma.organization.update({
      where: { id: f.organizationId },
      data: { paymentDataThrough: new Date('2020-01-01T00:00:00Z') },
    })
    const before = await financialState(prisma, f.organizationId)
    await expect(
      runWithActor('SYSTEM', () => services(prisma).credit.prepareNoticeForSend(preparation(f))),
    ).rejects.toThrow()
    expect(await financialState(prisma, f.organizationId)).toBe(before)
  })

  it('beständigt underlag kan inte flyttas, byta belopp eller byta mottagarhash', async () => {
    const f = await fixture(prisma)
    await receive(prisma, f)
    const send = await runWithActor('SYSTEM', () =>
      services(prisma).credit.prepareNoticeForSend(preparation(f)),
    )
    if (!send) throw new Error('Syntetiskt utskick saknas')
    const changes: Prisma.RentNoticeSendUpdateInput[] = [
      { snapshot: { version: 1, payableAmount: 1000 } },
      { payableAmount: 1000 },
      { customerCreditAmount: 0 },
      { toHash: 'a'.repeat(64) },
      { preparedAt: new Date(send.preparedAt!.getTime() + 1) },
      { dispatchKey: null },
    ]
    for (const data of changes) {
      await expect(prisma.rentNoticeSend.update({ where: { id: send.id }, data })).rejects.toThrow(
        'CUSTOMER_CREDIT_DISPATCH_IMMUTABLE',
      )
    }
    expect(await services(prisma).credit.findPreparedNotice(f.organizationId, f.target.id)).toEqual(
      send,
    )
  })

  it('återhämtningsprogress får flyttas men negativa försök och legacyåterhämtning avvisas', async () => {
    const f = await fixture(prisma)
    const send = await runWithActor('SYSTEM', () =>
      services(prisma).credit.prepareNoticeForSend(preparation(f)),
    )
    if (!send) throw new Error('Syntetiskt utskick saknas')
    expect(send).toMatchObject({ recoveryAfter: null, recoveryAttempts: 0 })
    for (const attempts of [1, 2]) {
      const recoveryAfter = new Date(send.preparedAt!.getTime() + attempts * 15 * 60_000)
      const updated = await prisma.rentNoticeSend.update({
        where: { id: send.id },
        data: { recoveryAttempts: attempts, recoveryAfter },
      })
      expect(updated).toMatchObject({
        recoveryAfter,
        recoveryAttempts: attempts,
        snapshot: send.snapshot,
        preparedAt: send.preparedAt,
        dispatchKey: send.dispatchKey,
        toHash: send.toHash,
      })
      expect(updated.customerCreditAmount).toEqual(send.customerCreditAmount)
      expect(updated.payableAmount).toEqual(send.payableAmount)
    }
    await expect(
      prisma.rentNoticeSend.update({
        where: { id: send.id },
        data: { recoveryAttempts: -1 },
      }),
    ).rejects.toThrow('customer_credit_notice_dispatch_recovery_shape')

    const legacy = await prisma.rentNoticeSend.create({
      data: { rentNoticeId: f.target.id, kind: 'REMINDER' },
    })
    const invalidLegacy: Prisma.RentNoticeSendUpdateInput[] = [
      { recoveryAttempts: 1 },
      { recoveryAfter: new Date() },
    ]
    for (const data of invalidLegacy) {
      await expect(
        prisma.rentNoticeSend.update({ where: { id: legacy.id }, data }),
      ).rejects.toThrow('customer_credit_notice_dispatch_recovery_shape')
    }
    expect(await prisma.rentNoticeSend.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(
      legacy,
    )
  })

  it('mailpayload och kvittenser kan sättas en gång och samma värden kan återspelas', async () => {
    const f = await fixture(prisma)
    const send = await runWithActor('SYSTEM', () =>
      services(prisma).credit.prepareNoticeForSend(preparation(f)),
    )
    if (!send) throw new Error('Syntetiskt utskick saknas')
    const now = new Date()
    const data = {
      mailPayload: { version: 1, synthetic: true },
      queuedAt: now,
      dispatchStartedAt: now,
      acceptedAt: now,
      messageId: `synthetic-${randomUUID()}`,
    }
    await prisma.rentNoticeSend.update({ where: { id: send.id }, data })
    await prisma.rentNoticeSend.update({ where: { id: send.id }, data })
    await expect(
      prisma.rentNoticeSend.update({
        where: { id: send.id },
        data: { mailPayload: { version: 2 } },
      }),
    ).rejects.toThrow('CUSTOMER_CREDIT_DISPATCH_ACK_IMMUTABLE')
    await expect(
      prisma.rentNoticeSend.update({ where: { id: send.id }, data: { acceptedAt: null } }),
    ).rejects.toThrow('CUSTOMER_CREDIT_DISPATCH_ACK_IMMUTABLE')
  })

  it('två klienter som förbereder samma avi får samma reservation och en avräkning', async () => {
    const f = await fixture(prisma)
    await receive(prisma, f)
    const other = new PrismaService()
    others.push(other)
    await other.$connect()
    const input = preparation(f)
    const barrier = transactionBarrier()
    const sends = await runWithActor('SYSTEM', () =>
      Promise.all([
        services(barrier.wrap(prisma)).credit.prepareNoticeForSend(input),
        services(barrier.wrap(other)).credit.prepareNoticeForSend(input),
      ]),
    )
    expect(sends[0]?.id).toBe(sends[1]?.id)
    expect(
      await prisma.customerCreditApplication.count({ where: { rentNoticeId: f.target.id } }),
    ).toBe(1)
    expect(await prisma.rentNoticeSend.count({ where: { rentNoticeId: f.target.id } })).toBe(1)
    expect(input.buildSnapshot).toHaveBeenCalledTimes(1)
  })

  it('äldre utskicksanspråk och tillgodoreservation kan inte båda vinna ett verkligt race', async () => {
    const f = await fixture(prisma)
    const credit = await receive(prisma, f)
    const [journalCountBefore, targetBefore] = await Promise.all([
      prisma.journalEntry.count({ where: { organizationId: f.organizationId } }),
      prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } }),
    ])
    const other = new PrismaService()
    others.push(other)
    await other.$connect()
    const input = preparation(f)
    const legacyJobId = `syntetiskt-legacy-race-${randomUUID()}`
    const barrier = transactionBarrier()
    const [prepared, legacy] = await runWithActor('SYSTEM', () =>
      Promise.allSettled([
        services(barrier.wrap(prisma)).credit.prepareNoticeForSend(input),
        claimLegacyNoticeDispatch(
          barrier.wrap(other),
          f.organizationId,
          f.target.id,
          'syntetisk@example.invalid',
          legacyJobId,
        ),
      ]),
    )
    expect(barrier.entered()).toBe(2)
    if (legacy.status !== 'fulfilled') throw legacy.reason

    const [sends, applications, payments, journalCountAfter, target] = await Promise.all([
      prisma.rentNoticeSend.findMany({ where: { rentNoticeId: f.target.id } }),
      prisma.customerCreditApplication.findMany({ where: { rentNoticeId: f.target.id } }),
      prisma.rentNoticePayment.findMany({ where: { rentNoticeId: f.target.id } }),
      prisma.journalEntry.count({ where: { organizationId: f.organizationId } }),
      prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } }),
    ])
    const reservationWon = prepared.status === 'fulfilled' && prepared.value !== null
    expect([legacy.value, reservationWon].filter(Boolean)).toHaveLength(1)
    expect(sends).toHaveLength(1)
    expect(sends[0]?.kind).toBe('NOTICE')
    expect(sends[0]?.acceptedAt).toBeNull()

    if (legacy.value) {
      if (prepared.status !== 'rejected') {
        throw new Error('Tillgodoreservationen måste avvisas när äldre utskick har vunnit')
      }
      expect(prepared.reason).toBeInstanceOf(ConflictException)
      expect(prepared.reason.message).toBe(
        'Avins tidigare betalningsunderlag har redan börjat skickas',
      )
      expect(sends[0]).toMatchObject({ dispatchKey: null, jobId: legacyJobId, snapshot: null })
      expect(applications).toEqual([])
      expect(payments).toEqual([])
      expect(journalCountAfter).toBe(journalCountBefore)
      expect(target).toEqual(targetBefore)
      expect(input.buildSnapshot).not.toHaveBeenCalled()
    } else {
      if (prepared.status !== 'fulfilled' || !prepared.value) {
        throw new Error('En ny reservation måste finnas när det äldre utskicket nekas')
      }
      expect(sends[0]).toMatchObject({
        id: prepared.value.id,
        dispatchKey: `customer-credit-notice:${f.target.id}`,
        jobId: null,
        snapshot: { payableAmount: 975, customerCreditAmount: 25 },
      })
      expect(applications).toHaveLength(1)
      expect(applications[0]?.creditId).toBe(credit.id)
      expect(applications[0]?.amount.toFixed(2)).toBe('25.00')
      expect(payments).toHaveLength(1)
      expect(payments[0]?.source).toBe('CUSTOMER_CREDIT')
      expect(payments[0]?.amount.toFixed(2)).toBe('25.00')
      expect(journalCountAfter).toBe(journalCountBefore + 1)
      expect(prepared.value.payableAmount?.toFixed(2)).toBe('975.00')
      expect(input.buildSnapshot).toHaveBeenCalledTimes(1)
    }
  })
})
