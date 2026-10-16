import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import { AccountingService } from './accounting.service'
import {
  CustomerCreditRefundBookedDebitSchema,
  customerCreditRefundBankProofHash,
} from '../customer-credit/customer-credit-refund-bank.port'

const bas = {
  organizationId: 'org-a',
  eventId: 'event-1',
  rentNoticeId: 'notice-1',
  bankTransactionId: 'bank-1',
  liabilityAccountId: 'liability-a',
  bankLedgerAccountId: 'bank-a',
  amount: new Prisma.Decimal('25.01'),
  date: new Date('2026-10-15T12:00:00Z'),
  createdById: 'user-1',
}

type Account = {
  id: string
  organizationId: string
  number: number
  type: 'ASSET' | 'LIABILITY'
  isActive: boolean
}

type Line = { accountId: string; debit?: number; credit?: number }
type Entry = {
  id: string
  organizationId: string
  source: string
  sourceId: string
  date: Date
  lines: { create: Line[] }
  reversedBy?: { id: string } | null
  reversalOfEntryId?: string | null
}

function rigg() {
  // Kontonumret för skulden är endast en testfixture, inget BAS-standardval.
  const accounts: Account[] = [
    { id: 'liability-a', organizationId: 'org-a', number: 2998, type: 'LIABILITY', isActive: true },
    { id: 'bank-a', organizationId: 'org-a', number: 1930, type: 'ASSET', isActive: true },
    { id: 'receivable-a', organizationId: 'org-a', number: 1510, type: 'ASSET', isActive: true },
  ]
  const entries: Entry[] = []
  const state = { accrual: true, accrualReversed: false }
  const proof = CustomerCreditRefundBookedDebitSchema.parse({
    kind: 'BOOKED_DEBIT',
    instructionId: bas.eventId,
    instructionHash: 'a'.repeat(64),
    organizationId: bas.organizationId,
    tenantId: 'tenant-a',
    bankAccountId: 'physical-bank-a',
    provider: 'synthetic-bank',
    providerAccountRef: 'opaque-bank-a',
    recipientRef: 'opaque-tenant-a',
    amount: bas.amount.toFixed(2),
    currency: 'SEK',
    providerTransferId: 'transfer-1',
    verifiedAt: new Date('2026-10-16T12:00:00Z'),
    evidenceHash: 'b'.repeat(64),
    bankTransactionId: bas.bankTransactionId,
    bankBookedAt: bas.date,
  })
  const refund = {
    id: bas.eventId,
    organizationId: bas.organizationId,
    tenantId: proof.tenantId,
    amount: bas.amount,
    currency: 'SEK',
    liabilityAccountId: bas.liabilityAccountId,
    bankAccountId: proof.bankAccountId,
    bankLedgerAccountId: bas.bankLedgerAccountId,
    provider: proof.provider,
    providerAccountRef: proof.providerAccountRef,
    recipientRef: proof.recipientRef,
    instructionHash: proof.instructionHash,
    state: 'BANK_CONFIRMED',
    bankEvidence: JSON.parse(JSON.stringify(proof)) as Prisma.JsonValue,
    bankProofHash: customerCreditRefundBankProofHash(proof),
    bankProofKey: JSON.stringify([
      proof.provider,
      proof.providerAccountRef,
      proof.bankTransactionId,
    ]),
    bankConfirmedAt: new Date('2026-10-16T12:05:00Z'),
    bankBookedAt: proof.bankBookedAt,
    bankTransactionId: proof.bankTransactionId,
    providerTransferId: proof.providerTransferId,
    journalEntryId: null as string | null,
    settledAt: null as Date | null,
    credit: { sourceRentNoticeId: bas.rentNoticeId },
  }
  const accountFind = jest.fn(
    (args: {
      where: {
        organizationId: string
        isActive: boolean
        OR: Array<{ id?: string; number?: number; type: string }>
      }
    }) =>
      Promise.resolve(
        accounts.filter(
          (a) =>
            a.organizationId === args.where.organizationId &&
            a.isActive === args.where.isActive &&
            args.where.OR.some(
              (q) =>
                a.type === q.type &&
                (q.id === undefined || a.id === q.id) &&
                (q.number === undefined || a.number === q.number),
            ),
        ),
      ),
  )
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: bas.eventId }]),
    customerCreditRefund: {
      findFirst: jest.fn(async (args: { where: { id: string; organizationId: string } }) =>
        args.where.id === refund.id && args.where.organizationId === refund.organizationId
          ? refund
          : null,
      ),
    },
    account: { findMany: accountFind },
    rentNotice: { findFirst: jest.fn().mockResolvedValue(null) },
    journalEntry: {
      findFirst: jest.fn(
        (args: { where: { organizationId: string; source: string; sourceId: string } }) => {
          if (args.where.source === 'INVOICE') {
            return Promise.resolve(
              state.accrual &&
                args.where.organizationId === 'org-a' &&
                args.where.sourceId === 'rent-notice:notice-1'
                ? {
                    id: 'accrual-1',
                    reversedBy: state.accrualReversed ? { id: 'accrual-reversal-1' } : null,
                  }
                : null,
            )
          }
          const entry = entries.find(
            (e) =>
              e.organizationId === args.where.organizationId &&
              e.source === args.where.source &&
              e.sourceId === args.where.sourceId,
          )
          return Promise.resolve(
            entry && args.where.sourceId.startsWith('customer-credit-refund:')
              ? { ...entry, lines: entry.lines.create }
              : (entry ?? null),
          )
        },
      ),
      create: jest.fn((args: { data: Omit<Entry, 'id'> }) => {
        const created = { id: `entry-${entries.length + 1}`, ...args.data }
        entries.push(created)
        return Promise.resolve(created)
      }),
    },
  }
  const allocate = jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 })
  const pool = { $transaction: jest.fn() }
  const service = new AccountingService(pool as never, { allocate } as never)
  return {
    service,
    tx: tx as unknown as Prisma.TransactionClient,
    raw: tx,
    pool,
    accounts,
    entries,
    state,
    proof,
    refund,
    allocate,
  }
}

