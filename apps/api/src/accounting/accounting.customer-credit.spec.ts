import { BadRequestException, ConflictException } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import { AccountingService } from './accounting.service'

const bas = {
  organizationId: 'org-a',
  eventId: 'event-1',
  rentNoticeId: 'notice-1',
  bankTransactionId: 'bank-1',
  liabilityAccountId: 'liability-a',
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
          return Promise.resolve(
            entries.find(
              (e) =>
                e.organizationId === args.where.organizationId &&
                e.source === args.where.source &&
                e.sourceId === args.where.sourceId,
            ) ?? null,
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
    const second = await r.service[method](bas, r.tx)
    expect(second).toBe(first)
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
})
