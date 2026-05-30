/**
 * FIX 9 · PR 6 — Sluten intäktscykel: betalningsverifikat vid markAsPaid.
 *
 * Verifierar createJournalEntryForRentNoticeManualPayment:
 *   • Likvidkonto debiteras per betalningssätt (BANK/MANUAL → 1930, CASH → 1910,
 *     SWISH → 1934), 1510 Kundfordringar krediteras — posten balanserar.
 *   • Beloppet är paidAmount (delbetalning regleras delvis).
 *   • DEPOSIT-avier bokförs INTE (deposits-modulen äger den ledgern).
 *   • Belopp <= 0 → null.
 *   • Idempotent via sourceId (rent-notice-payment:<id>).
 *   • Saknat likvidkonto → null (ingen halv post).
 */

import { AccountingService } from './accounting.service'

type Created = {
  data: { date: Date; sourceId?: string; lines: { create: Array<Record<string, unknown>> } }
}

function makeService(opts?: {
  existing?: unknown
  accounts?: Array<{ id: string; number: number }>
}) {
  const accounts = opts?.accounts ?? [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-1910', number: 1910 },
    { id: 'acc-1930', number: 1930 },
  ]
  let created: Created | null = null
  const prisma = {
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(opts?.existing ?? null),
      create: jest.fn().mockImplementation((arg: Created) => {
        created = arg
        return Promise.resolve({ id: 'je-pay-1', ...arg })
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 7, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, getCreated: () => created }
}

const baseNotice = {
  id: 'rn-1',
  noticeNumber: 'AVI-2026-06-0001',
  type: 'RENT' as const,
}
const paidAt = new Date('2026-06-15T00:00:00.000Z')

describe('FIX 9 · PR 6 — createJournalEntryForRentNoticeManualPayment', () => {
  it('BANK: debiterar 1930 / krediterar 1510, balanserad', async () => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      10_000,
      paidAt,
      'BANK',
      'org-1',
      'user-1',
    )
    const lines = getCreated()!.data.lines.create
    const debit = lines.find((l) => l.debit != null)
    const credit = lines.find((l) => l.credit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1930', debit: 10_000 })
    expect(credit).toMatchObject({ accountId: 'acc-1510', credit: 10_000 })
    const sumD = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const sumK = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
    expect(sumD).toBe(sumK)
  })

  it('CASH: debiterar 1910 (Kassa)', async () => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      5_000,
      paidAt,
      'CASH',
      'org-1',
      null,
    )
    const debit = getCreated()!.data.lines.create.find((l) => l.debit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1910', debit: 5_000 })
  })

  it('SWISH: debiterar 1930 (Swish landar på företagskontot)', async () => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      3_200,
      paidAt,
      'SWISH',
      'org-1',
      null,
    )
    const debit = getCreated()!.data.lines.create.find((l) => l.debit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1930', debit: 3_200 })
  })

  it('MANUAL: debiterar konservativt 1930', async () => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      1_000,
      paidAt,
      'MANUAL',
      'org-1',
      null,
    )
    const debit = getCreated()!.data.lines.create.find((l) => l.debit != null)
    expect(debit?.accountId).toBe('acc-1930')
  })

  it('delbetalning: bokför faktiskt inbetalt belopp (paidAmount), inte totalen', async () => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      4_500,
      paidAt,
      'BANK',
      'org-1',
      null,
    )
    const lines = getCreated()!.data.lines.create
    expect(lines.find((l) => l.debit != null)?.debit).toBe(4_500)
    expect(lines.find((l) => l.credit != null)?.credit).toBe(4_500)
  })

  it('bokför på betalningsdatumet och nycklar idempotensen på avin', async () => {
    const { service, getCreated } = makeService()
    await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      10_000,
      paidAt,
      'BANK',
      'org-1',
      null,
    )
    expect(getCreated()!.data.date.toISOString().slice(0, 10)).toBe('2026-06-15')
    expect(getCreated()!.data.sourceId).toBe('rent-notice-payment:rn-1')
  })

  it('DEPOSIT-avi bokförs INTE (deposits-modulen äger ledgern)', async () => {
    const { service, prisma } = makeService()
    const result = await service.createJournalEntryForRentNoticeManualPayment(
      { ...baseNotice, type: 'DEPOSIT' as const },
      10_000,
      paidAt,
      'BANK',
      'org-1',
      null,
    )
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('belopp <= 0 → null (ingen post)', async () => {
    const { service, prisma } = makeService()
    const result = await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      0,
      paidAt,
      'BANK',
      'org-1',
      null,
    )
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('idempotent: befintligt verifikat → ingen ny create', async () => {
    const { service, prisma } = makeService({ existing: { id: 'je-existing' } })
    const result = await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      10_000,
      paidAt,
      'BANK',
      'org-1',
      null,
    )
    expect(result).toMatchObject({ id: 'je-existing' })
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('saknat likvidkonto (1910) → null, ingen halv post', async () => {
    const { service, prisma } = makeService({
      accounts: [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-1930', number: 1930 },
        // 1910 saknas avsiktligt
      ],
    })
    const result = await service.createJournalEntryForRentNoticeManualPayment(
      baseNotice,
      10_000,
      paidAt,
      'CASH',
      'org-1',
      null,
    )
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})
