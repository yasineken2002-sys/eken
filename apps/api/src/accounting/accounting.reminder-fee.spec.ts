/**
 * Inkasso PR 2 — delad bookReminderFee i AccountingService.
 *
 * Verifierar bokföringskärnan som BÅDE faktura- och hyresavi-flödet använder:
 *   • 1510 D / 3593 K (kundfordran ökar, momsfri påminnelseintäkt),
 *   • MOMSFRI — inget 26xx-momskonto rörs, oavsett underliggande upplåtelsetyp,
 *   • idempotent via (org, source, sourceId),
 *   • returnerar null vid avgift ≤ 0 eller saknat 1510/3593 (anroparen avbryter).
 */

import { AccountingService } from './accounting.service'

function makeService(
  opts: { accounts?: Array<{ id: string; number: number }>; existing?: boolean } = {},
) {
  const accounts = opts.accounts ?? [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-3593', number: 3593 },
  ]
  let created: {
    data: { source: string; sourceId?: string; lines: { create: Array<Record<string, unknown>> } }
  } | null = null
  const prisma = {
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(opts.existing ? { id: 'je-existing' } : null),
      create: jest.fn().mockImplementation((arg: typeof created) => {
        created = arg
        return Promise.resolve({ id: 'je-new', ...arg })
      }),
    },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 7, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, getCreated: () => created }
}

describe('Inkasso PR 2 — AccountingService.bookReminderFee', () => {
  it('bokför 1510 D / 3593 K med rätt belopp', async () => {
    const { service, getCreated } = makeService()
    const entry = await service.bookReminderFee({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'reminder-fee:rn-1',
      fee: 60,
      description: 'Påminnelseavgift hyresavi rn-1',
    })
    expect(entry).toMatchObject({ id: 'je-new' })
    const lines = getCreated()?.data.lines.create ?? []
    const debit = lines.find((l) => l.debit != null)
    const credit = lines.find((l) => l.credit != null)
    expect(debit).toMatchObject({ accountId: 'acc-1510', debit: 60 })
    expect(credit).toMatchObject({ accountId: 'acc-3593', credit: 60 })
  })

  it('är MOMSFRI — inget momskonto (26xx) bokförs', async () => {
    const { service, prisma, getCreated } = makeService()
    await service.bookReminderFee({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'reminder-fee:rn-1',
      fee: 60,
      description: 'x',
    })
    // Kontouppslaget frågar BARA efter 1510 och 3593 — aldrig ett momskonto.
    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', number: { in: [1510, 3593] } } }),
    )
    const lines = getCreated()?.data.lines.create ?? []
    expect(lines).toHaveLength(2)
    // Balans: debet === kredit, inget momsben.
    const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
    expect(totalDebit).toBe(60)
    expect(totalCredit).toBe(60)
  })

  it('märker verifikatet med source/sourceId för idempotens', async () => {
    const { service, getCreated } = makeService()
    await service.bookReminderFee({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'reminder-fee:rn-1',
      fee: 60,
      description: 'x',
    })
    expect(getCreated()?.data.source).toBe('RENT_NOTICE')
    expect(getCreated()?.data.sourceId).toBe('reminder-fee:rn-1')
  })

  it('idempotent: redan bokförd avgift skapar inget nytt verifikat', async () => {
    const { service, prisma } = makeService({ existing: true })
    const entry = await service.bookReminderFee({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'reminder-fee:rn-1',
      fee: 60,
      description: 'x',
    })
    expect(entry).toMatchObject({ id: 'je-existing' })
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('avgift ≤ 0 → null, ingen bokföring', async () => {
    const { service, prisma } = makeService()
    expect(
      await service.bookReminderFee({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'reminder-fee:rn-1',
        fee: 0,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('saknat 1510/3593 → null (INV-A: anroparen avbryter eskaleringen)', async () => {
    const { service, prisma } = makeService({ accounts: [{ id: 'acc-1510', number: 1510 }] })
    expect(
      await service.bookReminderFee({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'reminder-fee:rn-1',
        fee: 60,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})
