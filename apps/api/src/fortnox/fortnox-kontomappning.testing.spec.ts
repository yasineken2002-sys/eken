import type { Account, PrismaClient } from '@prisma/client'
import { leverantorsfaktura } from './fortnox-kontomappning.testing'

type Konto = Pick<Account, 'id' | 'organizationId' | 'number'>
type Options = NonNullable<Parameters<typeof leverantorsfaktura>[2]>
type Konton = NonNullable<Options['forbereddaKonton']>
const ORG = 'fixture-org'

function konton(kostnad = 5170): Konton {
  return {
    kostnad: { id: 'expense-id', organizationId: ORG, number: kostnad },
    skuld: { id: 'liability-id', organizationId: ORG, number: 2440 },
  }
}

function rig() {
  const account = {
    findFirst: jest.fn<Promise<Konto | null>, [unknown]>(),
    create: jest.fn<Promise<Konto>, [unknown]>(),
  }
  const supplierInvoice = {
    create: jest.fn<Promise<{ id: string }>, [unknown]>().mockResolvedValue({ id: 'invoice-id' }),
  }
  const journalEntry = {
    create: jest.fn<Promise<{ id: string }>, [unknown]>().mockResolvedValue({ id: 'journal-id' }),
  }
  const prisma = { account, supplierInvoice, journalEntry } as unknown as PrismaClient
  return { prisma, account, supplierInvoice, journalEntry }
}

