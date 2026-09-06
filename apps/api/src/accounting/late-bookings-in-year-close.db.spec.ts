/**
 * FLAGGANS FÖRSTA LÄSARE — sena bokföringar i bokslutets förhandsvisning.
 *
 * ── VAD SOM ÄNDRADES ────────────────────────────────────────────────────────
 *
 * `materialityFlagged` skrevs av #810 och lästes av INGENTING; uppräkningen gav
 * noll träffar utanför skrivningen. Nu listar `previewFiscalYearClose` årets
 * flaggade poster, så att den som stänger året ser dem innan hen bekräftar.
 *
 * REN SYNLIGHET. Provet kräver uttryckligen att `canClose` är OFÖRÄNDRAD — en
 * lista som råkade grinda hade varit en ny regel förklädd till en visning, och
 * det var inte vad mätningen sa att flaggan är till för.
 *
 * ── VARFÖR RIKTIG DATABAS ───────────────────────────────────────────────────
 *
 * Två av frågorna kan en attrapp inte svara på:
 *
 *  1. ORG-AVGRÄNSNINGEN. En annan organisations rader får aldrig synas.
 *     Tappar `where` sitt `organizationId` returnerar en attrapp ändå det den
 *     blev tillsagd, och provet hade förblivit grönt med en trasig fråga.
 *  2. DATUMFÖNSTRET mot `@db.Date` utvärderas av Postgres, inte av koden.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att webben faktiskt renderar listan — det ägs av dialogens egen vitest. Här
 * mäts vad API:t svarar.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('sena bokföringar i årsstängningens förhandsvisning', () => {
  let prisma: PrismaClient
  let orgId: string
  let annanOrg: string
  let kontoId: string

  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

  const nyOrg = async (): Promise<string> => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `lby-${sfx}`,
        email: `lby-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    return org.id
  }

  /** Verifikat + spår. `flaggad` styr `materialityFlagged`. */
  const senBokforing = async (args: {
    organizationId: string
    bookedDate: string
    eventDate: string
    belopp: number
    flaggad: boolean
    reason: string
    verNumber: number
  }) => {
    const entry = await prisma.journalEntry.create({
      data: {
        organizationId: args.organizationId,
        date: d(args.bookedDate),
        eventDate: d(args.eventDate),
        description: 'Inbetalning (prov)',
        source: 'PAYMENT',
        sourceId: randomUUID(),
        fiscalYear: Number(args.bookedDate.slice(0, 4)),
        series: 'A',
        verNumber: args.verNumber,
        lines: { create: [{ accountId: kontoId, debit: args.belopp }] },
      },
      select: { id: true },
    })
    await prisma.lateFiscalYearPosting.create({
      data: {
        organizationId: args.organizationId,
        journalEntryId: entry.id,
        eventDate: d(args.eventDate),
        bookedDate: d(args.bookedDate),
        closedFiscalYear: Number(args.eventDate.slice(0, 4)),
        amount: args.belopp,
        materialityFlagged: args.flaggad,
        reason: args.reason,
        actorType: 'USER',
        actorLabel: 'Provet',
      },
    })
  }

  /** Läser förhandsvisningen genom PRODUKTIONSVÄGEN, inte genom en egen fråga. */
  const forhandsvisning = async (organizationId: string, ar: number) => {
    const { AccountingPeriodService } = await import('./accounting-period.service')
    const { AccountingService } = await import('./accounting.service')
    const { VerifikationsnummerService } = await import('./verifikationsnummer.service')
    // Riktig AccountingService av samma prisma — förhandsvisningen bygger
    // verifikatutkastet genom den, och en `noop` hade fällt anropet innan
    // listan ens lästes.
    const svc = new AccountingPeriodService(
      prisma as never,
      new AccountingService(
        prisma as never,
        new VerifikationsnummerService(prisma as never),
      ) as never,
    )
    return svc.previewFiscalYearClose(organizationId, ar)
  }

  beforeAll(async () => {
    prisma = new PrismaClient()
    orgId = await nyOrg()
    annanOrg = await nyOrg()
    const konto = await prisma.account.create({
      data: { organizationId: orgId, number: 1930, name: 'Företagskonto', type: 'ASSET' },
      select: { id: true },
    })
    kontoId = konto.id
  })

  afterEach(async () => {
    for (const id of [orgId, annanOrg]) {
      await prisma.lateFiscalYearPosting.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
    }
  })

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { organizationId: { in: [orgId, annanOrg] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, annanOrg] } } })
    await prisma.$disconnect()
  })

  // 20 s: FÖRSTA provet bär modulimporten av AccountingService och
  // VerifikationsnummerService, och den ryms inte i Jests 5 s på den här
  // maskinen. Taket sitter på provet som faktiskt betalar kostnaden.
  it('listar FLAGGADE poster — och inte oflaggade', async () => {
    await senBokforing({
      organizationId: orgId,
      bookedDate: '2026-01-01',
      eventDate: '2025-12-20',
      belopp: 25000,
      flaggad: true,
      reason: 'Kom in i december, upptäcktes i januari',
      verNumber: 9001,
    })
    await senBokforing({
      organizationId: orgId,
      bookedDate: '2026-02-01',
      eventDate: '2025-11-15',
      belopp: 500,
      flaggad: false,
      reason: 'Liten post under gränsen',
      verNumber: 9002,
    })

    const p = await forhandsvisning(orgId, 2026)
    expect(p.lateBookings).toHaveLength(1)
    expect(p.lateBookings[0]?.amount).toBe('25000')
    expect(p.lateBookings[0]?.bookedDate).toBe('2026-01-01')
    expect(p.lateBookings[0]?.eventDate).toBe('2025-12-20')
    expect(p.lateBookings[0]?.closedFiscalYear).toBe(2025)
    expect(p.lateBookings[0]?.reason).toBe('Kom in i december, upptäcktes i januari')
    expect(p.lateBookings[0]?.actorLabel).toBe('Provet')
  }, 20_000)

  it('DEN AVGÖRANDE: en annan organisations flaggade poster syns INTE', async () => {
    await senBokforing({
      organizationId: annanOrg,
      bookedDate: '2026-01-05',
      eventDate: '2025-12-01',
      belopp: 99000,
      flaggad: true,
      reason: 'Den andra organisationens post',
      verNumber: 9101,
    })

    const p = await forhandsvisning(orgId, 2026)
    expect(p.lateBookings).toHaveLength(0)
  })

  it('poster utanför räkenskapsåret hamnar inte i listan', async () => {
    // Bokförd 2027 → hör till NÄSTA år, inte det som stängs.
    await senBokforing({
      organizationId: orgId,
      bookedDate: '2027-01-04',
      eventDate: '2026-12-20',
      belopp: 40000,
      flaggad: true,
      reason: 'Nästa års post',
      verNumber: 9201,
    })

    const p2026 = await forhandsvisning(orgId, 2026)
    expect(p2026.lateBookings).toHaveLength(0)

    // KANARIEFÅGEL: fönstret KAN hitta något — annars mäter raden ovan inget.
    const p2027 = await forhandsvisning(orgId, 2027)
    expect(p2027.lateBookings).toHaveLength(1)
  })

  it('listan GRINDAR INTE — canClose är oförändrad av en flaggad post', async () => {
    const utan = await forhandsvisning(orgId, 2026)
    await senBokforing({
      organizationId: orgId,
      bookedDate: '2026-03-01',
      eventDate: '2025-10-10',
      belopp: 75000,
      flaggad: true,
      reason: 'Stor post som INTE får spärra bokslutet',
      verNumber: 9301,
    })
    const med = await forhandsvisning(orgId, 2026)

    expect(med.lateBookings).toHaveLength(1)
    // Ren synlighet: samma svar på frågan "får året stängas".
    expect(med.canClose).toBe(utan.canClose)
    // …och listan lade inte till någon check.
    expect(med.checks.length).toBe(utan.checks.length)
  })
})
