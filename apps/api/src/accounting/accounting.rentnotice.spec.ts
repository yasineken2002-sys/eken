/**
 * FIX 9 · PR 2 — Intäktsverifikation vid RentNotice.create (LAGBROTT 2).
 *
 * Verifierar createJournalEntryForRentNotice:
 *   • RENT-avi bokförs 1510 D (total) / 39xx K (netto), konto per upplåtelsetyp.
 *   • Posten balanserar (debet = summa kredit).
 *   • Moms krediteras separat på 26xx när vatAmount > 0.
 *   • DEPOSIT-avier bokförs INTE som intäkt (returnerar null).
 *   • Idempotent via sourceId.
 *   • Saknade konton → null (ingen halv post).
 */

import { AccountingService } from './accounting.service'

type Created = { data: { date: Date; lines: { create: Array<Record<string, unknown>> } } }

function makeService(opts: {
  unitType?: string | null
  existing?: unknown
  accounts?: Array<{ id: string; number: number }>
}) {
  const accounts = opts.accounts ?? [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-2611', number: 2611 },
    { id: 'acc-3911', number: 3911 },
    { id: 'acc-3913', number: 3913 },
    { id: 'acc-3914', number: 3914 },
  ]
  let created: Created | null = null
  const prisma = {
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
      create: jest.fn().mockImplementation((arg: Created) => {
        created = arg
        return Promise.resolve({ id: 'je-1', ...arg })
      }),
    },
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    lease: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.unitType === undefined
            ? { unit: { type: 'APARTMENT' } }
            : { unit: opts.unitType ? { type: opts.unitType } : null },
        ),
    },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, getCreated: () => created }
}

const baseNotice = {
  id: 'rn-1',
  noticeNumber: 'AVI-2026-06-0001',
  leaseId: 'lease-1',
  type: 'RENT' as const,
  amount: 10_000,
  vatAmount: 0,
  totalAmount: 10_000,
  year: 2026,
  month: 6,
}

