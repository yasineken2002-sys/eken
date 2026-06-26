/**
 * Teknisk förvaltning · Spår A PR 2 — createJournalEntryForMiscCharge
 * (BFL-korrekt verifikat för övrig debiterbar post mot hyresgäst).
 *
 * Verifierar:
 *  • Verifikatet BALANSERAR (summa debet = summa kredit).
 *  • Kontering 1510 D / 3990 K på totalAmount (EXEMPT: ingen 2611-rad).
 *  • TAXABLE_25 ger en 2611-kredit och 3990 K på net (faller ut av snapshotet,
 *    ingen hårdkodad momsfrihet).
 *  • Datum = incidentDate — ALDRIG skapandedatum.
 *  • Idempotent via sourceId="misc-charge:<id>" — två anrop ger EN entry.
 *  • Statusflipp DRAFT → CONFIRMED sker atomiskt; ATTACHED/CANCELLED rörs ej.
 *  • CANCELLED → BadRequest (boka inte); okänd post → NotFound.
 *  • Verifikat-texten refererar ärendenumret (UND-xxxxx), aldrig description.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { AccountingService } from './accounting.service'

interface JLine {
  accountId: string
  debit?: number
  credit?: number
  description?: string
}

const baseCharge = {
  id: 'mc-1',
  organizationId: 'org-1',
  status: 'DRAFT' as 'DRAFT' | 'CONFIRMED' | 'ATTACHED' | 'CANCELLED',
  sourceType: 'MAINTENANCE_TICKET' as const,
  sourceRefId: 'ticket-abcdef12',
  description: 'Krossad ruta — Anna Andersson lgh 1201', // PII: får ALDRIG nå verifikatet
  incidentDate: new Date('2026-04-15'),
  netAmount: 800,
  vatStatus: 'EXEMPT' as 'EXEMPT' | 'TAXABLE_25',
  vatRate: 0,
  vatAmount: 0,
  totalAmount: 800,
  maintenanceTicket: { ticketNumber: 'UND-00042' },
}

function makeAccounting(charge: Record<string, unknown> | null = { ...baseCharge }) {
  // Stateful verifikat-lager → äkta idempotenstest (findFirst hittar tidigare).
  const store: Array<Record<string, unknown>> = []
  const miscChargeUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma: Record<string, unknown> = {
    miscCharge: {
      findFirst: jest.fn().mockResolvedValue(charge),
      updateMany: miscChargeUpdateMany,
    },
    account: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3990', number: 3990 },
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
  return { service, prisma: prisma as unknown as MockPrisma, store, miscChargeUpdateMany }
}

interface MockPrisma {
  miscCharge: { findFirst: jest.Mock; updateMany: jest.Mock }
  account: { findMany: jest.Mock }
  journalEntry: { findFirst: jest.Mock; create: jest.Mock }
}

function linesOf(createMock: jest.Mock): JLine[] {
  return createMock.mock.calls[0][0].data.lines.create as JLine[]
}

function sum(lines: JLine[], key: 'debit' | 'credit'): number {
  return lines.reduce((acc, l) => acc + (l[key] ?? 0), 0)
}

describe('createJournalEntryForMiscCharge — EXEMPT (bostad)', () => {
  it('balanserar: 1510 D 800 / 3990 K 800, ingen momsrad', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')

    const lines = linesOf(prisma.journalEntry.create)
    expect(sum(lines, 'debit')).toBe(800)
    expect(sum(lines, 'credit')).toBe(800)
    expect(lines.find((l) => l.accountId === 'acc-1510')?.debit).toBe(800)
    expect(lines.find((l) => l.accountId === 'acc-3990')?.credit).toBe(800)
    expect(lines.some((l) => l.accountId === 'acc-2611')).toBe(false)
  })

  it('daterar verifikatet till incidentDate, inte skapandedatum', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')
    expect(prisma.journalEntry.create.mock.calls[0][0].data.date).toEqual(new Date('2026-04-15'))
  })

  it('verifikat-texten refererar ärendenumret, aldrig MiscCharge.description (PII)', async () => {
    const { service, prisma } = makeAccounting()
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')

    const data = prisma.journalEntry.create.mock.calls[0][0].data
    const lines = data.lines.create as JLine[]
    const allText = [data.description, ...lines.map((l) => l.description)].join(' | ')
    expect(allText).toContain('UND-00042')
    expect(allText).not.toContain('Anna Andersson')
    expect(allText).not.toContain('ruta')
  })

  it('flippar status DRAFT → CONFIRMED atomiskt', async () => {
    const { service, miscChargeUpdateMany } = makeAccounting()
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')
    expect(miscChargeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'mc-1', organizationId: 'org-1', status: 'DRAFT' },
      data: { status: 'CONFIRMED' },
    })
  })
})

describe('createJournalEntryForMiscCharge — TAXABLE_25 (lokal, framtida)', () => {
  it('balanserar: 1510 D 1000 / 2611 K 200 / 3990 K 800 (faller ut av snapshotet)', async () => {
    const { service, prisma } = makeAccounting({
      ...baseCharge,
      vatStatus: 'TAXABLE_25',
      vatRate: 25,
      vatAmount: 200,
      totalAmount: 1000,
    })
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')

    const lines = linesOf(prisma.journalEntry.create)
    expect(sum(lines, 'debit')).toBe(1000)
    expect(sum(lines, 'credit')).toBe(1000)
    expect(lines.find((l) => l.accountId === 'acc-1510')?.debit).toBe(1000)
    expect(lines.find((l) => l.accountId === 'acc-2611')?.credit).toBe(200)
    expect(lines.find((l) => l.accountId === 'acc-3990')?.credit).toBe(800)
  })
})

describe('createJournalEntryForMiscCharge — idempotens', () => {
  it('dubbelbokning skapar inte två verifikat', async () => {
    const { service, prisma, store } = makeAccounting()
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')

    expect(prisma.journalEntry.create).toHaveBeenCalledTimes(1)
    expect(store).toHaveLength(1)
  })

  it('redan CONFIRMED men verifikat saknas → self-heal skapar verifikatet', async () => {
    // Verifikatet (inte status) är sanningskällan: status=CONFIRMED men tomt
    // ledger → anropet skapar ändå posten.
    const { service, prisma, store } = makeAccounting({ ...baseCharge, status: 'CONFIRMED' })
    await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')
    expect(prisma.journalEntry.create).toHaveBeenCalledTimes(1)
    expect(store).toHaveLength(1)
  })
})

describe('createJournalEntryForMiscCharge — icke-bokningsbara utfall', () => {
  it('CANCELLED → BadRequest, inget verifikat och ingen statusflipp', async () => {
    const { service, prisma, miscChargeUpdateMany } = makeAccounting({
      ...baseCharge,
      status: 'CANCELLED',
    })
    await expect(
      service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9'),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.journalEntry.create).not.toHaveBeenCalled()
    expect(miscChargeUpdateMany).not.toHaveBeenCalled()
  })

  it('okänd post (annan org) → NotFound', async () => {
    const { service } = makeAccounting(null)
    await expect(
      service.createJournalEntryForMiscCharge('mc-x', 'org-1', 'user-9'),
    ).rejects.toThrow(NotFoundException)
  })

  it('saknas konto 3990 i kontoplanen → null, ingen statusflipp', async () => {
    const { service, miscChargeUpdateMany, prisma } = makeAccounting()
    prisma.account.findMany.mockResolvedValueOnce([
      { id: 'acc-1510', number: 1510 },
      { id: 'acc-2611', number: 2611 },
    ])
    const result = await service.createJournalEntryForMiscCharge('mc-1', 'org-1', 'user-9')
    expect(result).toBeNull()
    expect(miscChargeUpdateMany).not.toHaveBeenCalled()
  })
})
