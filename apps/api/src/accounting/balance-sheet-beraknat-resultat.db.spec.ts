/**
 * F-TK-1 (TESTKUND-20261004): balansräkningen ska inte påstå att korrekt bokföring är obalanserad.
 *
 * Före rättningen summerade getBalanceSheet bara konton < 3000. Årets ännu inte bokslutade
 * resultat (resultatkonton 3000–8999) saknades därför i skulder och eget kapital, och
 * `difference` blev exakt resultatet → "boken balanserar inte" för varje organisation med
 * intäkter eller kostnader.
 *
 * Rättningen redovisar Σ(kredit − debet) på resultatkonton för verifikat med datum ≤ asOf som en
 * egen, märkt BERÄKNAD rad (`calculatedResult`). Årsstängningen nollställer resultatkontona mot
 * årets resultat-konto (accounting-period.service buildYearEndDraft) och dateras årets sista dag,
 * så efter bokslutet är raden 0 och resultatet ligger på 20xx-kontot — ingen dubbelräkning.
 * Inga verifikat, konton eller bokslut skapas av rapporten. Förväntningarna frystes före ändringen
 * (FORVANTAN-F-TK-1.md, P1–P6 och N).
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('F-TK-1: beräknat resultat (ej bokslutat) i balansräkningen', () => {
  let prisma: PrismaClient
  let service: AccountingService
  const orgar: string[] = []
  const sfx = randomUUID().slice(0, 8)

  type Rad = [konto: number, debet: number, kredit: number]
  async function org(namn: string, verifikat: Array<{ datum: string; rader: Rad[] }>) {
    const o = await prisma.organization.create({
      data: {
        name: `ftk1-${namn}-${sfx}`,
        email: `ftk1-${namn}-${sfx}@example.com`,
        street: 'a',
        postalCode: '11111',
        city: 'S',
      },
      select: { id: true },
    })
    orgar.push(o.id)
    const konton = new Map<number, string>()
    const konto = async (n: number) => {
      if (!konton.has(n)) {
        const a = await prisma.account.create({
          data: {
            organizationId: o.id,
            number: n,
            name: `Konto ${n}`,
            type: n < 2000 ? 'ASSET' : n < 3000 ? 'LIABILITY' : n < 4000 ? 'REVENUE' : 'EXPENSE',
          },
          select: { id: true },
        })
        konton.set(n, a.id)
      }
      return konton.get(n)!
    }
    let nr = 0
    for (const v of verifikat) {
      const lines = []
      for (const [k, d, c] of v.rader)
        lines.push({
          accountId: await konto(k),
          ...(d ? { debit: d } : {}),
          ...(c ? { credit: c } : {}),
        })
      nr += 1
      await prisma.journalEntry.create({
        data: {
          organizationId: o.id,
          date: new Date(`${v.datum}T00:00:00Z`),
          description: `F-TK-1 ${namn} ${nr}`,
          source: 'MANUAL',
          series: 'A',
          verNumber: nr,
          fiscalYear: Number(v.datum.slice(0, 4)),
          lines: { create: lines },
        },
      })
    }
    return o.id
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    service = new AccountingService(
      prisma as unknown as PrismaService,
      new VerifikationsnummerService(prisma as unknown as PrismaService),
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

  it('P1 intäkt: beräknat resultat 1 000 i skulder och eget kapital, differens 0', async () => {
    const id = await org('p1', [
      {
        datum: '2026-10-01',
        rader: [
          [1510, 1000, 0],
          [3911, 0, 1000],
        ],
      },
    ])
    const bs = await service.getBalanceSheet(id, '2026-10-31')
    expect(bs.assets.total).toBe(1000)
    expect(bs.calculatedResult).toEqual({ amount: 1000, label: 'Beräknat resultat (ej bokslutat)' })
    expect(bs.liabilitiesAndEquity.total).toBe(1000)
    expect(bs.difference).toBe(0)
    // Ingen låtsad kontorad: kontolistan innehåller bara verkliga konton < 3000.
    expect(bs.liabilitiesAndEquity.accounts.every((a) => a.number >= 2000 && a.number < 3000)).toBe(
      true,
    )
    expect(bs.oppningskomponent).toBeNull()
  })

  it('P2 kostnad/förlust: beräknat resultat −500, differens 0', async () => {
    const id = await org('p2', [
      {
        datum: '2026-10-05',
        rader: [
          [5170, 500, 0],
          [1930, 0, 500],
        ],
      },
    ])
    const bs = await service.getBalanceSheet(id, '2026-10-31')
    expect(bs.assets.total).toBe(-500)
    expect(bs.calculatedResult?.amount).toBe(-500)
    expect(bs.liabilitiesAndEquity.total).toBe(-500)
    expect(bs.difference).toBe(0)
  })

  it('P3 nollresultat: beräknat 0, differens 0', async () => {
    const id = await org('p3', [
      {
        datum: '2026-10-01',
        rader: [
          [1510, 1000, 0],
          [3911, 0, 1000],
        ],
      },
      {
        datum: '2026-10-02',
        rader: [
          [5170, 1000, 0],
          [1510, 0, 1000],
        ],
      },
    ])
    const bs = await service.getBalanceSheet(id, '2026-10-31')
    expect(bs.calculatedResult?.amount).toBe(0)
    expect(bs.difference).toBe(0)
  })

  it('P4 före/efter bokslut och asOf: ingen dubbelräkning', async () => {
    const id = await org('p4', [
      {
        datum: '2025-06-01',
        rader: [
          [1510, 1000, 0],
          [3911, 0, 1000],
        ],
      },
      // Bokslutsverifikatet så som årsstängningen bokför det: nollställ 3911 mot 2099, årets sista dag.
      {
        datum: '2025-12-31',
        rader: [
          [3911, 1000, 0],
          [2099, 0, 1000],
        ],
      },
      {
        datum: '2026-03-01',
        rader: [
          [1510, 200, 0],
          [3911, 0, 200],
        ],
      },
    ])
    const fore = await service.getBalanceSheet(id, '2025-12-30')
    expect(fore.calculatedResult?.amount).toBe(1000)
    expect(fore.liabilitiesAndEquity.accounts.find((a) => a.number === 2099)).toBeUndefined()
    expect(fore.difference).toBe(0)
    const vid = await service.getBalanceSheet(id, '2025-12-31')
    expect(vid.calculatedResult?.amount).toBe(0)
    expect(vid.liabilitiesAndEquity.accounts.find((a) => a.number === 2099)?.balance).toBe(1000)
    expect(vid.liabilitiesAndEquity.total).toBe(1000)
    expect(vid.difference).toBe(0)
    const efter = await service.getBalanceSheet(id, '2026-12-31')
    expect(efter.calculatedResult?.amount).toBe(200)
    expect(efter.liabilitiesAndEquity.total).toBe(1200)
    expect(efter.assets.total).toBe(1200)
    expect(efter.difference).toBe(0)
  })

  it('P5 en verklig differens syns fortfarande (ensam rad utan motrad)', async () => {
    const id = await org('p5', [
      {
        datum: '2026-10-01',
        rader: [
          [1510, 1000, 0],
          [3911, 0, 1000],
        ],
      },
      { datum: '2026-10-02', rader: [[1930, 100, 0]] },
    ])
    const bs = await service.getBalanceSheet(id, '2026-10-31')
    expect(bs.calculatedResult?.amount).toBe(1000)
    expect(bs.difference).toBe(100)
  })

  it('P6 organisation och asOf avgränsar: annan organisation och senare verifikat räknas inte', async () => {
    const id = await org('p6a', [
      {
        datum: '2026-10-01',
        rader: [
          [1510, 1000, 0],
          [3911, 0, 1000],
        ],
      },
      {
        datum: '2026-11-15',
        rader: [
          [1510, 300, 0],
          [3911, 0, 300],
        ],
      },
    ])
    await org('p6b', [
      {
        datum: '2026-10-01',
        rader: [
          [1510, 9999, 0],
          [3911, 0, 9999],
        ],
      },
    ])
    const bs = await service.getBalanceSheet(id, '2026-10-31')
    expect(bs.calculatedResult?.amount).toBe(1000)
    expect(bs.assets.total).toBe(1000)
    expect(bs.difference).toBe(0)
  })

  it('rapporten skapar inga verifikat eller konton', async () => {
    const id = await org('ro', [
      {
        datum: '2026-10-01',
        rader: [
          [1510, 1000, 0],
          [3911, 0, 1000],
        ],
      },
    ])
    const fore = [
      await prisma.journalEntry.count({ where: { organizationId: id } }),
      await prisma.account.count({ where: { organizationId: id } }),
    ]
    await service.getBalanceSheet(id, '2026-10-31')
    await service.getBalanceSheet(id, '2027-12-31')
    expect([
      await prisma.journalEntry.count({ where: { organizationId: id } }),
      await prisma.account.count({ where: { organizationId: id } }),
    ]).toEqual(fore)
  })
})