const methods = [
  'createJournalEntryForCustomerCreditReceipt',
  'createJournalEntryForCustomerCreditApplication',
  'createJournalEntryForCustomerCreditRefund',
] as const

describe('Kundtillgodo genom den ordinarie verifikatskrivaren', () => {
  it('mottagande, användning och återbetalning har skilda källnycklar och balanserade kontorörelser', async () => {
    const r = rigg()
    for (const method of methods) await r.service[method](bas, r.tx)

    expect(r.entries.map((e) => e.sourceId)).toEqual([
      'customer-credit-receipt:event-1',
      'customer-credit-application:event-1',
      'customer-credit-refund:event-1',
    ])
    expect(r.entries.map((e) => e.lines.create)).toEqual([
      [
        expect.objectContaining({ accountId: 'bank-a', debit: 25.01 }),
        expect.objectContaining({ accountId: 'liability-a', credit: 25.01 }),
      ],
      [
        expect.objectContaining({ accountId: 'liability-a', debit: 25.01 }),
        expect.objectContaining({ accountId: 'receivable-a', credit: 25.01 }),
      ],
      [
        expect.objectContaining({ accountId: 'liability-a', debit: 25.01 }),
        expect.objectContaining({ accountId: 'bank-a', credit: 25.01 }),
      ],
    ])
    expect(r.entries[1]!.lines.create.some((l) => l.accountId === 'bank-a')).toBe(false)
    expect(r.allocate).toHaveBeenCalledTimes(3)
    expect(r.allocate).toHaveBeenCalledWith(r.tx, 'org-a', bas.date)
    expect(r.pool.$transaction).not.toHaveBeenCalled()
  })

  it.each(methods)('%s återanvänder samma verifikat vid omkörning', async (method) => {
    const r = rigg()
    const first = await r.service[method](bas, r.tx)
    if (method === 'createJournalEntryForCustomerCreditRefund') {
      // Domänen binder verifikatet och SETTLED atomiskt med första bokföringen.
      r.refund.state = 'SETTLED'
      r.refund.journalEntryId = first.id
      r.refund.settledAt = new Date()
    }
    const second = await r.service[method](bas, r.tx)
    expect(second.id).toBe(first.id)
    expect(r.entries).toHaveLength(1)
    expect(r.allocate).toHaveBeenCalledTimes(1)
  })

  it.each(methods)(
    '%s lämnar periodgrindens fel oförändrat och skriver ingenting',
    async (method) => {
      const r = rigg()
      const closed = new ConflictException('Perioden är stängd')
      r.allocate.mockRejectedValueOnce(closed)
      await expect(r.service[method](bas, r.tx)).rejects.toBe(closed)
      expect(r.entries).toHaveLength(0)
    },
  )

  it.each(['0', '-0.01', '0.001', 'NaN', 'Infinity', '100000000'])(
    'avvisar beloppet %s utan konto- eller journalskrivning',
    async (amount) => {
      const r = rigg()
      for (const method of methods) {
        await expect(
          r.service[method]({ ...bas, amount: new Prisma.Decimal(amount) }, r.tx),
        ).rejects.toBeInstanceOf(BadRequestException)
      }
      expect(r.raw.account.findMany).not.toHaveBeenCalled()
      expect(r.entries).toHaveLength(0)
    },
  )

  it.each(['0.01', '99999999.99'])('bevarar det giltiga öresbeloppet %s', async (amount) => {
    const r = rigg()
    await r.service.createJournalEntryForCustomerCreditReceipt(
      { ...bas, amount: new Prisma.Decimal(amount) },
      r.tx,
    )
    const line = r.entries[0]!.lines.create[0]!
    expect(new Prisma.Decimal(line.debit!).toFixed(2)).toBe(amount)
  })

  it.each(['annan organisation', 'inaktivt', 'fel kontotyp'])(
    'avvisar ett skuldkonto som är %s',
    async (kind) => {
      const r = rigg()
      const liability = r.accounts[0]!
      if (kind === 'annan organisation') liability.organizationId = 'org-b'
      if (kind === 'inaktivt') liability.isActive = false
      if (kind === 'fel kontotyp') liability.type = 'ASSET'
      for (const method of methods) {
        await expect(r.service[method](bas, r.tx)).rejects.toBeInstanceOf(ConflictException)
      }
      expect(r.entries).toHaveLength(0)
    },
  )

  it('avvisar konton som saknas, även om ett annat skuldkonto finns', async () => {
    const r = rigg()
    await expect(
      r.service.createJournalEntryForCustomerCreditReceipt(
        { ...bas, liabilityAccountId: 'missing' },
        r.tx,
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(r.entries).toHaveLength(0)
  })

  it.each([
    ['createJournalEntryForCustomerCreditReceipt', 'bank-a'],
    ['createJournalEntryForCustomerCreditApplication', 'receivable-a'],
    ['createJournalEntryForCustomerCreditRefund', 'bank-a'],
  ] as const)('%s avvisar inaktivt motkonto', async (method, id) => {
    const r = rigg()
    r.accounts.find((a) => a.id === id)!.isActive = false
    await expect(r.service[method](bas, r.tx)).rejects.toBeInstanceOf(ConflictException)
    expect(r.entries).toHaveLength(0)
  })

  it.each([
    'createJournalEntryForCustomerCreditReceipt',
    'createJournalEntryForCustomerCreditApplication',
  ] as const)('%s kräver avins eget fordransverifikat', async (method) => {
    const r = rigg()
    r.state.accrual = false
    await expect(r.service[method](bas, r.tx)).rejects.toThrow('saknar bokförd fordran')
    expect(r.raw.rentNotice.findFirst).not.toHaveBeenCalled()
    expect(r.entries).toHaveLength(0)
    expect(r.allocate).not.toHaveBeenCalled()
  })

  it.each([
    'createJournalEntryForCustomerCreditReceipt',
    'createJournalEntryForCustomerCreditApplication',
  ] as const)('%s avvisar en redan återförd hyresfordran', async (method) => {
    const r = rigg()
    r.state.accrualReversed = true
    await expect(r.service[method](bas, r.tx)).rejects.toThrow('återförd hyresfordran')
    expect(r.raw.journalEntry.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', source: 'INVOICE', sourceId: 'rent-notice:notice-1' },
      select: { id: true, reversedBy: { select: { id: true } } },
    })
    expect(r.entries).toHaveLength(0)
    expect(r.allocate).not.toHaveBeenCalled()
  })

  it.each(methods)(
    '%s kräver transaktionsklienten även vid anrop förbi TypeScript',
    async (method) => {
      const r = rigg()
      await expect(
        r.service[method](bas, r.pool as unknown as Prisma.TransactionClient),
      ).rejects.toThrow('pågående transaktion')
      await expect(
        r.service[method](bas, undefined as unknown as Prisma.TransactionClient),
      ).rejects.toThrow('pågående transaktion')
      expect(r.entries).toHaveLength(0)
    },
  )
})

describe('Återbetalning kräver beständig order och bankbevis före bokföring', () => {
  it('samma bankfakta behåller sin hash vid senare verifiering, men ändrade ekonomiska fakta gör det inte', () => {
    const r = rigg()
    expect(
      customerCreditRefundBankProofHash({
        ...r.proof,
        verifiedAt: new Date('2026-10-17T12:00:00Z'),
      }),
    ).toBe(r.refund.bankProofHash)
    for (const changed of [
      { ...r.proof, amount: '25.02' },
      { ...r.proof, providerAccountRef: 'other-account' },
      { ...r.proof, recipientRef: 'other-recipient' },
      { ...r.proof, bankBookedAt: new Date('2026-10-16T12:00:00Z') },
    ]) {
      expect(customerCreditRefundBankProofHash(changed)).not.toBe(r.refund.bankProofHash)
    }
  })

  it('läser rätt organisations order efter orderlåset', async () => {
    const r = rigg()
    await r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)
    expect(r.raw.customerCreditRefund.findFirst).toHaveBeenCalledWith({
      where: { id: bas.eventId, organizationId: bas.organizationId },
      include: { credit: { select: { sourceRentNoticeId: true } } },
    })
    expect(r.raw.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      r.raw.customerCreditRefund.findFirst.mock.invocationCallOrder[0]!,
    )
  })

  it.each(['RESERVED', 'SUBMITTING', 'UNKNOWN', 'REJECTED', 'CANCELLED'])(
    'ett angivet bank-id räcker inte för en order i %s',
    async (state) => {
      const r = rigg()
      r.refund.state = state
      await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
        'bankbekräftad order',
      )
      expect(r.allocate).not.toHaveBeenCalled()
    },
  )

  it('saknad order eller annan organisation kan inte bokföras med ett bank-id', async () => {
    const r = rigg()
    for (const input of [
      { ...bas, eventId: 'missing' },
      { ...bas, organizationId: 'org-b' },
    ]) {
      await expect(
        r.service.createJournalEntryForCustomerCreditRefund(input, r.tx),
      ).rejects.toThrow('bankbekräftad order')
    }
    expect(r.entries).toHaveLength(0)
  })

  it.each([null, {}, { kind: 'PENDING', instructionId: bas.eventId }])(
    'nekar saknat eller obokat sparat bankbevis %#',
    async (bankEvidence) => {
      const r = rigg()
      r.refund.bankEvidence = bankEvidence
      await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
        'giltigt sparat bankbevis',
      )
      expect(r.entries).toHaveLength(0)
    },
  )

  it.each([
    ['instructionId', 'another-instruction'],
    ['instructionHash', 'c'.repeat(64)],
    ['organizationId', 'org-b'],
    ['tenantId', 'tenant-b'],
    ['bankAccountId', 'physical-bank-b'],
    ['provider', 'another-bank'],
    ['providerAccountRef', 'opaque-bank-b'],
    ['recipientRef', 'opaque-tenant-b'],
    ['amount', '25.02'],
    ['providerTransferId', 'another-transfer'],
    ['bankTransactionId', 'another-transaction'],
  ])('nekar bankfakta med fel %s även om bevisets hash är intakt', async (key, value) => {
    const r = rigg()
    const wrongProof = CustomerCreditRefundBookedDebitSchema.parse({ ...r.proof, [key]: value })
    r.refund.bankEvidence = JSON.parse(JSON.stringify(wrongProof))
    r.refund.bankProofHash = customerCreditRefundBankProofHash(wrongProof)
    await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
      'stämmer inte överens',
    )
    expect(r.entries).toHaveLength(0)
  })

  it.each(['bankProofHash', 'bankProofKey'] as const)('nekar förändrad %s', async (field) => {
    const r = rigg()
    r.refund[field] = 'changed'
    await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
      'stämmer inte överens',
    )
    expect(r.entries).toHaveLength(0)
  })

  it.each([
    { amount: new Prisma.Decimal('25.02') },
    { liabilityAccountId: 'another-liability' },
    { bankLedgerAccountId: 'another-bank-ledger' },
    { rentNoticeId: 'another-notice' },
    { bankTransactionId: 'another-bank-transaction' },
  ])('samma händelsenyckel accepterar inte ändrat bokföringsinnehåll %#', async (change) => {
    const r = rigg()
    await expect(
      r.service.createJournalEntryForCustomerCreditRefund({ ...bas, ...change }, r.tx),
    ).rejects.toThrow('stämmer inte överens')
    expect(r.entries).toHaveLength(0)
  })

  it('kräver uttryckligt bankkonto och har ingen 1930-fallback', async () => {
    const r = rigg()
    await expect(
      r.service.createJournalEntryForCustomerCreditRefund(
        { ...bas, bankLedgerAccountId: '' },
        r.tx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(r.raw.account.findMany).not.toHaveBeenCalled()
    expect(r.entries).toHaveLength(0)
  })

  it('väljer enbart den frysta orderns bankkonto, aldrig ett kontonummer', async () => {
    const r = rigg()
    // Att kopplingen också motsvarar mottagandets verkliga bankkonto prövas av
    // domäntjänsten före reservationen. Bokföraren gör inget eget standardval.
    r.accounts.find((a) => a.id === 'bank-a')!.number = 1935
    await r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)
    expect(r.raw.account.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: bas.organizationId,
        isActive: true,
        OR: [
          { id: bas.liabilityAccountId, type: 'LIABILITY' },
          { id: bas.bankLedgerAccountId, type: 'ASSET' },
        ],
      },
      select: { id: true, type: true },
    })
    expect(r.entries[0]!.lines.create[1]).toEqual(
      expect.objectContaining({ accountId: 'bank-a', credit: 25.01 }),
    )
  })

  it('bokför bankens Stockholmsdag även när UTC-dagen är en annan', async () => {
    const r = rigg()
    const bankBookedAt = new Date('2026-10-15T22:30:00Z')
    const proof = CustomerCreditRefundBookedDebitSchema.parse({ ...r.proof, bankBookedAt })
    r.refund.bankBookedAt = bankBookedAt
    r.refund.bankEvidence = JSON.parse(JSON.stringify(proof))
    r.refund.bankProofHash = customerCreditRefundBankProofHash(proof)
    await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
      'stämmer inte överens',
    )
    const date = new Date('2026-10-16T12:00:00Z')
    await r.service.createJournalEntryForCustomerCreditRefund({ ...bas, date }, r.tx)
    expect(r.entries[0]!.date).toEqual(date)
  })

  it.each(['reversed', 'wrong amount', 'wrong account', 'extra line', 'wrong date', 'wrong link'])(
    'nekar replay när det tidigare verifikatet är %s',
    async (kind) => {
      const r = rigg()
      const journal = await r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)
      r.refund.state = 'SETTLED'
      r.refund.journalEntryId = journal.id
      r.refund.settledAt = new Date()
      const entry = r.entries[0]!
      if (kind === 'reversed') entry.reversedBy = { id: 'reversal-1' }
      if (kind === 'wrong amount') entry.lines.create[0]!.debit = 25.02
      if (kind === 'wrong account') entry.lines.create[1]!.accountId = 'another-bank'
      if (kind === 'extra line') entry.lines.create.push({ accountId: 'extra', debit: 0 })
      if (kind === 'wrong date') entry.date = new Date('2026-10-17T12:00:00Z')
      if (kind === 'wrong link') r.refund.journalEntryId = 'another-journal'
      await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
        'återfört eller har annat innehåll',
      )
      expect(r.entries).toHaveLength(1)
      expect(r.allocate).toHaveBeenCalledTimes(1)
    },
  )

  it('nekar ett befintligt men olänkat verifikat och en SETTLED-order utan verifikat', async () => {
    const r = rigg()
    await r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)
    await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
      'återfört eller har annat innehåll',
    )
    r.entries.splice(0)
    r.refund.state = 'SETTLED'
    await expect(r.service.createJournalEntryForCustomerCreditRefund(bas, r.tx)).rejects.toThrow(
      'bokföringskoppling är ofullständig',
    )
    expect(r.allocate).toHaveBeenCalledTimes(1)
  })
})