describe('FIX 9 · PR 2 — createJournalEntryForRentNotice', () => {
  it('bostad (APARTMENT): 1510 D 10000 / 3911 K 10000, balanserad', async () => {
    const { service, getCreated } = makeService({ unitType: 'APARTMENT' })
    await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    const lines = getCreated()!.data.lines.create
    const debit = lines.find((l) => l.debit != null)
    const credit = lines.find((l) => l.credit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1510', debit: 10_000 })
    expect(credit).toMatchObject({ accountId: 'acc-3911', credit: 10_000 })
    // Balans: summa debet === summa kredit
    const sumD = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const sumK = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
    expect(sumD).toBe(sumK)
  })

  it('lokal (OFFICE): krediterar 3913', async () => {
    const { service, getCreated } = makeService({ unitType: 'OFFICE' })
    await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    const credit = getCreated()!.data.lines.create.find((l) => l.credit != null)
    expect(credit?.accountId).toBe('acc-3913')
  })

  // #29 — lease-uppslaget är org-scopat (FIX 2, cross-tenant-läsrisk).
  it('lease-uppslaget scopas på organisationen', async () => {
    const { service, prisma } = makeService({ unitType: 'APARTMENT' })
    await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(prisma.lease.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lease-1', organizationId: 'org-1' } }),
    )
  })

  it('cross-org lease (findFirst → null) faller tillbaka till 3914', async () => {
    const { service, prisma, getCreated } = makeService({ unitType: 'APARTMENT' })
    prisma.lease.findFirst.mockResolvedValueOnce(null)
    await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    const credit = getCreated()!.data.lines.create.find((l) => l.credit != null)
    expect(credit?.accountId).toBe('acc-3914')
  })

  it('saknad unit-typ → fallback 3914', async () => {
    const { service, getCreated } = makeService({ unitType: null })
    await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    const credit = getCreated()!.data.lines.create.find((l) => l.credit != null)
    expect(credit?.accountId).toBe('acc-3914')
  })

  it('periodiserar till första dagen i avins månad', async () => {
    const { service, getCreated } = makeService({ unitType: 'APARTMENT' })
    await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(getCreated()!.data.date.toISOString().slice(0, 10)).toBe('2026-06-01')
  })

  it('moms > 0: krediterar netto på 3913 + moms på 2611, balanserad', async () => {
    const { service, getCreated } = makeService({ unitType: 'OFFICE' })
    await service.createJournalEntryForRentNotice(
      { ...baseNotice, amount: 10_000, vatAmount: 2_500, totalAmount: 12_500 },
      'org-1',
      null,
    )
    const lines = getCreated()!.data.lines.create
    expect(lines.find((l) => l.accountId === 'acc-3913')).toMatchObject({ credit: 10_000 })
    expect(lines.find((l) => l.accountId === 'acc-2611')).toMatchObject({ credit: 2_500 })
    const sumD = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const sumK = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
    expect(sumD).toBe(12_500)
    expect(sumD).toBe(sumK)
  })

  it('okänd momssats → null (döljer aldrig moms i intäktskonto)', async () => {
    const { service, prisma } = makeService({ unitType: 'OFFICE' })
    // 1000/10000 = 10% — finns inte i VAT_TO_ACCOUNT (25/12/6)
    const result = await service.createJournalEntryForRentNotice(
      { ...baseNotice, amount: 10_000, vatAmount: 1_000, totalAmount: 11_000 },
      'org-1',
      null,
    )
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('moms > 0 men momskonto saknas i kontoplanen → null', async () => {
    const { service, prisma } = makeService({
      unitType: 'OFFICE',
      accounts: [
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3913', number: 3913 },
        // 2611 saknas avsiktligt
      ],
    })
    const result = await service.createJournalEntryForRentNotice(
      { ...baseNotice, amount: 10_000, vatAmount: 2_500, totalAmount: 12_500 },
      'org-1',
      null,
    )
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('DEPOSIT-avi bokförs INTE som intäkt (returnerar null)', async () => {
    const { service, prisma } = makeService({ unitType: 'APARTMENT' })
    const result = await service.createJournalEntryForRentNotice(
      { ...baseNotice, type: 'DEPOSIT' as const },
      'org-1',
      null,
    )
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('idempotent: befintlig post → ingen ny create', async () => {
    const { service, prisma } = makeService({
      unitType: 'APARTMENT',
      existing: { id: 'je-existing' },
    })
    const result = await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(result).toMatchObject({ id: 'je-existing' })
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('saknar 1510/39xx → null (ingen halv verifikation)', async () => {
    const { service, prisma } = makeService({
      unitType: 'APARTMENT',
      accounts: [{ id: 'acc-3911', number: 3911 }],
    })
    const result = await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(result).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})

// ── T1.4 PR0 — bokförings-härdning ──────────────────────────────────────────
describe('T1.4 PR0 · createJournalEntryForRentNotice: error-logg + tx-atomicitet', () => {
  it('saknat 1510-konto → loggar ERROR (tidigare tyst return null)', async () => {
    const { service } = makeService({
      unitType: 'APARTMENT',
      // 1510 saknas → intäktskonto 3911 finns, men fordringskontot saknas.
      accounts: [{ id: 'acc-3911', number: 3911 }],
    })
    const errSpy = jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => {})
    const result = await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(result).toBeNull()
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0]![0]).toContain('1510')
    expect(errSpy.mock.calls[0]![0]).toContain('AVI-2026-06-0001')
  })

  it('saknat intäktskonto (39xx) → loggar ERROR med kontonumret', async () => {
    const { service } = makeService({
      unitType: 'APARTMENT',
      // 1510 finns, men 3911 (bostadsintäkt) saknas.
      accounts: [{ id: 'acc-1510', number: 1510 }],
    })
    const errSpy = jest
      .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => {})
    const result = await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(result).toBeNull()
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0]![0]).toContain('3911')
  })

  it('tx angiven → verifikatet skapas via tx, INGEN egen $transaction öppnas (atomiskt)', async () => {
    const { service, prisma } = makeService({ unitType: 'APARTMENT' })
    const txSpy = jest.spyOn(
      prisma as unknown as { $transaction: (cb: (t: unknown) => unknown) => unknown },
      '$transaction',
    )
    // En yttre transaktion — egen mock som speglar prisma-ytan.
    let txCreated: unknown = null
    const tx = {
      account: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'acc-1510', number: 1510 },
          { id: 'acc-3911', number: 3911 },
        ]),
      },
      lease: { findFirst: jest.fn().mockResolvedValue({ unit: { type: 'APARTMENT' } }) },
      journalEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((arg: unknown) => {
          txCreated = arg
          return Promise.resolve({ id: 'je-tx', ...(arg as object) })
        }),
      },
    }
    const result = await service.createJournalEntryForRentNotice(
      baseNotice,
      'org-1',
      null,
      tx as never,
    )
    // Verifikatet skapades på den YTTRE transaktionen …
    expect(tx.journalEntry.create).toHaveBeenCalledTimes(1)
    expect(txCreated).not.toBeNull()
    expect(result).toMatchObject({ id: 'je-tx' })
    // … och ingen ny inre $transaction öppnades, och den vanliga prisma-klienten
    // rördes inte (allt gick via tx → atomiskt med anroparens övriga writes).
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
    expect(txSpy).not.toHaveBeenCalled()
    expect(tx.account.findMany).toHaveBeenCalled()
    expect(tx.lease.findFirst).toHaveBeenCalled()
  })

  it('utan tx → oförändrat beteende (egen $transaction, prisma-klienten används)', async () => {
    const { service, prisma, getCreated } = makeService({ unitType: 'APARTMENT' })
    const txSpy = jest.spyOn(
      prisma as unknown as { $transaction: (cb: (t: unknown) => unknown) => unknown },
      '$transaction',
    )
    const result = await service.createJournalEntryForRentNotice(baseNotice, 'org-1', null)
    expect(getCreated()).not.toBeNull()
    expect(result).toMatchObject({ id: 'je-1' })
    expect(txSpy).toHaveBeenCalledTimes(1)
  })
})
