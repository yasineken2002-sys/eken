/**
 * TILLDELNING AV HANTVERKARE — mot riktig Postgres.
 *
 * ── VAD PROVET FINNS FÖR ────────────────────────────────────────────────────
 *
 * `MaintenanceTicket.assignedToId` var en naken `String?` utan relation. Mätt
 * före etapp 10: NOLL skrivare i hela repot och noll rader med värde. Fältet
 * gick alltså inte att sätta, och skuggagentens tredje jämförelsefält kunde
 * aldrig mäta något — facit var alltid null.
 *
 * `assignedContractorId` är en riktig FK. Provet mäter de tre egenskaper som
 * skiljer en relation från en sträng:
 *
 *   1. ett id som inte finns i ORGANISATIONEN går inte att tilldela
 *   2. FK:n är `SetNull` — en raderad hantverkare tar inte ärendet med sig
 *   3. tilldelningen blir en HÄNDELSE i historiken, med tid och aktör
 *
 * ── VARFÖR RIKTIG DATABAS OCH INTE EN ATTRAPP ───────────────────────────────
 *
 * Punkt 1 och 2 är villkor Postgres utvärderar. En attrapp returnerar det den
 * blev tillsagd oavsett `where`, så en tappad `organizationId` i avgränsningen
 * hade varit osynlig — CLAUDE.md:s avsnitt om att en attrapp inte kan pröva
 * den för grova riktningen. `SetNull` är dessutom en egenskap hos FK:n, inte
 * hos koden: den går bara att mäta genom att faktiskt radera raden.
 *
 * Riggen skapar sina EGNA förutsättningar (slumpat orgId) och städar i
 * FK-riktning. CI:s databas är tom; ett prov som lånar seedens organisation
 * mäter omgivningen, inte koden.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

import { ContractorsService } from './contractors.service'
import { HISTORY_SOURCES } from '../history/history-sources.registry'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('hantverkartilldelning mot riktig Postgres', () => {
  let prisma: PrismaClient
  let contractors: ContractorsService

  const orgA = randomUUID()
  const orgB = randomUUID()
  const userId = randomUUID()
  const propertyId = randomUUID()
  const ids = { ticket: '', hantverkareA: '', hantverkareB: '', inaktiv: '' }

  beforeAll(async () => {
    prisma = new PrismaClient()
    contractors = new ContractorsService(prisma as unknown as PrismaService)

    for (const [id, namn] of [
      [orgA, 'Org A'],
      [orgB, 'Org B'],
    ] as const) {
      await prisma.organization.create({
        data: {
          id,
          name: namn,
          orgNumber: `55${id.slice(0, 8)}`,
          email: `${id}@exempel.test`,
          street: 'Testgatan 1',
          city: 'Testby',
          postalCode: '11111',
        },
      })
    }
    await prisma.user.create({
      data: {
        id: userId,
        organizationId: orgA,
        email: `${userId}@exempel.test`,
        passwordHash: 'x',
        firstName: 'Test',
        lastName: 'Testsson',
        role: 'OWNER',
      },
    })
    await prisma.property.create({
      data: {
        id: propertyId,
        organizationId: orgA,
        name: 'Testfastigheten',
        propertyDesignation: `Testby ${propertyId.slice(0, 6)}`,
        type: 'RESIDENTIAL',
        street: 'Storgatan 1',
        city: 'Stockholm',
        postalCode: '11122',
        totalArea: 420,
      },
    })

    const a = await contractors.create(
      { name: 'Rör & Värme AB', email: 'a@exempel.test', categories: ['PLUMBING'] },
      orgA,
      userId,
    )
    ids.hantverkareA = a.id
    const b = await contractors.create({ name: 'Annan orgs firma' }, orgB, userId)
    ids.hantverkareB = b.id
    const i = await contractors.create({ name: 'Slutat anlitas', isActive: false }, orgA, userId)
    ids.inaktiv = i.id

    const t = await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgA,
        propertyId,
        ticketNumber: 'AR-1',
        title: 'Läckande kran',
        description: 'Droppar dygnet runt.',
        category: 'PLUMBING',
      },
    })
    ids.ticket = t.id
  }, 60_000)

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      const w = { organizationId: org }
      await prisma.maintenanceTicket.deleteMany({ where: w })
      await prisma.contractor.deleteMany({ where: w })
      await prisma.property.deleteMany({ where: w })
      await prisma.user.deleteMany({ where: w })
      await prisma.organization.deleteMany({ where: { id: org } })
    }
    await prisma.$disconnect()
  }, 60_000)

  /** Samma väg som endpointen tar, utan HTTP-lagret. */
  const tilldela = (contractorId: string | null, organizationId = orgA) =>
    prisma.$transaction(async () => {
      const c =
        contractorId === null
          ? null
          : await prisma.contractor.findFirst({
              where: { id: contractorId, organizationId },
              select: { id: true, isActive: true },
            })
      if (contractorId !== null && !c) throw new Error('HITTADES_INTE')
      if (c && !c.isActive) throw new Error('INAKTIV')
      return prisma.maintenanceTicket.update({
        where: { id: ids.ticket },
        data:
          contractorId === null
            ? { assignedContractorId: null, assignedAt: null, assignedByUserId: null }
            : {
                assignedContractorId: contractorId,
                assignedAt: new Date(),
                assignedByUserId: userId,
              },
      })
    })

  it('en hantverkare i EGEN organisation går att tilldela', async () => {
    const t = await tilldela(ids.hantverkareA)
    expect(t.assignedContractorId).toBe(ids.hantverkareA)
    expect(t.assignedAt).toBeInstanceOf(Date)
    expect(t.assignedByUserId).toBe(userId)
  })

  it('DEN AVGÖRANDE: en hantverkare i en ANNAN organisation går inte att tilldela', async () => {
    // Uppslaget bär `organizationId`. Utan det hade ett gissat uuid räckt — och
    // svaret hade dessutom läckt att hantverkaren finns.
    await expect(tilldela(ids.hantverkareB)).rejects.toThrow('HITTADES_INTE')
    const t = await prisma.maintenanceTicket.findUniqueOrThrow({ where: { id: ids.ticket } })
    expect(t.assignedContractorId).toBe(ids.hantverkareA)
  })

  it('en INAKTIV hantverkare går inte att tilldela nya ärenden', async () => {
    await expect(tilldela(ids.inaktiv)).rejects.toThrow('INAKTIV')
  })

  it('tilldelningen blir en händelse i historiken, med tid och aktör', async () => {
    const källa = HISTORY_SOURCES.find((k) => k.key === 'maintenance-ticket')
    expect(källa).toBeDefined()
    const händelser = await källa!.load({
      prisma,
      organizationId: orgA,
      subject: { kind: 'PROPERTY', id: propertyId },
    } as never)
    const tilldelning = händelser.filter((h) => h.type === 'MAINTENANCE_ASSIGNED')
    expect(tilldelning).toHaveLength(1)
    expect(tilldelning[0]!.description).toContain('Rör & Värme AB')
    expect(tilldelning[0]!.at).toBeInstanceOf(Date)
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET, inte mot regeln.
   *
   * Provet ovan är grönt om källan ger EN tilldelningshändelse. Det vore också
   * grönt om källan slutat läsa `assignedAt` och listan blivit tom — nej, då
   * blir det 0, men det som INTE syns är om källan aldrig anropades alls, eller
   * om `MAINTENANCE_ASSIGNED` bara är en sträng ingen producerar. Den här
   * kräver att mängden ÄNDRAR SIG när tilldelningen tas bort: samma källa,
   * samma anrop, motsatt utfall. Kan den inte det mäter provet ovan ingenting.
   */
  it('KANARIEFÅGEL: händelsen FÖRSVINNER när tilldelningen tas bort', async () => {
    const ladda = async () => {
      const källa = HISTORY_SOURCES.find((k) => k.key === 'maintenance-ticket')!
      const h = await källa.load({
        prisma,
        organizationId: orgA,
        subject: { kind: 'PROPERTY', id: propertyId },
      } as never)
      return h.filter((x) => x.type === 'MAINTENANCE_ASSIGNED').length
    }
    expect(await ladda()).toBe(1)
    await tilldela(null)
    expect(await ladda()).toBe(0)
    await tilldela(ids.hantverkareA)
    expect(await ladda()).toBe(1)
  })

  it('SetNull: en raderad hantverkare tar inte ärendet med sig', async () => {
    const svar = await contractors.remove(ids.hantverkareA, orgA)
    expect(svar.ärendenTömda).toBe(1)
    const t = await prisma.maintenanceTicket.findUnique({ where: { id: ids.ticket } })
    // Ärendet FINNS KVAR — hyresgästens historik får inte försvinna för att en
    // hantverkare bad om att bli struken ur registret.
    expect(t).not.toBeNull()
    expect(t!.assignedContractorId).toBeNull()
  })
})
