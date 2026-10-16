/** Riktig isolerad DB/bokföring. Bankbeskeden är syntetiska; inga nätverksanrop. */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { RentNotice } from '@prisma/client'
import { runWithActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { paymentFreshnessTransactionOptions } from '../payment-freshness/payment-freshness.service'
import { isIsolatedDatabase, notice } from './customer-credit-dispatch.test-fixtures'
import type { CustomerCreditRefundBankObservation } from './customer-credit-refund-bank.port'
import {
  digest,
  prepareNotice,
  refundFixture,
  rejected,
} from './customer-credit-refund.test-fixtures'

// Läsningen mäter rollback i testerna, den allokerar aldrig verifikationsnummer.
async function accountingSnapshot(prisma: PrismaService, organizationId: string) {
  return JSON.stringify(
    await Promise.all([
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

jest.setTimeout(30_000)
const ISOLATED = isIsolatedDatabase()
const medDb = ISOLATED ? describe : describe.skip
const human = <T>(run: () => T) => runWithActor('HUMAN', run)
const system = <T>(run: () => T) => runWithActor('SYSTEM', run)
type Scenario = Awaited<ReturnType<typeof refundFixture>>
type Release = 'CANCELLED' | 'REJECTED'

it('frigivningsproven kräver en uttryckligt isolerad databas även om sviten annars hoppas över', () => {
  expect(ISOLATED).toBe(true)
})

/** Ordinarie allokering och verkligt betalningsverifikat, utan något nytt tillgodo. */
async function payNotice(
  prisma: PrismaService,
  r: Scenario,
  target: RentNotice,
  amount = '1000.00',
  paidAt = new Date(Date.now() - 120_000),
) {
  return system(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${target.id} AND "organizationId" = ${r.f.organizationId} FOR UPDATE`
      const bank = await tx.bankTransaction.create({
        data: {
          organizationId: r.f.organizationId,
          bankAccountId: r.f.bankAccountId,
          description: `SYNTETISK ordinarie hyra ${randomUUID()}`,
          amount: new Prisma.Decimal(amount),
          date: paidAt,
          status: 'MATCHED',
          matchedRentNoticeId: target.id,
          matchedAt: new Date(),
        },
      })
      const allocation = await tx.rentNoticePayment.create({
        data: {
          rentNoticeId: target.id,
          bankTransactionId: bank.id,
          amount: new Prisma.Decimal(amount),
          paidAt,
          source: 'BANK_RECONCILIATION',
        },
      })
      const journal = await r.accounting.createJournalEntryForRentNoticePayment(
        target,
        { id: bank.id, date: paidAt, amount: new Prisma.Decimal(amount) },
        r.f.organizationId,
        null,
        tx,
        allocation.id,
      )
      if (!journal) throw new Error('Mellanavin måste få ett verkligt betalningsverifikat')
      await tx.rentNotice.update({
        where: { id: target.id },
        data: {
          status: target.totalAmount.eq(amount) ? 'PAID' : 'SENT',
          paidAmount: new Prisma.Decimal(amount),
          paidAt,
        },
      })
    }, paymentFreshnessTransactionOptions(PAYMENT_TX_LIMITS)),
  )
}

async function nextNotice(prisma: PrismaService, r: Scenario, fixtureMonth = 11) {
  const target = await system(() =>
    notice(
      prisma,
      { organizationId: r.f.organizationId, tenantId: r.f.tenantId, leaseId: r.f.leaseId },
      fixtureMonth,
    ),
  )
  // Nästa månads avi får skapas i dag. Ett framtida createdAt skulle testa fel spärr.
  return prisma.rentNotice.update({
    where: { id: target.id },
    data: { createdAt: new Date(Date.now() - 60_000) },
  })
}

async function reserveAndPrepareMiddle(r: Scenario) {
  const reserved = await r.reserve()
  const middle = await system(() => r.credits.prepareNoticeForSend(prepareNotice(r.f)))
  expect(middle?.customerCreditAmount?.toFixed(2)).toBe('0.00')
  expect(middle?.payableAmount?.toFixed(2)).toBe('1000.00')
  return { reserved, middle }
}

async function release(r: Scenario, refundId: string, kind: Release) {
  if (kind === 'CANCELLED') return human(() => r.refund.cancelRefund(r.scope(refundId)))
  r.bank.send.mockImplementation(async (instruction) => rejected(instruction))
  return human(() => r.refund.submitRefund(r.scope(refundId)))
}

medDb('frigivet kundtillgodo efter en helt reserverad mellanavi', () => {
  const prisma = new PrismaService()
  beforeAll(() => prisma.$connect())
  afterAll(() => prisma.$disconnect())

  it.each(['CANCELLED', 'REJECTED'] as const)(
    '%s: fullbetald mellanavi tillåter nästa månads avdrag och oförändrad replay',
    async (kind) => {
      const r = await refundFixture(prisma)
      const { reserved, middle } = await reserveAndPrepareMiddle(r)
      expect((await release(r, reserved.id, kind)).state).toBe(kind)
      await payNotice(prisma, r, r.f.target)
      const target = await nextNotice(prisma, r)
      const request = prepareNotice({ ...r.f, target })
      const prepared = await system(() => r.credits.prepareNoticeForSend(request))
      expect(prepared?.customerCreditAmount?.toFixed(2)).toBe('25.00')
      expect(prepared?.payableAmount?.toFixed(2)).toBe('975.00')
      const beforeReplay = await accountingSnapshot(prisma, r.f.organizationId)
      expect((await system(() => r.credits.prepareNoticeForSend(request)))?.id).toBe(prepared?.id)
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(beforeReplay)
      const applications = await prisma.customerCreditApplication.findMany({
        where: { creditId: r.credit.id },
      })
      expect(applications).toHaveLength(1)
      expect(applications[0]!.rentNoticeId).toBe(target.id)
      expect(applications[0]!.amount.toFixed(2)).toBe('25.00')
      const original = await prisma.rentNoticeSend.findUniqueOrThrow({ where: { id: middle!.id } })
      expect(original.snapshot).toEqual(middle!.snapshot)
      expect(original.customerCreditAmount?.toFixed(2)).toBe('0.00')
      expect(original.payableAmount?.toFixed(2)).toBe('1000.00')
    },
  )

  const blockedCases = [
    'kvarskuld',
    'saknad månad',
    'annullerad avi',
    'befarad förlust',
    'framtida betalning',
  ] as const
  it.each(
    (['CANCELLED', 'REJECTED'] as const).flatMap((kind) =>
      blockedCases.map((reason) => ({ kind, reason })),
    ),
  )(
    '$kind: $reason ger ingen avräkning eller utskicksreservation på senare avi',
    async ({ kind, reason }) => {
      const r = await refundFixture(prisma)
      const { reserved } = await reserveAndPrepareMiddle(r)
      await release(r, reserved.id, kind)
      if (reason === 'annullerad avi') {
        // Historiskt terminalt underlag: ingen kundfordran får hoppas över via en saknad giltig avi.
        await prisma.rentNotice.update({
          where: { id: r.f.target.id },
          data: { status: 'CANCELLED' },
        })
      } else {
        await payNotice(
          prisma,
          r,
          r.f.target,
          reason === 'kvarskuld' ? '999.99' : '1000.00',
          reason === 'framtida betalning' ? new Date(Date.now() + 60 * 60_000) : undefined,
        )
        if (reason === 'befarad förlust') {
          // Avsiktlig negativ fixture: även en PAID-spegel får inte dölja förlusthistorik.
          await prisma.rentNotice.update({
            where: { id: r.f.target.id },
            data: { probableLossAt: new Date(Date.now() - 60_000) },
          })
        }
      }
      const target = await nextNotice(prisma, r, reason === 'saknad månad' ? 12 : 11)
      const before = await accountingSnapshot(prisma, r.f.organizationId)
      await expect(
        system(() => r.credits.prepareNoticeForSend(prepareNotice({ ...r.f, target }))),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
      expect(
        await prisma.customerCreditApplication.count({ where: { creditId: r.credit.id } }),
      ).toBe(0)
      expect(await prisma.rentNoticeSend.count({ where: { rentNoticeId: target.id } })).toBe(0)
    },
  )

  it('UNKNOWN håller hela beloppet reserverat även när mellanavin är fullt betald', async () => {
    const r = await refundFixture(prisma)
    const { reserved } = await reserveAndPrepareMiddle(r)
    expect((await human(() => r.refund.submitRefund(r.scope(reserved.id)))).state).toBe('UNKNOWN')
    await payNotice(prisma, r, r.f.target)
    const target = await nextNotice(prisma, r)
    const prepared = await system(() =>
      r.credits.prepareNoticeForSend(prepareNotice({ ...r.f, target })),
    )
    expect(prepared?.customerCreditAmount?.toFixed(2)).toBe('0.00')
    expect(prepared?.payableAmount?.toFixed(2)).toBe('1000.00')
    expect(await prisma.customerCreditApplication.count({ where: { creditId: r.credit.id } })).toBe(
      0,
    )
    expect(
      (await prisma.customerCreditRefund.findUniqueOrThrow({ where: { id: reserved.id } })).state,
    ).toBe('UNKNOWN')
    await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
  })

  it.each(['CANCELLED', 'REJECTED'] as const)(
    '%s får inte frigöra saldo i en bakdaterad avräkning före frigivningen',
    async (kind) => {
      const r = await refundFixture(prisma)
      const { reserved } = await reserveAndPrepareMiddle(r)
      await payNotice(prisma, r, r.f.target)
      const released = await release(r, reserved.id, kind)
      const releasedAt = released.cancelledAt ?? released.rejectedAt!
      const target = await nextNotice(prisma, r)
      const before = await accountingSnapshot(prisma, r.f.organizationId)
      await expect(
        system(() =>
          r.credits.applyToNextNotice({
            organizationId: r.f.organizationId,
            creditId: r.credit.id,
            rentNoticeId: target.id,
            requestId: randomUUID(),
            amount: new Prisma.Decimal(25),
            appliedAt: new Date(releasedAt.getTime() - 1),
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
      expect(
        await prisma.customerCreditApplication.count({ where: { creditId: r.credit.id } }),
      ).toBe(0)
      expect(
        (
          await system(() => r.credits.prepareNoticeForSend(prepareNotice({ ...r.f, target })))
        )?.customerCreditAmount?.toFixed(2),
      ).toBe('25.00')
    },
  )

  it('en slutbetald mellanavi räcker inte ensam utan en frigiven återbetalningsreservation', async () => {
    const r = await refundFixture(prisma)
    await payNotice(prisma, r, r.f.target)
    const target = await nextNotice(prisma, r)
    await expect(
      system(() => r.credits.prepareNoticeForSend(prepareNotice({ ...r.f, target }))),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(await prisma.customerCreditApplication.count({ where: { creditId: r.credit.id } })).toBe(
      0,
    )
  })

  it.each(['senare kontrolltid', 'ändrad orsak', 'ändrat bevis'] as const)(
    'två redan påbörjade bankuppslag: %s efter det första avslaget',
    async (variant) => {
      const r = await refundFixture(prisma)
      const reserved = await r.reserve()
      const unknown = await human(() => r.refund.submitRefund(r.scope(reserved.id)))
      const accountingBefore = await accountingSnapshot(prisma, r.f.organizationId)
      let firstResolve!: (value: CustomerCreditRefundBankObservation) => void
      let secondResolve!: (value: CustomerCreditRefundBankObservation) => void
      let firstStarted!: () => void
      let bothStarted!: () => void
      const firstReply = new Promise<CustomerCreditRefundBankObservation>((resolve) => {
        firstResolve = resolve
      })
      const secondReply = new Promise<CustomerCreditRefundBankObservation>((resolve) => {
        secondResolve = resolve
      })
      const firstEntered = new Promise<void>((resolve) => {
        firstStarted = resolve
      })
      const started = new Promise<void>((resolve) => {
        bothStarted = resolve
      })
      let calls = 0
      r.bank.read.mockImplementation(async () => {
        calls++
        if (calls === 1) firstStarted()
        if (calls === 2) bothStarted()
        return calls === 1 ? firstReply : secondReply
      })
      const first = system(() => r.refund.recoverRefund(r.scope(reserved.id)))
      await firstEntered
      const second = system(() => r.refund.recoverRefund(r.scope(reserved.id)))
      // Fäst felhanteringen innan något svar släpps; båda anropen har läst UNKNOWN.
      const secondResult = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await started
      expect(r.bank.send).toHaveBeenCalledTimes(1)
      const observation = rejected(r.bank.send.mock.calls[0]![0])
      if (observation.kind !== 'VERIFIED_NOT_EXECUTED')
        throw new Error('Testet kräver definitivt avslag')
      observation.verifiedAt = unknown.submissionStartedAt!
      firstResolve(observation)
      const firstStored = await first
      expect(firstStored.state).toBe('REJECTED')
      secondResolve({
        ...observation,
        verifiedAt: new Date(),
        ...(variant === 'ändrad orsak' ? { reasonCode: 'BANK_CANCELLED' as const } : {}),
        ...(variant === 'ändrat bevis'
          ? { evidenceHash: digest('annat syntetiskt bankunderlag') }
          : {}),
      })
      const result = await secondResult
      if (variant === 'senare kontrolltid') expect(result).toHaveProperty('value.state', 'REJECTED')
      else {
        expect(result).toHaveProperty('error')
        if ('error' in result) expect(result.error).toBeInstanceOf(ConflictException)
      }
      const stored = await prisma.customerCreditRefund.findUniqueOrThrow({
        where: { id: reserved.id },
      })
      expect(stored.rejectionEvidence).toEqual(firstStored.rejectionEvidence)
      expect(stored.rejectionProofHash).toBe(firstStored.rejectionProofHash)
      expect(
        await prisma.customerCreditRefundEvent.count({
          where: { refundId: reserved.id, type: 'REJECTED' },
        }),
      ).toBe(1)
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(accountingBefore)
      const newReservation = await r.reserve()
      expect(newReservation.amount.toFixed(2)).toBe('25.00')
      await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
      expect(r.bank.send).toHaveBeenCalledTimes(1)
    },
  )
})