function reversalRig(sourceId = 'rent-notice-bank-payment:allocation-1') {
  const order: string[] = []
  const state = { hasCredit: true, appearsAtLock: false }
  const original = {
    id: 'original-1',
    organizationId: 'org-a',
    source: sourceId.startsWith('rent-notice:') ? 'INVOICE' : 'PAYMENT',
    sourceId,
    description: 'Ursprunglig kontering',
    date: new Date('2026-10-15T12:00:00Z'),
    series: 'A',
    verNumber: 1,
    reversedBy: null,
    lines: [
      { accountId: 'bank-a', debit: new Prisma.Decimal(100), credit: null, description: null },
      {
        accountId: 'receivable-a',
        debit: null,
        credit: new Prisma.Decimal(100),
        description: null,
      },
    ],
  }
  const tx = {
    $queryRaw: jest.fn(async () => {
      order.push('lock')
      if (state.appearsAtLock) state.hasCredit = true
      return [{ id: 'locked' }]
    }),
    customerCredit: {
      findFirst: jest.fn(async (args: { where: { organizationId: string } }) => {
        order.push('credit-read')
        return state.hasCredit && args.where.organizationId === 'org-a' ? { id: 'credit-1' } : null
      }),
    },
    rentNoticePayment: { findFirst: jest.fn().mockResolvedValue({ bankTransactionId: 'bank-1' }) },
    bankTransaction: { findFirst: jest.fn().mockResolvedValue({ id: 'bank-1' }) },
    journalEntry: {
      findFirst: jest.fn(
        async (args: { where: { id?: string; sourceId?: string; organizationId?: string } }) =>
          args.where.organizationId === 'org-a' &&
          (args.where.id === original.id || args.where.sourceId === sourceId)
            ? original
            : null,
      ),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        order.push('journal-write')
        return { id: 'reversal-1', ...args.data }
      }),
    },
    fortnoxVoucherExport: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  }
  const pool = {
    ...tx,
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction')
      return fn(tx)
    }),
  }
  const allocate = jest.fn(async () => {
    order.push('number')
    return { series: 'A', verNumber: 2, fiscalYear: 2026 }
  })
  const service = new AccountingService(pool as never, { allocate } as never)
  const reverse = () =>
    service.reverseJournalEntry({
      entryId: original.id,
      organizationId: 'org-a',
      actorRole: UserRole.OWNER,
      actorUserId: 'user-1',
      reason: 'Felaktig registrering',
    })
  return { service, reverse, pool, tx, state, order, allocate }
}

