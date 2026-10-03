/**
 * F-LIST-1 (FORTNOX-100): huvudboken sidvis MED totalantal. Ett bolag med 100 lägenheter har
 * ~200 verifikat i månaden; den gamla listan (tak 100) dolde resten utan att säga det.
 * Provet mäter: alla verifikat nås exakt en gång över sidorna, totalen stämmer, filtren
 * gäller både sidor och total, och en annan organisations verifikat syns aldrig.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('F-LIST-1: getJournalEntriesPage', () => {
  let prisma: PrismaClient
  let service: AccountingService
  const orgar: string[] = []
  const sfx = randomUUID().slice(0, 8)

  async function org(namn: string, antal: number) {
    const o = await prisma.organization.create({
      data: {
        name: `fl1-${namn}-${sfx}`,
        email: `fl1-${namn}-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'S',
      },
      select: { id: true },
    })
    orgar.push(o.id)
    const konto = await prisma.account.create({
      data: { organizationId: o.id, number: 1930, name: 'Bank', type: 'ASSET' },
      select: { id: true },
    })
    for (let i = 0; i < antal; i++) {
      // Flera verifikat per dag: ordningen måste vara stabil även när datum är lika.
      await prisma.journalEntry.create({
        data: {
          organizationId: o.id,
          date: new Date(Date.UTC(2026, 10, 1 + (i % 30))),
          description: `V${i}`,
          source: i % 2 === 0 ? 'PAYMENT' : 'INVOICE',
          series: 'A',
          verNumber: i + 1,
          fiscalYear: 2026,
          lines: { create: [{ accountId: konto.id, debit: 1 }] },
        },
      })
    }
    return o.id
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
  })

  afterAll(async () => {
    for (const id of orgar) {
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.deleteMany({ where: { id } })
    }
    await prisma.$disconnect()
  })

  it('250 verifikat: tre sidor (100/100/50) når varje verifikat exakt en gång; total 250', async () => {
    const a = await org('a', 250)
    await org('b', 7)
    const sedda: string[] = []
    for (let offset = 0; offset < 300; offset += 100) {
      const s = await service.getJournalEntriesPage(a, undefined, { offset, limit: 100 })
      expect(s.total).toBe(250)
      sedda.push(...s.entries.map((e) => e.id))
    }
    expect(sedda).toHaveLength(250)
    expect(new Set(sedda).size).toBe(250)
    // Den gamla listan är oförändrad: högst 100.
    expect(await service.getJournalEntries(a)).toHaveLength(100)
  })

  it('filter gäller sidor och total; annan organisation syns inte', async () => {
    const a = orgar[0]!
    const betalningar = await service.getJournalEntriesPage(
      a,
      { source: 'PAYMENT' },
      { offset: 0, limit: 200 },
    )
    expect(betalningar.total).toBe(125)
    expect(betalningar.entries.every((e) => e.source === 'PAYMENT')).toBe(true)
    const nov1 = await service.getJournalEntriesPage(
      a,
      { from: '2026-11-01', to: '2026-11-01' },
      { offset: 0, limit: 200 },
    )
    expect(nov1.total).toBe(9)
    const b = await service.getJournalEntriesPage(orgar[1]!, undefined, { offset: 0, limit: 200 })
    expect(b.total).toBe(7)
    expect(b.entries.every((e) => e.organizationId === orgar[1])).toBe(true)
  })
})
