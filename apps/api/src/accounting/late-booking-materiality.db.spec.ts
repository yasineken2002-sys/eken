/**
 * VÄSENTLIGHETSGRÄNSEN ÄR PER ORGANISATION — mot riktig Postgres.
 *
 * ── VAD SOM MÄTS ────────────────────────────────────────────────────────────
 *
 * Att SAMMA betalning ger OLIKA utfall i två organisationer, därför att de satt
 * olika gränser. Det är hela poängen med att gränsen blev en kolumn: ett tal
 * som gällde alla lika kunde per definition inte vara väsentlighet, som är
 * relativ bolagets storlek.
 *
 * ── VARFÖR RIKTIG DATABAS ───────────────────────────────────────────────────
 *
 * Gränsen LÄSES ur `Organization`. Med en attrapp mäter provet att attrappen
 * returnerar det den blev tillsagd — inte att `findUnique` faktiskt hämtar rätt
 * organisations värde. Det är samma riktning som CLAUDE.md beskriver för
 * spärrar: en attrapp kan inte pröva en för grov avgränsning. Tappade
 * uppslaget sitt `where` hade båda organisationerna fått samma svar, och ett
 * mockat prov förblivit grönt.
 *
 * Dessutom är DEFAULTEN databasens (`@default(1000000)`), inte kodens — org B
 * sätter aldrig något värde, och att den ändå får 10 000 kr är ett påstående om
 * kolumnen, inte om TypeScript.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att flaggan når `LateFiscalYearPosting` genom hela betalningsvägen — det ägs
 * av `late-fiscal-year-posting.db.spec.ts`, som redan prövar ett flaggat och ett
 * oflaggat belopp mot defaultgränsen. Här mäts gränsläsningen ensam.
 */
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import {
  SEN_BOKFORING_VASENTLIGHET_DEFAULT_ORE,
  arVasentligtBelopp,
  oreTillKronor,
} from './late-booking-materiality'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('väsentlighetsgränsen läses per organisation', () => {
  let prisma: PrismaClient
  /** Satt gräns: 5 000 kr. */
  let orgA: string
  /** Rör aldrig kolumnen — ska få databasens default, 10 000 kr. */
  let orgB: string

  const nyOrg = async (gransOre?: number): Promise<string> => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `mat-${sfx}`,
        email: `mat-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        ...(gransOre !== undefined ? { lateBookingMaterialityThreshold: gransOre } : {}),
      },
      select: { id: true },
    })
    return org.id
  }

  const kr = (v: number) => new Prisma.Decimal(v)

  beforeAll(async () => {
    prisma = new PrismaClient()
    orgA = await nyOrg(500_000) // 5 000 kr
    orgB = await nyOrg() // default
  })

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
    await prisma.$disconnect()
  })

  it('org B får databasens DEFAULT utan att någon satt den', async () => {
    const rad = await prisma.organization.findUnique({
      where: { id: orgB },
      select: { lateBookingMaterialityThreshold: true },
    })
    expect(rad?.lateBookingMaterialityThreshold).toBe(SEN_BOKFORING_VASENTLIGHET_DEFAULT_ORE)
    // …och defaulten ÄR det gamla hårdkodade talet, annars har befintliga
    // organisationer tyst bytt beteende.
    expect(oreTillKronor(SEN_BOKFORING_VASENTLIGHET_DEFAULT_ORE).toString()).toBe('10000')
  })

  it('DEN AVGÖRANDE: samma betalning, olika utfall i de två organisationerna', async () => {
    // 7 500 kr ligger ÖVER org A:s 5 000 och UNDER org B:s 10 000.
    const belopp = kr(7500)
    await expect(arVasentligtBelopp(prisma, orgA, belopp)).resolves.toBe(true)
    await expect(arVasentligtBelopp(prisma, orgB, belopp)).resolves.toBe(false)
  })

  it('gränsen är inklusive — exakt på gränsen är väsentligt', async () => {
    // Skillnaden mellan `>` och `>=` syns bara här, och den är ett verkligt val:
    // ett belopp som PRECIS når gränsen ska markeras, inte falla igenom.
    await expect(arVasentligtBelopp(prisma, orgA, kr(5000))).resolves.toBe(true)
    await expect(arVasentligtBelopp(prisma, orgA, kr(4999.99))).resolves.toBe(false)
    await expect(arVasentligtBelopp(prisma, orgB, kr(10000))).resolves.toBe(true)
    await expect(arVasentligtBelopp(prisma, orgB, kr(9999.99))).resolves.toBe(false)
  })

  it('en okänd organisation faller tillbaka på defaulten, den kastar inte', async () => {
    // Funktionen kallas MITT I en betalningstransaktion. Att fälla en
    // affärshändelse på att en policy-kolumn inte gick att läsa vore att låta
    // en markering stoppa en bokföring.
    await expect(arVasentligtBelopp(prisma, randomUUID(), kr(20000))).resolves.toBe(true)
    await expect(arVasentligtBelopp(prisma, randomUUID(), kr(500))).resolves.toBe(false)
  })

  it('CHECK-villkoret avvisar en negativ gräns', async () => {
    // En negativ gräns hade gjort VARJE sen post väsentlig och därmed tyst
    // förvandlat markeringen till brus. Spärren är databasens, inte kodens.
    await expect(nyOrg(-1)).rejects.toThrow()
  })
})
