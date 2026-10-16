/** Riktig isolerad DB/bokföring, endast syntetisk bank. Bevisrader bevaras efter provet. */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { randomUUID } from 'node:crypto'
import { ConflictException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { CustomerCreditRefund } from '@prisma/client'
import { runWithActor } from '../common/actor/actor.context'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'
import { anonymizeTenantWithin } from '../common/gdpr/anonymize-tenant'
import { findTenantHistory } from '../common/gdpr/tenant-history'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { HISTORY_SOURCES } from '../history/history-sources.registry'
import { deleteOrganizations } from '../scripts/delete-organization'
import { TenantPortalService } from '../tenant-portal/tenant-portal.service'
import { isIsolatedDatabase } from './customer-credit-dispatch.test-fixtures'
import type { CustomerCreditRefundBankObservation } from './customer-credit-refund-bank.port'
import {
  booked,
  digest,
  holdFirstCommit,
  observeTransactionStart,
  prepareNotice,
  refundFixture,
  refundServices,
  rejected,
  syntheticDestination,
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

it('återbetalningsproven kräver en uttryckligt isolerad databas även om sviten annars hoppas över', () => {
  expect(ISOLATED).toBe(true)
})

const human = <T>(run: () => T) => runWithActor('HUMAN', run)
const system = <T>(run: () => T) => runWithActor('SYSTEM', run)

function portal(prisma: PrismaService) {
  type Dependencies = ConstructorParameters<typeof TenantPortalService>
  function unused<T extends object>(): T {
    return new Proxy({} as T, {
      get: () => {
        throw new Error('Exporten får inte anropa externa tjänster')
      },
    })
  }
  return new TenantPortalService(
    prisma,
    testPersonalNumberService(),
    unused<Dependencies[2]>(),
    unused<Dependencies[3]>(),
    unused<Dependencies[4]>(),
    unused<Dependencies[5]>(),
    unused<Dependencies[6]>(),
  )
}

async function stored(prisma: PrismaService, id: string) {
  return prisma.customerCreditRefund.findUniqueOrThrow({ where: { id } })
}

/** Direktskrivning utan domäntjänsten, för att mäta DB-spärren separat. */
async function insertClone(
  db: PrismaService | Prisma.TransactionClient,
  row: CustomerCreditRefund,
  amount: string,
  changes: Partial<CustomerCreditRefund> = {},
) {
  const id = randomUUID()
  const data = JSON.stringify({
    ...row,
    id,
    requestId: id,
    requestHash: digest(`request:${id}`),
    instructionHash: digest(`instruction:${id}`),
    amount,
    ...changes,
  })
  return db.$executeRaw`INSERT INTO "CustomerCreditRefund"
    SELECT (jsonb_populate_record(NULL::"CustomerCreditRefund", ${data}::jsonb)).*`
}

medDb('kundtillgodoåterbetalning, bankbevis och oföränderlig reskontra', () => {
  const prisma = new PrismaService()
  const other = new PrismaService()
  beforeAll(async () => {
    await prisma.$connect()
    await other.$connect()
  })
  afterAll(async () => {
    await prisma.$disconnect()
    await other.$disconnect()
  })

  it('reserverar utan bokning, lagrar bankfact och bokför först vid separat bekräftelse', async () => {
    const r = await refundFixture(prisma)
    const before = await accountingSnapshot(prisma, r.f.organizationId)
    const requestId = randomUUID()
    const reserved = await r.reserve('25.00', requestId)
    expect(reserved.state).toBe('RESERVED')
    expect(reserved.actorKind).toBe('HUMAN')
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
    expect(r.bank.send).not.toHaveBeenCalled()
    expect((await r.reserve('25.00', requestId)).id).toBe(reserved.id)
    await expect(r.reserve('24.00', requestId)).rejects.toBeInstanceOf(ConflictException)

    r.bank.send.mockImplementation(async (i) => booked(i))
    const confirmed = await human(() => r.refund.submitRefund(r.scope(reserved.id)))
    expect(confirmed.state).toBe('BANK_CONFIRMED')
    expect(confirmed.bankProofHash).not.toBeNull()
    expect(confirmed.bankConfirmedAt).not.toBeNull()
    expect(confirmed.journalEntryId).toBeNull()
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)

    const done = await system(() => r.refund.postConfirmedRefund(r.scope(reserved.id)))
    expect(done.state).toBe('SETTLED')
    expect(done.journalEntryId).not.toBeNull()
    const journal = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: done.journalEntryId! },
      include: { lines: true },
    })
    expect(journal.sourceId).toBe(`customer-credit-refund:${done.id}`)
    expect(journal.lines).toHaveLength(2)
    expect(
      journal.lines.find((line) => line.accountId === r.f.liabilityAccountId)?.debit?.toFixed(2),
    ).toBe('25.00')
    expect(journal.lines.find((line) => line.accountId === r.ledger.id)?.credit?.toFixed(2)).toBe(
      '25.00',
    )
    const after = await accountingSnapshot(prisma, r.f.organizationId)
    await system(() => r.refund.postConfirmedRefund(r.scope(reserved.id)))
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(after)
    expect(r.bank.send).toHaveBeenCalledTimes(1)
    expect(
      await prisma.customerCreditRefundEvent.count({
        where: { refundId: done.id, type: 'SETTLED' },
      }),
    ).toBe(1)
  })

  it('låter tidigare delanvändning lämna återbetalningsbar rest, men aldrig mer', async () => {
    const r = await refundFixture(prisma, { targetAmount: '10.00' })
    await system(() => r.credits.prepareNoticeForSend(prepareNotice(r.f)))
    const reserved = await r.reserve('15.00')
    expect(reserved.amount.toFixed(2)).toBe('15.00')
    await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
    expect(await prisma.customerCreditApplication.count({ where: { creditId: r.credit.id } })).toBe(
      1,
    )
  })

  it('avvisar noll, minus, subören och överbelopp utan reservation eller verifikat', async () => {
    const r = await refundFixture(prisma)
    const before = await accountingSnapshot(prisma, r.f.organizationId)
    for (const amount of ['0', '-1', '0.001', '25.01']) {
      await expect(r.reserve(amount)).rejects.toThrow()
    }
    expect(await prisma.customerCreditRefund.count({ where: { creditId: r.credit.id } })).toBe(0)
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
    expect(r.bank.send).not.toHaveBeenCalled()
  })

  it.each(['refund-first', 'notice-first'] as const)(
    'två öppna transaktioner: %s mot samtidig automatisk aviavräkning',
    async (order) => {
      const r = await refundFixture(prisma)
      const held = holdFirstCommit(prisma)
      const observed = observeTransactionStart(other)
      const firstService = refundServices(held.prisma, r.bank)
      const secondService = refundServices(observed.prisma, r.bank)
      const reserve = (s: typeof firstService) =>
        human(() =>
          s.refund.reserveRefund({
            organizationId: r.f.organizationId,
            creditId: r.credit.id,
            requestId: randomUUID(),
            amount: new Prisma.Decimal(25),
          }),
        )
      const prepare = (s: typeof firstService) =>
        system(() => s.credit.prepareNoticeForSend(prepareNotice(r.f)))
      const first = order === 'refund-first' ? reserve(firstService) : prepare(firstService)
      const firstResult = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await Promise.race([
        held.reached,
        first.then(() => {
          throw new Error('Ingen transaktion hölls')
        }),
      ])
      const second = order === 'refund-first' ? prepare(secondService) : reserve(secondService)
      const secondResult = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      try {
        await observed.reached
      } finally {
        held.release()
      }
      const outcomes = await Promise.all([firstResult, secondResult])
      expect(outcomes[0]).not.toHaveProperty('error')
      if (order === 'notice-first') expect(outcomes[1]).toHaveProperty('error')
      else expect(outcomes[1]).not.toHaveProperty('error')
      const refunds = await prisma.customerCreditRefund.findMany({
        where: { creditId: r.credit.id },
      })
      const applications = await prisma.customerCreditApplication.findMany({
        where: { creditId: r.credit.id },
      })
      const reserved = refunds.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))
      const used = applications.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))
      expect(reserved.plus(used).toFixed(2)).toBe('25.00')
      const dispatch = await prisma.rentNoticeSend.findFirstOrThrow({
        where: { rentNoticeId: r.f.target.id, dispatchKey: { not: null } },
      })
      expect(dispatch.customerCreditAmount?.toFixed(2)).toBe(
        order === 'refund-first' ? '0.00' : '25.00',
      )
      expect(dispatch.payableAmount?.toFixed(2)).toBe(
        order === 'refund-first' ? '1000.00' : '975.00',
      )
    },
  )

  it('två samtidiga återbetalningsbegäranden kan inte reservera samma öre', async () => {
    const r = await refundFixture(prisma)
    const secondService = refundServices(other, r.bank)
    const results = await Promise.allSettled([
      r.reserve(),
      human(() =>
        secondService.refund.reserveRefund({
          organizationId: r.f.organizationId,
          creditId: r.credit.id,
          requestId: randomUUID(),
          amount: new Prisma.Decimal(25),
        }),
      ),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await prisma.customerCreditRefund.count({ where: { creditId: r.credit.id } })).toBe(1)
  })

  it('samtidig submit efter SUBMITTING gör bara lookup, behåller saldot och bokför banksvaret en gång', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve()
    const secondService = refundServices(other, r.bank)
    const before = await accountingSnapshot(prisma, r.f.organizationId)
    let entered!: () => void
    let resume!: () => void
    const inBank = new Promise<void>((resolve) => {
      entered = resolve
    })
    const releaseBank = new Promise<void>((resolve) => {
      resume = resolve
    })
    r.bank.send.mockImplementation(async (instruction) => {
      entered()
      await releaseBank
      return booked(instruction)
    })
    const first = human(() => r.refund.submitRefund(r.scope(reserved.id)))
    const firstResult = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await Promise.race([
        inBank,
        firstResult.then(() => {
          throw new Error('Första återbetalningen nådde aldrig den blockerade bankporten')
        }),
      ])
      expect((await stored(other, reserved.id)).state).toBe('SUBMITTING')
      await expect(
        human(() => secondService.refund.cancelRefund(r.scope(reserved.id))),
      ).rejects.toBeInstanceOf(ConflictException)
      const second = await human(() => secondService.refund.submitRefund(r.scope(reserved.id)))
      expect(second.state).toBe('UNKNOWN')
      expect(second.submissionStartedAt).not.toBeNull()
      expect(second.journalEntryId).toBeNull()
      expect(r.bank.send).toHaveBeenCalledTimes(1)
      expect(r.bank.read).toHaveBeenCalledTimes(1)
      expect(r.bank.read.mock.calls[0]![0]).toEqual(r.bank.send.mock.calls[0]![0])
      await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
    } finally {
      resume()
      // Släpp alltid porten och invänta DB-arbetet, även om ett motprov ovan faller.
      await firstResult
    }
    const outcome = await firstResult
    if ('error' in outcome) throw outcome.error
    expect(outcome.value.state).toBe('BANK_CONFIRMED')
    expect(outcome.value.journalEntryId).toBeNull()
    await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)

    const settled = await system(() => secondService.refund.recoverRefund(r.scope(reserved.id)))
    expect(settled.state).toBe('SETTLED')
    expect(settled.journalEntryId).not.toBeNull()
    const after = await accountingSnapshot(prisma, r.f.organizationId)
    expect((await system(() => r.refund.recoverRefund(r.scope(reserved.id)))).journalEntryId).toBe(
      settled.journalEntryId,
    )
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(after)
    await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
    expect(r.bank.send).toHaveBeenCalledTimes(1)
    expect(r.bank.read).toHaveBeenCalledTimes(1)
    expect(
      await prisma.customerCreditRefundEvent.count({
        where: { refundId: reserved.id, type: 'SUBMITTING' },
      }),
    ).toBe(1)
    expect(
      await prisma.customerCreditRefundEvent.count({
        where: { refundId: reserved.id, type: 'SETTLED' },
      }),
    ).toBe(1)
    expect(
      await prisma.journalEntry.count({
        where: {
          organizationId: r.f.organizationId,
          sourceId: `customer-credit-refund:${reserved.id}`,
        },
      }),
    ).toBe(1)
  })

  it('timeout efter bankaccept lämnar UNKNOWN och recovery använder bara samma instruktion via lookup', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve()
    r.bank.send.mockRejectedValueOnce(new Error('HEMLIG-RAW-BANKTEXT'))
    const attempt = human(() => r.refund.submitRefund(r.scope(reserved.id)))
    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(attempt).rejects.not.toThrow('HEMLIG')
    expect((await stored(prisma, reserved.id)).state).toBe('UNKNOWN')
    await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
    await expect(human(() => r.refund.cancelRefund(r.scope(reserved.id)))).rejects.toBeInstanceOf(
      ConflictException,
    )
    const firstInstruction = r.bank.send.mock.calls[0]![0]
    for (const kind of ['NOT_FOUND', 'PENDING', 'UNKNOWN'] as const) {
      r.bank.read.mockResolvedValueOnce({ kind, instructionId: reserved.id })
      const still = await system(() => r.refund.recoverRefund(r.scope(reserved.id)))
      expect(still.state).toBe('UNKNOWN')
      expect(still.bankProofHash).toBeNull()
    }
    r.bank.read.mockImplementation(async (i) => booked(i))
    const recovered = await system(() => r.refund.recoverRefund(r.scope(reserved.id)))
    expect(recovered.state).toBe('SETTLED')
    expect(r.bank.send).toHaveBeenCalledTimes(1)
    expect(
      r.bank.read.mock.calls.every(([i]) => JSON.stringify(i) === JSON.stringify(firstInstruction)),
    ).toBe(true)
  })

  it.each(['cancel', 'rejected'] as const)(
    '%s frigör reservationen exakt en gång utan verifikat',
    async (outcome) => {
      const r = await refundFixture(prisma)
      const before = await accountingSnapshot(prisma, r.f.organizationId)
      const reserved = await r.reserve()
      if (outcome === 'cancel') {
        await human(() => r.refund.cancelRefund(r.scope(reserved.id)))
        await human(() => r.refund.cancelRefund(r.scope(reserved.id)))
        expect(r.bank.send).not.toHaveBeenCalled()
      } else {
        r.bank.send.mockImplementation(async (i) => rejected(i))
        await human(() => r.refund.submitRefund(r.scope(reserved.id)))
      }
      expect((await stored(prisma, reserved.id)).state).toBe(
        outcome === 'cancel' ? 'CANCELLED' : 'REJECTED',
      )
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
      const next = await r.reserve()
      expect(next.amount.toFixed(2)).toBe('25.00')
    },
  )

  it.each([
    ['amount', '24.99'],
    ['organizationId', 'wrong-org'],
    ['tenantId', 'wrong-tenant'],
    ['bankAccountId', 'wrong-account'],
    ['providerAccountRef', 'wrong-provider-account'],
    ['recipientRef', 'wrong-recipient'],
    ['instructionHash', digest('wrong-instruction')],
    ['currency', 'EUR'],
  ])(
    'motsägande bankbekräftelse (%s) förbrukar aldrig bevis eller frigör pengar',
    async (field, value) => {
      const r = await refundFixture(prisma)
      const reserved = await r.reserve()
      const before = await accountingSnapshot(prisma, r.f.organizationId)
      r.bank.send.mockImplementation(
        async (i) => ({ ...booked(i), [field!]: value }) as CustomerCreditRefundBankObservation,
      )
      await expect(human(() => r.refund.submitRefund(r.scope(reserved.id)))).rejects.toBeInstanceOf(
        ConflictException,
      )
      const row = await stored(prisma, reserved.id)
      expect(row.state).toBe('UNKNOWN')
      expect(row.bankProofHash).toBeNull()
      expect(row.journalEntryId).toBeNull()
      expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
      await expect(r.reserve('0.01')).rejects.toBeInstanceOf(ConflictException)
    },
  )

  it('samma banktransaktion kan inte bekräfta två reservationer även med olika anropsnycklar', async () => {
    const r = await refundFixture(prisma)
    const a = await r.reserve('10.00')
    const b = await r.reserve('10.00')
    r.bank.send.mockImplementation(async (i) =>
      booked(i, { bankTransactionId: 'synthetic-same-bank-debit' }),
    )
    await human(() => r.refund.submitRefund(r.scope(a.id)))
    await expect(human(() => r.refund.submitRefund(r.scope(b.id)))).rejects.toThrow()
    expect((await stored(prisma, b.id)).bankProofHash).toBeNull()
    expect(
      await prisma.customerCreditRefund.count({
        where: { creditId: r.credit.id, state: 'BANK_CONFIRMED' },
      }),
    ).toBe(1)
  })

  it('sen bankfact kan bokföras efter policyoff och anonymisering utan ny submit', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve()
    await human(() => r.refund.submitRefund(r.scope(reserved.id)))
    await prisma.customerCreditPolicy.update({
      where: { organizationId: r.f.organizationId },
      data: { refundEnabled: false },
    })
    await prisma.$transaction((tx) =>
      anonymizeTenantWithin(tx, r.f.tenantId, r.f.organizationId, { performedById: null }),
    )
    r.bank.read.mockImplementation(async (i) => booked(i))
    const settled = await system(() => r.refund.recoverRefund(r.scope(reserved.id)))
    expect(settled.state).toBe('SETTLED')
    expect(r.bank.send).toHaveBeenCalledTimes(1)
    expect(
      await prisma.customerCreditRefundEvent.count({
        where: { refundId: reserved.id, type: 'SETTLED' },
      }),
    ).toBe(1)
  })

  it.each(['policy', 'account', 'tenant'] as const)(
    'ändrad %s före start stoppar banken och behåller reservationen',
    async (changed) => {
      const r = await refundFixture(prisma)
      const reserved = await r.reserve()
      if (changed === 'policy')
        await prisma.customerCreditPolicy.update({
          where: { organizationId: r.f.organizationId },
          data: { refundEnabled: false },
        })
      if (changed === 'account')
        await prisma.bankAccount.update({
          where: { id: r.f.bankAccountId },
          data: { isActive: false },
        })
      if (changed === 'tenant')
        await prisma.$transaction((tx) =>
          anonymizeTenantWithin(tx, r.f.tenantId, r.f.organizationId, { performedById: null }),
        )
      await expect(human(() => r.refund.submitRefund(r.scope(reserved.id)))).rejects.toThrow()
      expect((await stored(prisma, reserved.id)).state).toBe('RESERVED')
      expect(r.bank.send).not.toHaveBeenCalled()
    },
  )

  it('avstängd policy, främmande organisation och AGENT/okänd aktör kan inte reservera', async () => {
    const r = await refundFixture(prisma, { enabled: false })
    await expect(r.reserve()).rejects.toThrow()
    await prisma.customerCreditPolicy.update({
      where: { organizationId: r.f.organizationId },
      data: { refundEnabled: true },
    })
    const input = {
      organizationId: r.f.organizationId,
      creditId: r.credit.id,
      requestId: randomUUID(),
      amount: new Prisma.Decimal(25),
    }
    await expect(r.refund.reserveRefund(input)).rejects.toThrow()
    await expect(runWithActor('AGENT', () => r.refund.reserveRefund(input))).rejects.toThrow()
    await expect(
      human(() => r.refund.reserveRefund({ ...input, organizationId: randomUUID() })),
    ).rejects.toThrow()
    expect(await prisma.customerCreditRefund.count({ where: { creditId: r.credit.id } })).toBe(0)
    expect(r.bank.send).not.toHaveBeenCalled()
  })

  it('mottagarportens felaktiga org/kontobindning kan inte bli en reservation', async () => {
    const r = await refundFixture(prisma)
    r.bank.destination.mockImplementation(async (input) => ({
      ...syntheticDestination(input),
      bankAccountId: 'another-account',
    }))
    await expect(r.reserve()).rejects.toThrow()
    expect(await prisma.customerCreditRefund.count({ where: { creditId: r.credit.id } })).toBe(0)
  })

  it('bokföringsfel rullar tillbaka bokningen men bevarar bankfact för exakt en senare bokning', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve()
    r.bank.send.mockImplementation(async (i) => booked(i))
    const confirmed = await human(() => r.refund.submitRefund(r.scope(reserved.id)))
    const before = await accountingSnapshot(prisma, r.f.organizationId)
    const failure = jest
      .spyOn(r.accounting, 'createJournalEntryForCustomerCreditRefund')
      .mockRejectedValueOnce(new Error('Syntetiskt bokföringsfel'))
    try {
      await expect(
        system(() => r.refund.postConfirmedRefund(r.scope(reserved.id))),
      ).rejects.toThrow('Syntetiskt bokföringsfel')
    } finally {
      failure.mockRestore()
    }
    const retained = await stored(prisma, reserved.id)
    expect(retained.state).toBe('BANK_CONFIRMED')
    expect(retained.bankProofHash).toBe(confirmed.bankProofHash)
    expect(retained.bankConfirmedAt).toEqual(confirmed.bankConfirmedAt)
    expect(retained.journalEntryId).toBeNull()
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
    expect((await system(() => r.refund.postConfirmedRefund(r.scope(reserved.id)))).state).toBe(
      'SETTLED',
    )
    expect(r.bank.send).toHaveBeenCalledTimes(1)
  })

  it('SQL kan inte överspendera, ändra instruktionen, sätta SETTLED eller radera bevisrader', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve('5.00')
    await expect(insertClone(prisma, reserved, '20.01')).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "CustomerCreditRefund" SET amount = 6 WHERE id = ${reserved.id}`,
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "CustomerCreditRefund" SET "recipientRef" = 'changed' WHERE id = ${reserved.id}`,
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "CustomerCreditRefund" SET state = 'SETTLED' WHERE id = ${reserved.id}`,
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`DELETE FROM "CustomerCreditRefund" WHERE id = ${reserved.id}`,
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`DELETE FROM "CustomerCreditRefundEvent" WHERE "refundId" = ${reserved.id}`,
    ).rejects.toThrow()
    await expect(
      prisma.$executeRaw`UPDATE "CustomerCreditRefundEvent" SET type = 'SETTLED' WHERE "refundId" = ${reserved.id}`,
    ).rejects.toThrow()
    expect((await stored(prisma, reserved.id)).amount.toFixed(2)).toBe('5.00')
  })

  it('DB-spärren kräver READ COMMITTED även för en direkt SQL-reservation med ledigt saldo', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve('5.00')
    await expect(
      prisma.$transaction((tx) => insertClone(tx, reserved, '1.00'), {
        ...PAYMENT_TX_LIMITS,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      }),
    ).rejects.toThrow(/READ.?COMMITTED|READ_COMMITTED|isolation/i)
    expect(await prisma.customerCreditRefund.count({ where: { creditId: r.credit.id } })).toBe(1)
  })

  it('SQL kan inte byta tenant/kontobindning eller lägga en händelse under annan organisation', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve('5.00')
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: r.f.organizationId,
        type: 'INDIVIDUAL',
        firstName: 'Annan',
        lastName: 'Test',
        email: `${randomUUID()}@example.invalid`,
      },
    })
    const account = await prisma.bankAccount.create({
      data: { organizationId: r.f.organizationId, name: 'Annat syntetiskt konto' },
    })
    await expect(insertClone(prisma, reserved, '1.00', { tenantId: tenant.id })).rejects.toThrow()
    await expect(
      insertClone(prisma, reserved, '1.00', { bankAccountId: account.id }),
    ).rejects.toThrow()
    const org = await prisma.organization.create({
      data: {
        name: 'Annan syntetisk organisation',
        email: `${randomUUID()}@example.invalid`,
        street: 'Testgatan 2',
        postalCode: '11111',
        city: 'Teststad',
      },
    })
    await expect(
      prisma.customerCreditRefundEvent.create({
        data: {
          organizationId: org.id,
          refundId: reserved.id,
          type: 'RESERVED',
          occurredAt: new Date(),
        },
      }),
    ).rejects.toThrow()
    expect(await prisma.customerCreditRefund.count({ where: { creditId: r.credit.id } })).toBe(1)
  })

  it('direkt aviavräkning efter reservation nekas av databasen, inte bara tjänsten', async () => {
    const r = await refundFixture(prisma)
    await r.reserve()
    const journal = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: r.f.organizationId, sourceId: `rent-notice:${r.f.target.id}` },
    })
    await expect(
      prisma.customerCreditApplication.create({
        data: {
          organizationId: r.f.organizationId,
          creditId: r.credit.id,
          rentNoticeId: r.f.target.id,
          requestId: randomUUID(),
          requestHash: digest('synthetic-direct-sql'),
          journalEntryId: journal.id,
          amount: new Prisma.Decimal('0.01'),
          appliedAt: new Date(),
        },
      }),
    ).rejects.toThrow()
    expect(await prisma.customerCreditApplication.count({ where: { creditId: r.credit.id } })).toBe(
      0,
    )
  })

  it('bankfact/historik/export bevaras vid anonymisering och dev-purge vägrar före radering', async () => {
    const r = await refundFixture(prisma)
    const reserved = await r.reserve()
    r.bank.send.mockImplementation(async (i) => booked(i))
    await human(() => r.refund.submitRefund(r.scope(reserved.id)))
    const source = HISTORY_SOURCES.find((entry) => entry.key === 'customer-credit-refund')!
    const query = {
      prisma,
      organizationId: r.f.organizationId,
      subject: { kind: 'TENANT' as const, id: r.f.tenantId },
    }
    const historyBefore = await source.load(query)
    const exported = await portal(prisma).exportTenantData(r.f.tenantId)
    expect(exported.customerCreditRefunds[0]?.state).toBe('BANK_CONFIRMED')
    expect(exported.customerCreditRefunds[0]?.accountedAt).toBeNull()
    expect(JSON.stringify(exported.customerCreditRefunds)).not.toMatch(
      /recipientRef|providerAccountRef|bankProofHash|bankEvidence|instructionHash/,
    )
    const retainedBefore = await stored(prisma, reserved.id)
    await prisma.$transaction((tx) =>
      anonymizeTenantWithin(tx, r.f.tenantId, r.f.organizationId, { performedById: null }),
    )
    expect(await stored(prisma, reserved.id)).toEqual(retainedBefore)
    expect(await source.load(query)).toEqual(historyBefore)
    const historyTypes = await prisma.$transaction((tx) => findTenantHistory(tx, r.f.tenantId))
    expect(historyTypes).toContain('kundtillgodoåterbetalningar')
    const noRefundTenant = await prisma.tenant.create({
      data: {
        organizationId: r.f.organizationId,
        type: 'INDIVIDUAL',
        firstName: 'Annan',
        lastName: 'Syntetisk',
        email: `${randomUUID()}@example.invalid`,
      },
    })
    expect(
      (await portal(prisma).exportTenantData(noRefundTenant.id)).customerCreditRefunds,
    ).toEqual([])
    expect(
      await source.load({ ...query, subject: { kind: 'TENANT', id: noRefundTenant.id } }),
    ).toEqual([])
    const before = await accountingSnapshot(prisma, r.f.organizationId)
    await expect(deleteOrganizations(prisma, [r.f.organizationId])).rejects.toThrow(
      'innan några rader tas bort',
    )
    expect(await accountingSnapshot(prisma, r.f.organizationId)).toBe(before)
    expect(await prisma.tenant.findUnique({ where: { id: noRefundTenant.id } })).not.toBeNull()
    expect(await stored(prisma, reserved.id)).toEqual(retainedBefore)
  })
})
