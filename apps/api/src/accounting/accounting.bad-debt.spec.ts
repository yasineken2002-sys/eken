/**
 * Inkasso PR 5 — kundförlust-bokföring i AccountingService.
 *
 * Verifierar de två bokföringskärnorna:
 *   • bookBadDebtReclassification — BEFARAD: 1515 D / 1510 K (osäker fordran,
 *     balansräkningsomklassning, ingen P&L, ingen moms),
 *   • bookBadDebtWriteOff — KONSTATERAD: 6352 D / 1515 K (resultatpåverkan),
 *   • båda MOMSFRIA — inget 26xx-momskonto rörs (lokalhyrans momsåterkrav är öppen
 *     revisorfråga och hanteras av anroparen, inte här),
 *   • idempotent via (org, source, sourceId), null vid belopp ≤ 0 eller saknat konto.
 */

import { AccountingService, MissingAccrualError } from './accounting.service'

function makeService(
  opts: {
    accounts?: Array<{ id: string; number: number }>
    existing?: boolean
    accrualMissing?: boolean
  } = {},
  defaults: Array<{ id: string; number: number }> = [],
) {
  const accounts = opts.accounts ?? defaults
  let created: {
    data: { source: string; sourceId?: string; lines: { create: Array<Record<string, unknown>> } }
  } | null = null
  const prisma = {
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    journalEntry: {
      // A2b: source='INVOICE' = accrual-guardens uppslag (finns om ej accrualMissing);
      // source='RENT_NOTICE' = createNumberedEntrys idempotens (existing/null).
      findFirst: jest
        .fn()
        .mockImplementation((args: { where?: { source?: string } }) =>
          Promise.resolve(
            args?.where?.source === 'INVOICE'
              ? opts.accrualMissing
                ? null
                : { id: 'accrual' }
              : opts.existing
                ? { id: 'je-existing' }
                : null,
          ),
        ),
      create: jest.fn().mockImplementation((arg: typeof created) => {
        created = arg
        return Promise.resolve({ id: 'je-new', ...arg })
      }),
    },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 9, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, getCreated: () => created }
}

describe('AccountingService.bookBadDebtReclassification (befarad)', () => {
  const accounts = [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-1515', number: 1515 },
  ]

  it('bokför 1515 D / 1510 K med rätt belopp', async () => {
    const { service, getCreated } = makeService({ accounts })
    const entry = await service.bookBadDebtReclassification({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'bad-debt-probable:rn-1',
      accrualSourceId: 'rent-notice:rn-1',
      amount: 8500,
      description: 'Befarad kundförlust hyresavi rn-1',
    })
    expect(entry).toMatchObject({ id: 'je-new' })
    const lines = getCreated()?.data.lines.create ?? []
    const debit = lines.find((l) => l.debit != null)
    const credit = lines.find((l) => l.credit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1515', debit: 8500 })
    expect(credit).toMatchObject({ accountId: 'acc-1510', credit: 8500 })
  })

  it('är MOMSFRI — frågar bara efter 1510/1515, inget momskonto', async () => {
    const { service, prisma, getCreated } = makeService({ accounts })
    await service.bookBadDebtReclassification({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'bad-debt-probable:rn-1',
      accrualSourceId: 'rent-notice:rn-1',
      amount: 8500,
      description: 'x',
    })
    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', number: { in: [1510, 1515] } } }),
    )
    const lines = getCreated()?.data.lines.create ?? []
    expect(lines).toHaveLength(2)
    expect(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)).toBe(8500)
    expect(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)).toBe(8500)
  })

  it('idempotent: redan bokförd → inget nytt verifikat', async () => {
    const { service, prisma } = makeService({ accounts, existing: true })
    const entry = await service.bookBadDebtReclassification({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'bad-debt-probable:rn-1',
      accrualSourceId: 'rent-notice:rn-1',
      amount: 8500,
      description: 'x',
    })
    expect(entry).toMatchObject({ id: 'je-existing' })
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('belopp ≤ 0 → null', async () => {
    const { service, prisma } = makeService({ accounts })
    expect(
      await service.bookBadDebtReclassification({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'bad-debt-probable:rn-1',
        accrualSourceId: 'rent-notice:rn-1',
        amount: 0,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('saknat 1510/1515 → null (INV-A: anroparen avbryter)', async () => {
    const { service, prisma } = makeService({ accounts: [{ id: 'acc-1510', number: 1510 }] })
    expect(
      await service.bookBadDebtReclassification({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'bad-debt-probable:rn-1',
        accrualSourceId: 'rent-notice:rn-1',
        amount: 8500,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('T5 A2b FAIL-CLOSED: orphan-avi utan accrual → NEKAS (MissingAccrualError), ingen 1510-kredit', async () => {
    const { service, prisma } = makeService({ accounts, accrualMissing: true })
    await expect(
      service.bookBadDebtReclassification({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'bad-debt-probable:rn-1',
        accrualSourceId: 'rent-notice:rn-1',
        amount: 8500,
        description: 'Befarad kundförlust hyresavi rn-1',
      }),
    ).rejects.toBeInstanceOf(MissingAccrualError)
    // Ingen journalEntry.create → 1510 krediteras aldrig utan sin debet (ingen spökkredit).
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})

describe('AccountingService.bookBadDebtWriteOff (konstaterad)', () => {
  const accounts = [
    { id: 'acc-1515', number: 1515 },
    { id: 'acc-6352', number: 6352 },
  ]

  it('bokför 6352 D / 1515 K med rätt belopp', async () => {
    const { service, getCreated } = makeService({ accounts })
    const entry = await service.bookBadDebtWriteOff({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'bad-debt-writeoff:rn-1',
      amount: 8500,
      description: 'Konstaterad kundförlust hyresavi rn-1',
    })
    expect(entry).toMatchObject({ id: 'je-new' })
    const lines = getCreated()?.data.lines.create ?? []
    const debit = lines.find((l) => l.debit != null)
    const credit = lines.find((l) => l.credit != null)
    expect(debit).toMatchObject({ accountId: 'acc-6352', debit: 8500 })
    expect(credit).toMatchObject({ accountId: 'acc-1515', credit: 8500 })
  })

  it('är MOMSFRI — frågar bara efter 1515/6352, balanserad', async () => {
    const { service, prisma, getCreated } = makeService({ accounts })
    await service.bookBadDebtWriteOff({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'bad-debt-writeoff:rn-1',
      amount: 8500,
      description: 'x',
    })
    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', number: { in: [1515, 6352] } } }),
    )
    const lines = getCreated()?.data.lines.create ?? []
    expect(lines).toHaveLength(2)
    expect(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)).toBe(8500)
    expect(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)).toBe(8500)
  })

  it('saknat 1515/6352 → null (INV-A: anroparen avbryter)', async () => {
    const { service, prisma } = makeService({ accounts: [{ id: 'acc-1515', number: 1515 }] })
    expect(
      await service.bookBadDebtWriteOff({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'bad-debt-writeoff:rn-1',
        amount: 8500,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})
