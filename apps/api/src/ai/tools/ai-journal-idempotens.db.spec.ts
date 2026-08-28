/**
 * IDEMPOTENSEN GARANTERAS AV DATABASEN — mätt, inte påstådd.
 *
 * ── VARFÖR MOT RIKTIG POSTGRES ──────────────────────────────────────────────
 *
 * Egenskapen är Postgres egen: ett unikt index över en NULLBAR kolumn spärrar
 * ingenting för rader som lämnar kolumnen tom, eftersom NULL räknas som
 * distinkt. Exakt det gjorde AI-vägen oskyddad, och exakt det kan ingen
 * Prisma-attrapp visa — en mock vet inte vad NULL betyder för ett index.
 *
 * Mätt före ändringen:
 *     source='AI', sourceId=NULL          → 3 identiska verifikat TILLÅTNA
 *     source='INVOICE', sourceId='inv-1'  → andra insert AVVISAD
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { aiJournalSourceId } from './ai-journal-source'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

medDb('AI-verifikatets idempotensnyckel mot riktig Postgres', () => {
  let prisma: PrismaClient
  let orgId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const org = await prisma.organization.create({
      data: {
        name: `ai-idem-${randomUUID().slice(0, 8)}`,
        email: `ai-idem-${randomUUID().slice(0, 8)}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
  })

  afterAll(async () => {
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const skapa = (sourceId: string, verNumber: number) =>
    prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date('2026-08-28'),
        description: 'AI-verifikat',
        source: 'AI',
        sourceId,
        series: 'A',
        verNumber,
        fiscalYear: 2026,
      },
    })

  it('A1: TVÅ bekräftelser av SAMMA åtgärd → databasen avvisar den andra', async () => {
    const nyckel = aiJournalSourceId('record_expense', { d: '2026-08-28', belopp: 250 })
    await skapa(nyckel, 1001)
    await expect(skapa(nyckel, 1002)).rejects.toMatchObject({ code: 'P2002' })

    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, sourceId: nyckel },
    })
    expect(antal).toBe(1)
  })

  it('A2: TVÅ bekräftelser av OLIKA saker → TVÅ verifikat (spärren hindrar inte riktigt arbete)', async () => {
    const a = aiJournalSourceId('record_expense', { d: '2026-08-28', belopp: 300 })
    const b = aiJournalSourceId('record_expense', { d: '2026-08-28', belopp: 301 })
    expect(a).not.toBe(b)
    await skapa(a, 2001)
    await skapa(b, 2002)

    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, sourceId: { in: [a, b] } },
    })
    expect(antal).toBe(2)
  })

  it('A3: NEGATIVKONTROLL — utan nyckeln är dubbletter tillåtna igen', async () => {
    // Beviset för att indexet är det som håller: samma två skrivningar UTAN
    // sourceId går båda igenom. Utan den här raden kan A1 vara grön av att
    // något helt annat råkade blockera den andra insert:en.
    // Deterministiska verNumber — ett slumpat tal kan kollidera med sig självt
    // och göra testet flakigt i stället för fällande.
    const utanNyckel = (verNumber: number) =>
      prisma.journalEntry.create({
        data: {
          organizationId: orgId,
          date: new Date('2026-08-28'),
          description: 'utan nyckel',
          source: 'AI',
          series: 'A',
          verNumber,
          fiscalYear: 2026,
        },
      })
    await utanNyckel(3001)
    await utanNyckel(3002)
    const antal = await prisma.journalEntry.count({
      where: { organizationId: orgId, source: 'AI', sourceId: null },
    })
    expect(antal).toBe(2)
  })
})
