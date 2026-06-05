/**
 * Inkasso PR 3 — AccountingService.bookInterest (dröjsmålsränta).
 *
 * Verifierar att räntan bokförs 1510 D / 8131 K — en FINANSIELL intäkt — och
 * ALDRIG mot påminnelseavgiftskontot 3593 (bokföringsexpertens uttryckliga
 * poäng). Momsfri, idempotent, null vid belopp ≤ 0 eller saknat 1510/8131.
 */

import { AccountingService } from './accounting.service'

function makeService(
  opts: { accounts?: Array<{ id: string; number: number }>; existing?: boolean } = {},
) {
  const accounts = opts.accounts ?? [
    { id: 'acc-1510', number: 1510 },
    { id: 'acc-8131', number: 8131 },
    { id: 'acc-3593', number: 3593 },
  ]
  let created: {
    data: { source: string; sourceId?: string; lines: { create: Array<Record<string, unknown>> } }
  } | null = null
  const prisma = {
    account: {
      findMany: jest
        .fn()
        .mockImplementation((args: { where: { number: { in: number[] } } }) =>
          Promise.resolve(accounts.filter((a) => args.where.number.in.includes(a.number))),
        ),
    },
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
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 9, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verifikationsnummer as never)
  return { service, prisma, getCreated: () => created }
}

describe('Inkasso PR 3 — AccountingService.bookInterest', () => {
  it('bokför 1510 D / 8131 K (INTE 3593)', async () => {
    const { service, prisma, getCreated } = makeService()
    const entry = await service.bookInterest({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'interest:rn-1:2026-05-31',
      amount: 65.75,
      description: 'Dröjsmålsränta',
    })
    expect(entry).toMatchObject({ id: 'je-new' })
    // Kontouppslaget frågar efter 1510 och 8131 — aldrig 3593.
    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', number: { in: [1510, 8131] } } }),
    )
    const lines = getCreated()?.data.lines.create ?? []
    expect(lines.find((l) => l.debit != null)).toMatchObject({
      accountId: 'acc-1510',
      debit: 65.75,
    })
    expect(lines.find((l) => l.credit != null)).toMatchObject({
      accountId: 'acc-8131',
      credit: 65.75,
    })
    // 3593 får ALDRIG röras av en räntepostering.
    expect(lines.some((l) => l.accountId === 'acc-3593')).toBe(false)
  })

  it('momsfri + balanserad (debet === kredit, två rader)', async () => {
    const { service, getCreated } = makeService()
    await service.bookInterest({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'interest:rn-1:2026-05-31',
      amount: 65.75,
      description: 'x',
    })
    const lines = getCreated()?.data.lines.create ?? []
    expect(lines).toHaveLength(2)
    const d = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
    const c = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
    expect(d).toBeCloseTo(65.75)
    expect(c).toBeCloseTo(65.75)
  })

  it('idempotent: redan bokförd ränta för perioden skapar inget nytt verifikat', async () => {
    const { service, prisma } = makeService({ existing: true })
    const entry = await service.bookInterest({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'interest:rn-1:2026-05-31',
      amount: 65.75,
      description: 'x',
    })
    expect(entry).toMatchObject({ id: 'je-existing' })
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('belopp ≤ 0 → null', async () => {
    const { service, prisma } = makeService()
    expect(
      await service.bookInterest({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'interest:rn-1:2026-05-31',
        amount: 0,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })

  it('saknat 1510/8131 → null (INV-A: anroparen avbryter)', async () => {
    const { service, prisma } = makeService({ accounts: [{ id: 'acc-1510', number: 1510 }] })
    expect(
      await service.bookInterest({
        organizationId: 'org-1',
        source: 'RENT_NOTICE',
        sourceId: 'interest:rn-1:2026-05-31',
        amount: 65.75,
        description: 'x',
      }),
    ).toBeNull()
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
  })
})
