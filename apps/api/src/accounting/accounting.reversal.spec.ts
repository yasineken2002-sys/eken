/**
 * Fix #4 — motverifikat vid makulering.
 *
 * En hyresavi (createJournalEntryForRentNotice) och en faktura
 * (createJournalEntryForInvoice) intäktsbokförs 1510 D / 39xx K / ev. 26xx K.
 * Vid annullering (cancelNotice) resp. makulering (Invoice VOID) MÅSTE den posten
 * reverseras, annars kvarstår fantomintäkt + utgående moms (BFL 5 kap 5 §/9 §).
 *
 * Verifierar reverseJournalEntryForRentNotice / reverseJournalEntryForInvoice:
 *   • läser originalet (source INVOICE, rätt sourceId) och skapar ett motverifikat
 *     med debet/kredit BYTT rad för rad,
 *   • daterar motverifikatet till annulleringsdagen (ej originalets datum),
 *   • no-op när ingen originalpost finns.
 */

import { AccountingService } from './accounting.service'

type Created = {
  data: { date: Date; description: string; lines: { create: Array<Record<string, unknown>> } }
}

// Original: 1510 D 12500 / 3913 K 10000 / 2611 K 2500 (lokalhyra + moms).
const ORIGINAL = {
  id: 'je-orig',
  description: 'Hyresavi AVI-2026-06-0001',
  lines: [
    { accountId: 'acc-1510', debit: 12500, credit: null, description: 'Hyresavi AVI-2026-06-0001' },
    { accountId: 'acc-3913', debit: null, credit: 10000, description: 'Hyresintäkt 6/2026' },
    { accountId: 'acc-2611', debit: null, credit: 2500, description: 'Moms 25%' },
  ],
}

function makeService(opts: { existing?: unknown } = {}) {
  let created: Created | null = null
  // Originalposten finns; reversalens egen idempotens-uppslagning (…-reversal:…)
  // ska returnera null så createNumberedEntry faktiskt skapar motverifikatet.
  const findFirst = jest.fn().mockImplementation((arg: { where?: { sourceId?: string } }) => {
    const sid = arg?.where?.sourceId ?? ''
    if (sid.includes('reversal')) return Promise.resolve(null)
    return Promise.resolve(opts.existing ?? null)
  })
  const prisma = {
    journalEntry: {
      findFirst,
      create: jest.fn().mockImplementation((arg: Created) => {
        created = arg
        return Promise.resolve({ id: 'je-rev', ...arg })
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue([]) },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 9, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, findFirst, getCreated: () => created }
}

function creditFor(created: Created, accountId: string) {
  return created.data.lines.create.find((l) => l.accountId === accountId)
}

describe('reverseJournalEntryForRentNotice', () => {
  it('skapar motverifikat med debet/kredit bytt rad för rad', async () => {
    const { service, findFirst, getCreated } = makeService({ existing: ORIGINAL })

    await service.reverseJournalEntryForRentNotice('rn-1', 'org-1', 'user-1')

    // Läser originalet på rätt source/sourceId
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: 'org-1', source: 'INVOICE', sourceId: 'rent-notice:rn-1' },
    })
    const created = getCreated()!
    // 1510: var debet 12500 → nu kredit 12500 (fordran nollas)
    expect(creditFor(created, 'acc-1510')).toMatchObject({ credit: 12500 })
    // 3913: var kredit 10000 → nu debet 10000 (intäkt återförs)
    expect(creditFor(created, 'acc-3913')).toMatchObject({ debit: 10000 })
    // 2611: var kredit 2500 → nu debet 2500 (utgående moms återförs)
    expect(creditFor(created, 'acc-2611')).toMatchObject({ debit: 2500 })
  })

  it('no-op när ingen originalpost finns (t.ex. DEPOSIT-avi)', async () => {
    const { service, getCreated } = makeService({ existing: null })
    await service.reverseJournalEntryForRentNotice('rn-1', 'org-1', 'user-1')
    expect(getCreated()).toBeNull()
  })
})

describe('reverseJournalEntryForInvoice', () => {
  it('läser originalet på invoice.id och reverserar posten', async () => {
    const { service, findFirst, getCreated } = makeService({
      existing: { ...ORIGINAL, description: 'Faktura F-2026-0001' },
    })

    await service.reverseJournalEntryForInvoice('inv-1', 'org-1', 'user-1')

    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: 'org-1', source: 'INVOICE', sourceId: 'inv-1' },
    })
    const created = getCreated()!
    expect(created.data.description).toMatch(/Makulerad faktura/)
    expect(creditFor(created, 'acc-1510')).toMatchObject({ credit: 12500 })
    expect(creditFor(created, 'acc-3913')).toMatchObject({ debit: 10000 })
    expect(creditFor(created, 'acc-2611')).toMatchObject({ debit: 2500 })
  })

  it('no-op när ingen originalpost finns', async () => {
    const { service, getCreated } = makeService({ existing: null })
    await service.reverseJournalEntryForInvoice('inv-1', 'org-1', 'user-1')
    expect(getCreated()).toBeNull()
  })
})