describe('Kundtillgodo får inte rättas genom att bara vända huvudboken', () => {
  it.each(['receipt', 'application', 'refund'])(
    'nekar generell rättelse av customer-credit-%s',
    async (kind) => {
      const r = reversalRig(`customer-credit-${kind}:event-1`)
      await expect(r.reverse()).rejects.toBeInstanceOf(ConflictException)
      expect(r.pool.$transaction).not.toHaveBeenCalled()
      expect(r.tx.journalEntry.create).not.toHaveBeenCalled()
    },
  )

  it.each(['rent-notice-bank-payment:allocation-1', 'bank-1'])(
    'nekar rättelse av en källbetalning med nyckeln %s under banklåset',
    async (sourceId) => {
      const r = reversalRig(sourceId)
      await expect(r.reverse()).rejects.toThrow('Betalningen har skapat kundtillgodo')
      expect(r.order).toEqual(['transaction', 'lock', 'credit-read'])
      expect(r.tx.customerCredit.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org-a', sourceBankTransactionId: 'bank-1' },
        select: { id: true },
      })
      expect(r.allocate).not.toHaveBeenCalled()
    },
  )

  it('läser tillgodot efter låsväntan, inte i en olåst förkontroll', async () => {
    const r = reversalRig()
    r.state.hasCredit = false
    r.state.appearsAtLock = true
    await expect(r.reverse()).rejects.toThrow('Betalningen har skapat kundtillgodo')
    expect(r.tx.journalEntry.create).not.toHaveBeenCalled()
  })

  it('en vanlig bankbetalning utan tillgodo kan fortfarande rättas', async () => {
    const r = reversalRig()
    r.state.hasCredit = false
    await expect(r.reverse()).resolves.toEqual(expect.objectContaining({ id: 'reversal-1' }))
    expect(r.order).toEqual(['transaction', 'lock', 'credit-read', 'number', 'journal-write'])
  })

  it('nekar separat rättelse av aviunderlag som deltar i tillgodoflödet', async () => {
    const r = reversalRig('rent-notice:notice-1')
    await expect(r.reverse()).rejects.toThrow('Avin ingår i ett kundtillgodoflöde')
    expect(r.order).toEqual(['transaction', 'lock', 'credit-read'])
    expect(r.tx.customerCredit.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        OR: [
          { sourceRentNoticeId: 'notice-1' },
          { applications: { some: { organizationId: 'org-a', rentNoticeId: 'notice-1' } } },
        ],
      },
      select: { id: true },
    })
  })

  it('betalningsrättelsen använder anroparens transaktion så hela avmatchningen kan rullas tillbaka', async () => {
    const r = reversalRig()
    await expect(
      r.service.reverseJournalEntryForPayment(
        'bank-1',
        'org-a',
        null,
        r.tx as unknown as Prisma.TransactionClient,
        'rent-notice-bank-payment:allocation-1',
      ),
    ).rejects.toThrow('Betalningen har skapat kundtillgodo')
    expect(r.pool.$transaction).not.toHaveBeenCalled()
    expect(r.order).toEqual(['lock', 'credit-read'])
    expect(r.tx.journalEntry.create).not.toHaveBeenCalled()
  })

  it('normal aviannullering använder tillgodospärren i anroparens transaktion', async () => {
    const r = reversalRig('rent-notice:notice-1')
    r.state.hasCredit = false
    r.state.appearsAtLock = true
    await expect(
      r.service.reverseJournalEntryForRentNotice(
        'notice-1',
        'org-a',
        null,
        r.tx as unknown as Prisma.TransactionClient,
      ),
    ).rejects.toThrow('Avin ingår i ett kundtillgodoflöde')
    expect(r.pool.$transaction).not.toHaveBeenCalled()
    expect(r.order).toEqual(['lock', 'credit-read'])
    expect(r.tx.journalEntry.create).not.toHaveBeenCalled()
    expect(r.allocate).not.toHaveBeenCalled()
  })
})
