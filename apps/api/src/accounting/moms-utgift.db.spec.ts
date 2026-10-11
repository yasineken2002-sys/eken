/**
 * TESTKUND-041 (moms v1, B-6; ACCEPTANS A4/A5): utgiftsvägen och det manuella 2641-valet mot riktig
 * Postgres genom AccountingService (samma tjänst som POST /accounting/expenses och journal-entries).
 * Radfacit i öre; beslutsproveniensen läses ur ExpenseVatDecision.
 */
import { randomUUID } from 'node:crypto'
import { BadRequestException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

medDb('TESTKUND-041: utgift och manuellt momsval', () => {
  let prisma: PrismaClient
  let acc: AccountingService
  let orgId: string
  let userId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `utg-${sfx}`,
        email: `utg-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgId = org.id
    userId = (
      await prisma.user.create({
        data: {
          organizationId: orgId,
          email: `utg-${sfx}@example.invalid`,
          firstName: 'U',
          lastName: 'P',
          role: 'OWNER',
          passwordHash: 'x',
        },
      })
    ).id
    acc = new AccountingService(
      prisma as unknown as PrismaService,
      new VerifikationsnummerService(prisma as unknown as PrismaService),
    )
    await acc.seedDefaultAccounts(orgId)
  })

  afterAll(async () => {
    await prisma.expenseVatDecision.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  const rader = async (id: string) =>
    (
      await prisma.journalEntryLine.findMany({
        where: { journalEntryId: id },
        include: { account: true },
      })
    )
      .map((l) => [
        l.account.number,
        Math.round(Number(l.debit ?? 0) * 100),
        Math.round(Number(l.credit ?? 0) * 100),
      ])
      .sort((a, b) => a[0]! - b[0]!)
  const utgift = (val: 'INGEN_MOMS' | 'HELT_AVDRAG' | 'INGET_AVDRAG' | null, moms: number) =>
    acc.recordManualExpense({
      organizationId: orgId,
      date: new Date('2026-08-12'),
      idempotencyKey: `utg-${randomUUID()}`,
      createdById: userId,
      utgift: { belopp: 1250, moms, kontonummer: 5070, beskrivning: 'Rörmokare' },
      momsbeslut: val ? { val, source: 'HTTP_FORMULAR' } : null,
    })

  it('A4: HELT → kostnad netto + 2641 + bank brutto; INGET → kostnad brutto, ingen 2641; beslut sparat atomiskt', async () => {
    const helt = await utgift('HELT_AVDRAG', 250)
    const inget = await utgift('INGET_AVDRAG', 250)
    expect(await rader(helt.id)).toEqual([
      [1930, 0, 125000],
      [2641, 25000, 0],
      [5070, 100000, 0],
    ])
    expect(await rader(inget.id)).toEqual([
      [1930, 0, 125000],
      [5070, 125000, 0],
    ])
    const b = await prisma.expenseVatDecision.findUniqueOrThrow({
      where: { journalEntryId: inget.id },
    })
    expect([
      b.vatTreatment,
      Number(b.netAmount),
      Number(b.vatAmount),
      Number(b.grossAmount),
      b.decidedById,
      b.source,
    ]).toEqual(['INGET_AVDRAG', 1250, 250, 1250, userId, 'HTTP_FORMULAR'])
  })

  it('A4: positiv moms utan val, Ingen moms med moms → 400 och inget verifikat', async () => {
    const fore = await prisma.journalEntry.count({ where: { organizationId: orgId } })
    await expect(utgift(null, 250)).rejects.toBeInstanceOf(BadRequestException)
    await expect(utgift('INGEN_MOMS', 250)).rejects.toBeInstanceOf(BadRequestException)
    expect(await prisma.journalEntry.count({ where: { organizationId: orgId } })).toBe(fore)
  })

  it('A5: manuellt verifikat med 2641 tillåts och märks «manuellt momsval» i momsrapportens källor; utgiftens val syns', async () => {
    const manuell = await acc.createManualJournalEntry({
      organizationId: orgId,
      date: new Date('2026-08-20'),
      description: 'Momsrättelse av redovisningskonsult',
      lines: [
        { accountNumber: 2641, debit: 100 },
        { accountNumber: 1930, credit: 100 },
      ],
      idempotencyKey: `man-${randomUUID()}`,
      createdById: userId,
    })
    const vr = await acc.getVatReport(orgId, '2026-08-01', '2026-08-31')
    const egen = vr.incoming.sources?.find(
      (s) => s.verifikat === `${manuell.series}${manuell.verNumber}`,
    )
    expect(egen).toMatchObject({ kalla: 'MANUELLT_MOMSVAL', belopp: 100 })
    expect(vr.incoming.sources?.filter((s) => s.kalla === 'UTGIFT').map((s) => s.momsval)).toEqual([
      'HELT_AVDRAG',
    ])
    expect(vr.incoming.total).toBe(350)
  })
})
