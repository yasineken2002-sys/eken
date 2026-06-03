/**
 * IMD · PR 3 — createJournalEntryForConsumptionCharge (BFL-korrekt verifikat).
 *
 * Verifierar bokföringen av förbrukningsersättning:
 *  • Verifikatet BALANSERAR (summa debet = summa kredit).
 *  • Datum = mätperiodens slut (periodEnd) — ALDRIG skapandedatum.
 *  • Idempotent via sourceId="consumption-charge:<id>" — dubbelbokning ger
 *    inte två verifikat.
 *  • EXEMPT ger INGEN momsrad (2611); TAXABLE_25 ger en 2611-kredit.
 *  • Rätt intäktskonto: el/värme → 3920, vatten → 3970.
 *  • Bruttoredovisning: inga kostnadskonton (5020/5040) rörs.
 */
import { AccountingService } from './accounting.service'

interface JLine {
  accountId: string
  debit?: number
  credit?: number
  description?: string
}

function makeAccounting() {
  // Stateful verifikat-lager → äkta idempotenstest (findFirst hittar tidigare).
  const store: Array<Record<string, unknown>> = []
  const prisma: Record<string, unknown> = {
    account: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-1790', number: 1790 },
        { id: 'acc-3920', number: 3920 },
        { id: 'acc-3970', number: 3970 },
        { id: 'acc-2611', number: 2611 },
      ]),
    },
    journalEntry: {
      findFirst: jest.fn(({ where }: { where: { sourceId?: string; source?: string } }) =>
        Promise.resolve(
          store.find((e) => e.sourceId === where.sourceId && e.source === where.source) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const entry = { id: `je-${store.length + 1}`, ...data }
        store.push(entry)
        return Promise.resolve(entry)
      }),
    },
  }
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma))
  const verif = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const service = new AccountingService(prisma as never, verif as never)
  return { service, prisma: prisma as unknown as MockPrisma, store }
}

interface MockPrisma {
  account: { findMany: jest.Mock }
  journalEntry: { findFirst: jest.Mock; create: jest.Mock }
}

// Plockar ut konteringsraderna ur ett journalEntry.create-anrop.
function linesOf(createMock: jest.Mock): JLine[] {
  return createMock.mock.calls[0][0].data.lines.create as JLine[]
}

function sum(lines: JLine[], key: 'debit' | 'credit'): number {
  return lines.reduce((acc, l) => acc + (l[key] ?? 0), 0)
}

const baseCharge = {
  id: 'charge-1',
  meterType: 'ELECTRICITY' as const,
  periodEnd: new Date('2026-05-31'),
  netAmount: 600,
  vatStatus: 'EXEMPT' as const,
  vatAmount: 0,
  totalAmount: 600,
}

describe('createJournalEntryForConsumptionCharge — EXEMPT (bostad, el)', () => {
  it('balanserar: 1510 D 600 / 3920 K 600, ingen momsrad', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForConsumptionCharge(baseCharge, 'org-1', 'user-9')

    const lines = linesOf(prisma.journalEntry.create)
    expect(sum(lines, 'debit')).toBe(600)
    expect(sum(lines, 'credit')).toBe(600)
    // Fordran på 1510, intäkt på 3920, ingen 2611.
    expect(lines.find((l) => l.accountId === 'acc-1510')?.debit).toBe(600)
    expect(lines.find((l) => l.accountId === 'acc-3920')?.credit).toBe(600)
    expect(lines.some((l) => l.accountId === 'acc-2611')).toBe(false)
  })

  it('daterar verifikatet till periodEnd, inte skapandedatum', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForConsumptionCharge(baseCharge, 'org-1', 'user-9')
    expect(prisma.journalEntry.create.mock.calls[0][0].data.date).toEqual(new Date('2026-05-31'))
  })
})

describe('createJournalEntryForConsumptionCharge — TAXABLE_25 (lokal, el)', () => {
  it('balanserar: 1510 D 750 / 2611 K 150 / 3920 K 600', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForConsumptionCharge(
      { ...baseCharge, vatStatus: 'TAXABLE_25', vatAmount: 150, totalAmount: 750 },
      'org-1',
      'user-9',
    )

    const lines = linesOf(prisma.journalEntry.create)
    expect(sum(lines, 'debit')).toBe(750)
    expect(sum(lines, 'credit')).toBe(750)
    expect(lines.find((l) => l.accountId === 'acc-1510')?.debit).toBe(750)
    expect(lines.find((l) => l.accountId === 'acc-2611')?.credit).toBe(150)
    expect(lines.find((l) => l.accountId === 'acc-3920')?.credit).toBe(600)
  })
})

describe('createJournalEntryForConsumptionCharge — kontoval per mätartyp', () => {
  it('vatten (WATER_COLD) krediteras 3970, inte 3920', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForConsumptionCharge(
      { ...baseCharge, meterType: 'WATER_COLD' },
      'org-1',
      'user-9',
    )
    const lines = linesOf(prisma.journalEntry.create)
    expect(lines.find((l) => l.accountId === 'acc-3970')?.credit).toBe(600)
    expect(lines.some((l) => l.accountId === 'acc-3920')).toBe(false)
  })

  it('bruttoredovisning: inga kostnadskonton (5020/5040) i verifikatet', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForConsumptionCharge(baseCharge, 'org-1', 'user-9')
    const lines = linesOf(prisma.journalEntry.create)
    // Endast 1510 + 3920 förekommer; inga 50xx-konton är ens seedade i mappen.
    expect(lines.every((l) => l.accountId === 'acc-1510' || l.accountId === 'acc-3920')).toBe(true)
  })
})

