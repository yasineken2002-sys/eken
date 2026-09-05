/**
 * MANUELL BOKFÖRING MOT RIKTIG POSTGRES — idempotensen och balansgrinden.
 *
 * ── VARFÖR INTE MOT EN ATTRAPP ──────────────────────────────────────────────
 *
 * Idempotensen är databasens egenskap, inte kodens: det unika indexet
 * `(organizationId, source, sourceId)` är det som gör att två skickningar med
 * samma nyckel ger EN journalpost. En attrapp returnerar det den blev tillsagd
 * att returnera oavsett `where` — den kan visa att koden FRÅGAR, aldrig att
 * databasen SVARAR nej. Det är CLAUDE.mds regel om den för grova nämnaren i
 * renodlad form.
 *
 * Och den andra riktningen är den som bara går att mäta här: TVÅ LEGITIMA
 * skickningar (olika nycklar) ska ge TVÅ verifikat. En för grov avgränsning i
 * uppslaget hade tystat den andra som en "dubblett", och en mockad `findFirst`
 * hade sett likadan ut i båda fallen.
 *
 * ── RIGGEN SKAPAR SINA EGNA FÖRUTSÄTTNINGAR ─────────────────────────────────
 *
 * Egen organisation per körning, egen kontoplan, och städning i FK-riktning
 * efteråt. Ingenting lånas ur `eken_dev` — en rigg som gör `findFirst()` på en
 * befintlig org mäter omgivningen och är grön lokalt, röd i CI (#612).
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { byggUtgiftsrader, byggVerifikatrader } from './manual-entry'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('manuell bokföring — idempotens per (org, source, sourceId)', () => {
  let prisma: PrismaClient
  let orgId: string
  let konton: Map<number, string>

  beforeAll(async () => {
    prisma = new PrismaClient()
    const suffix = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `manuell-${suffix}`,
        email: `manuell-${suffix}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id

    const specar = [
      { number: 1930, name: 'Företagskonto', type: 'ASSET' as const },
      { number: 2641, name: 'Ingående moms', type: 'ASSET' as const },
      { number: 3011, name: 'Hyresintäkter', type: 'REVENUE' as const },
      { number: 5070, name: 'Reparationer', type: 'EXPENSE' as const },
    ]
    konton = new Map()
    for (const s of specar) {
      const konto = await prisma.account.create({
        data: { organizationId: orgId, number: s.number, name: s.name, type: s.type },
      })
      konton.set(s.number, konto.id)
    }
  })

  afterAll(async () => {
    // FK-riktning: rader före poster, poster före konton, konton före org.
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /**
   * Skriver ett verifikat på exakt det sätt `createNumberedEntry` gör: uppslag
   * på (org, source, sourceId) först, skapa bara om ingen finns. Riggen går inte
   * genom tjänsten därför att tjänsten kräver hela Nest-grafen; det som prövas
   * är DATABASENS svar på nyckeln, och det är samma nyckel.
   */
  async function bokfor(
    sourceId: string,
    rader: Array<{ accountId: string; debit?: number; credit?: number }>,
  ) {
    const befintlig = await prisma.journalEntry.findFirst({
      where: { organizationId: orgId, source: 'MANUAL', sourceId },
    })
    if (befintlig) return { id: befintlig.id, skapad: false }
    const skapad = await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date('2026-09-05'),
        description: `Manuellt ${sourceId}`,
        source: 'MANUAL',
        sourceId,
        series: 'V',
        verNumber: Math.floor(Math.random() * 1_000_000),
        fiscalYear: 2026,
        lines: { create: rader },
      },
    })
    return { id: skapad.id, skapad: true }
  }

  it('SAMMA nyckel två gånger → EN journalpost', async () => {
    const byggt = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 1000 },
        { accountNumber: 3011, credit: 1000 },
      ],
      konton,
    )
    if (!byggt.ok) throw new Error(byggt.fel)

    const nyckel = `manual-journal:${randomUUID()}`
    const forsta = await bokfor(nyckel, byggt.rader)
    const andra = await bokfor(nyckel, byggt.rader)

    expect(forsta.skapad).toBe(true)
    expect(andra.skapad).toBe(false)
    expect(andra.id).toBe(forsta.id)

    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'MANUAL', sourceId: nyckel },
    })
    expect(antal).toBe(1)
  })

  it('OLIKA nycklar → TVÅ journalposter (spärren får inte hindra riktigt arbete)', async () => {
    // Den riktning en attrapp inte kan pröva. Utan den mäter provet ovan bara
    // halva frågan: en för grov avgränsning hade gett "1" också här.
    const byggt = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 500 },
        { accountNumber: 3011, credit: 500 },
      ],
      konton,
    )
    if (!byggt.ok) throw new Error(byggt.fel)

    const a = `manual-journal:${randomUUID()}`
    const b = `manual-journal:${randomUUID()}`
    const forsta = await bokfor(a, byggt.rader)
    const andra = await bokfor(b, byggt.rader)

    expect(forsta.skapad).toBe(true)
    expect(andra.skapad).toBe(true)
    expect(andra.id).not.toBe(forsta.id)
  })

  it('AI-vägens och människovägens namnrymder krockar INTE', async () => {
    // Samma sourceId i två källor är två verifikat. Det är avsiktligt: en
    // hyresvärd som medvetet bokför samma belopp som AI:n nyss bokförde ska
    // inte tystas bort som en dubblett av något hen inte gjorde.
    const byggt = byggVerifikatrader(
      [
        { accountNumber: 1930, debit: 250 },
        { accountNumber: 3011, credit: 250 },
      ],
      konton,
    )
    if (!byggt.ok) throw new Error(byggt.fel)
    const delad = `kollision-${randomUUID().slice(0, 8)}`

    await bokfor(delad, byggt.rader)
    await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date('2026-09-05'),
        description: 'AI-verifikat med samma sourceId',
        source: 'AI',
        sourceId: delad,
        series: 'V',
        verNumber: Math.floor(Math.random() * 1_000_000),
        fiscalYear: 2026,
        lines: { create: byggt.rader },
      },
    })

    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, sourceId: delad },
    })
    expect(antal).toBe(2)
  })

  it('utgiften konterar netto + moms mot brutto, och raderna balanserar i DATABASEN', async () => {
    const byggt = byggUtgiftsrader(
      { belopp: 1250, moms: 250, kontonummer: 5070, beskrivning: 'Rörmokare' },
      konton,
    )
    if (!byggt.ok) throw new Error(byggt.fel)

    const nyckel = `manual-expense:${randomUUID()}`
    const { id } = await bokfor(nyckel, byggt.rader)

    const rader = await prisma.journalEntryLine.findMany({ where: { journalEntryId: id } })
    const debet = rader.reduce((s, r) => s + Number(r.debit ?? 0), 0)
    const kredit = rader.reduce((s, r) => s + Number(r.credit ?? 0), 0)
    expect(debet).toBeCloseTo(kredit, 2)
    expect(kredit).toBeCloseTo(1250, 2)

    const bankrad = rader.find((r) => r.accountId === konton.get(1930))
    expect(Number(bankrad?.credit ?? 0)).toBeCloseTo(1250, 2)
  })
})