describe('leverantorsfaktura: orgbundna förberedda konton', () => {
  it.each([5170, 5999])(
    'samma faktura/verifikat med förberedda och uppslagna konton (%i)',
    async (kostnadskonto) => {
      const accounts = konton(kostnadskonto)
      const prepared = rig()
      const lookup = rig()
      lookup.account.findFirst
        .mockResolvedValueOnce(accounts.kostnad)
        .mockResolvedValueOnce(accounts.skuld)
      const options: Options = {
        belopp: '12.34',
        datum: '2027-03-16',
        beskrivning: 'Syntetisk åtgärd',
        radtext: ['Kostnadsrad', null],
        kostnadskonto,
        verNumber: 17,
      }

      await expect(
        leverantorsfaktura(prepared.prisma, ORG, { ...options, forbereddaKonton: accounts }),
      ).resolves.toStrictEqual({ id: 'journal-id' })
      await expect(leverantorsfaktura(lookup.prisma, ORG, options)).resolves.toStrictEqual({
        id: 'journal-id',
      })

      expect(prepared.account.findFirst).not.toHaveBeenCalled()
      expect(prepared.account.create).not.toHaveBeenCalled()
      expect(lookup.account.findFirst.mock.calls).toStrictEqual([
        [{ where: { organizationId: ORG, number: kostnadskonto } }],
        [{ where: { organizationId: ORG, number: 2440 } }],
      ])
      expect(lookup.account.create).not.toHaveBeenCalled()

      for (const actual of [prepared, lookup]) {
        expect(actual.supplierInvoice.create.mock.calls).toStrictEqual([
          [
            {
              data: {
                organizationId: ORG,
                supplierName: 'Syntetisk leverantör',
                description: 'Syntetisk åtgärd',
                invoiceDate: new Date('2027-03-16'),
                dueDate: new Date('2027-03-16'),
                expenseAccount: kostnadskonto,
                netAmount: '12.34',
                vatRate: 0,
                vatAmount: '0',
                totalAmount: '12.34',
              },
            },
          ],
        ])
        expect(actual.journalEntry.create.mock.calls).toStrictEqual([
          [
            {
              data: {
                organizationId: ORG,
                date: new Date('2027-03-16'),
                description: 'Syntetisk åtgärd',
                fiscalYear: 2027,
                verNumber: 17,
                source: 'SUPPLIER_INVOICE',
                sourceId: 'supplier-invoice:invoice-id',
                lines: {
                  create: [
                    { accountId: 'expense-id', debit: '12.34', description: 'Kostnadsrad' },
                    { accountId: 'liability-id', credit: '12.34', description: null },
                  ],
                },
              },
            },
          ],
        ])
        expect(actual.supplierInvoice.create.mock.invocationCallOrder[0]).toBeLessThan(
          actual.journalEntry.create.mock.invocationCallOrder[0]!,
        )
      }
      expect(prepared.supplierInvoice.create.mock.calls).toStrictEqual(
        lookup.supplierInvoice.create.mock.calls,
      )
      expect(prepared.journalEntry.create.mock.calls).toStrictEqual(
        lookup.journalEntry.create.mock.calls,
      )
    },
  )

  const invalidCases: Array<{ name: string; change: (accounts: Konton) => void }> = [
    {
      name: 'kostnad i annan org',
      change: (a) => {
        a.kostnad.organizationId = 'foreign-org'
      },
    },
    {
      name: 'skuld i annan org',
      change: (a) => {
        a.skuld.organizationId = 'foreign-org'
      },
    },
    {
      name: 'fel kostnadsnummer',
      change: (a) => {
        a.kostnad.number = 5999
      },
    },
    {
      name: 'fel skuldnummer',
      change: (a) => {
        a.skuld.number = 1930
      },
    },
    {
      name: 'tomt kostnads-ID',
      change: (a) => {
        a.kostnad.id = ''
      },
    },
    {
      name: 'tomt skuld-ID',
      change: (a) => {
        a.skuld.id = ''
      },
    },
    {
      name: 'blankt kostnads-ID',
      change: (a) => {
        a.kostnad.id = '  '
      },
    },
    {
      name: 'blankt skuld-ID',
      change: (a) => {
        a.skuld.id = '  '
      },
    },
    {
      name: 'samma ID för båda konton',
      change: (a) => {
        a.skuld.id = a.kostnad.id
      },
    },
  ]

  it.each(invalidCases)('nekar $name före alla DB-anrop', async ({ change }) => {
    const accounts = konton()
    change(accounts)
    const actual = rig()
    await expect(
      leverantorsfaktura(actual.prisma, ORG, { forbereddaKonton: accounts, verNumber: 17 }),
    ).rejects.toThrow('Förberedda konton matchar inte fakturans organisation och konton')
    expect(actual.account.findFirst).not.toHaveBeenCalled()
    expect(actual.account.create).not.toHaveBeenCalled()
    expect(actual.supplierInvoice.create).not.toHaveBeenCalled()
    expect(actual.journalEntry.create).not.toHaveBeenCalled()
  })

  it('utan option skapas saknade konton i befintlig ordning och standardvärden bevaras', async () => {
    const accounts = konton()
    const actual = rig()
    actual.account.findFirst.mockResolvedValue(null)
    actual.account.create
      .mockResolvedValueOnce(accounts.kostnad)
      .mockResolvedValueOnce(accounts.skuld)

    await expect(leverantorsfaktura(actual.prisma, ORG, { verNumber: 17 })).resolves.toStrictEqual({
      id: 'journal-id',
    })

    expect(actual.account.findFirst.mock.calls).toStrictEqual([
      [{ where: { organizationId: ORG, number: 5170 } }],
      [{ where: { organizationId: ORG, number: 2440 } }],
    ])
    expect(actual.account.create.mock.calls).toStrictEqual([
      [{ data: { organizationId: ORG, number: 5170, name: 'Konto 5170', type: 'EXPENSE' } }],
      [{ data: { organizationId: ORG, number: 2440, name: 'Konto 2440', type: 'LIABILITY' } }],
    ])
    const order = [
      actual.account.findFirst.mock.invocationCallOrder[0],
      actual.account.create.mock.invocationCallOrder[0],
      actual.account.findFirst.mock.invocationCallOrder[1],
      actual.account.create.mock.invocationCallOrder[1],
      actual.supplierInvoice.create.mock.invocationCallOrder[0],
      actual.journalEntry.create.mock.invocationCallOrder[0],
    ]
    expect(order.every((n) => typeof n === 'number')).toBe(true)
    expect(order).toStrictEqual([...order].sort((a, b) => a! - b!))
    expect(actual.supplierInvoice.create.mock.calls).toStrictEqual([
      [
        {
          data: {
            organizationId: ORG,
            supplierName: 'Syntetisk leverantör',
            description: 'Reparation trapphus',
            invoiceDate: new Date('2026-10-02'),
            dueDate: new Date('2026-10-02'),
            expenseAccount: 5170,
            netAmount: '1234.50',
            vatRate: 0,
            vatAmount: '0',
            totalAmount: '1234.50',
          },
        },
      ],
    ])
    expect(actual.journalEntry.create.mock.calls).toStrictEqual([
      [
        {
          data: {
            organizationId: ORG,
            date: new Date('2026-10-02'),
            description: 'Reparation trapphus',
            fiscalYear: 2026,
            verNumber: 17,
            source: 'SUPPLIER_INVOICE',
            sourceId: 'supplier-invoice:invoice-id',
            lines: {
              create: [
                { accountId: 'expense-id', debit: '1234.50', description: null },
                { accountId: 'liability-id', credit: '1234.50', description: null },
              ],
            },
          },
        },
      ],
    ])
  })
})