describe('createJournalEntryForConsumptionCharge — idempotens', () => {
  it('dubbelbokning skapar inte två verifikat', async () => {
    const { service, prisma, store } = makeAccounting()
    await service.createJournalEntryForConsumptionCharge(baseCharge, 'org-1', 'user-9')
    await service.createJournalEntryForConsumptionCharge(baseCharge, 'org-1', 'user-9')

    expect(prisma.journalEntry.create).toHaveBeenCalledTimes(1)
    expect(store).toHaveLength(1)
  })
})

// ── IMD · PR 5 — bokslut: upplupen förbrukningsintäkt (1790) ──────────────────

const baseAccrual = {
  meterId: 'meter-1',
  meterType: 'ELECTRICITY' as const,
  fiscalYear: 2026,
  yearEndDate: new Date('2026-12-31'),
  reversalDate: new Date('2027-01-01'),
  netAmount: 500,
  vatStatus: 'EXEMPT' as const,
  vatAmount: 0,
  totalAmount: 500,
}

// Konteringsrader för en specifik journalEntry.create-call (0 = accrual, 1 = reversal).
function linesOfCall(createMock: jest.Mock, call: number): JLine[] {
  return createMock.mock.calls[call][0].data.lines.create as JLine[]
}

describe('createConsumptionAccrualEntry — accrual + reversal (EXEMPT)', () => {
  it('accrual balanserar 1790 D 500 / 3920 K 500, daterad årsslut', async () => {
    const { service, prisma } = makeAccounting()
    await service.createConsumptionAccrualEntry(baseAccrual, 'org-1', 'user-9')

    const accrual = linesOfCall(prisma.journalEntry.create, 0)
    expect(sum(accrual, 'debit')).toBe(500)
    expect(sum(accrual, 'credit')).toBe(500)
    expect(accrual.find((l) => l.accountId === 'acc-1790')?.debit).toBe(500)
    expect(accrual.find((l) => l.accountId === 'acc-3920')?.credit).toBe(500)
    expect(prisma.journalEntry.create.mock.calls[0][0].data.date).toEqual(new Date('2026-12-31'))
  })

  it('reversal speglar accrual rad-för-rad och dateras 1/1 nästa år', async () => {
    const { service, prisma } = makeAccounting()
    await service.createConsumptionAccrualEntry(baseAccrual, 'org-1', 'user-9')

    const reversal = linesOfCall(prisma.journalEntry.create, 1)
    expect(sum(reversal, 'debit')).toBe(500)
    expect(sum(reversal, 'credit')).toBe(500)
    // Spegling: 1790 krediteras, intäkten debiteras (tvärtom mot accrual).
    expect(reversal.find((l) => l.accountId === 'acc-1790')?.credit).toBe(500)
    expect(reversal.find((l) => l.accountId === 'acc-3920')?.debit).toBe(500)
    expect(prisma.journalEntry.create.mock.calls[1][0].data.date).toEqual(new Date('2027-01-01'))
  })
})

describe('createConsumptionAccrualEntry — TAXABLE_25 + vatten', () => {
  it('TAXABLE: accrual 1790 D 625 / 2611 K 125 / 3920 K 500; reversal speglar', async () => {
    const { service, prisma } = makeAccounting()
    await service.createConsumptionAccrualEntry(
      { ...baseAccrual, vatStatus: 'TAXABLE_25', vatAmount: 125, totalAmount: 625 },
      'org-1',
      'user-9',
    )
    const accrual = linesOfCall(prisma.journalEntry.create, 0)
    expect(sum(accrual, 'debit')).toBe(625)
    expect(sum(accrual, 'credit')).toBe(625)
    expect(accrual.find((l) => l.accountId === 'acc-2611')?.credit).toBe(125)

    const reversal = linesOfCall(prisma.journalEntry.create, 1)
    expect(sum(reversal, 'debit')).toBe(625)
    expect(reversal.find((l) => l.accountId === 'acc-2611')?.debit).toBe(125)
  })

  it('vatten (WATER_COLD) periodiseras mot 3970', async () => {
    const { service, prisma } = makeAccounting()
    await service.createConsumptionAccrualEntry(
      { ...baseAccrual, meterType: 'WATER_COLD' },
      'org-1',
      'user-9',
    )
    const accrual = linesOfCall(prisma.journalEntry.create, 0)
    expect(accrual.find((l) => l.accountId === 'acc-3970')?.credit).toBe(500)
    expect(accrual.some((l) => l.accountId === 'acc-3920')).toBe(false)
  })
})

describe('createConsumptionAccrualEntry — idempotens', () => {
  it('omkörning skapar inte dubbla accrual/reversal', async () => {
    const { service, prisma, store } = makeAccounting()
    await service.createConsumptionAccrualEntry(baseAccrual, 'org-1', 'user-9')
    await service.createConsumptionAccrualEntry(baseAccrual, 'org-1', 'user-9')

    // Två verifikat totalt (accrual + reversal), inte fyra.
    expect(prisma.journalEntry.create).toHaveBeenCalledTimes(2)
    expect(store).toHaveLength(2)
  })
})
