/**
 * AVINUMMERSERIENS ATOMICITET — mot RIKTIG Postgres.
 *
 * Revisionsraden "Avinummer-race / P2002 svaldes som idempotens" (M3) stod som
 * LÖST med belägg #484 + #485. Beläggen var mockade. Den här specen mäter
 * påståendet mot en riktig databas, och bevakar dessutom den egenskap som
 * vakten `check-sequence-allocation.mjs` per konstruktion INTE kan se.
 *
 * ── ARBETSFÖRDELNINGEN MOT VAKTEN ───────────────────────────────────────────
 *
 * R4 i vakten läser TYPEN och ANROPSPLATSENS UTTRYCK: att allokeraren tar en
 * `Prisma.TransactionClient` obligatoriskt, och att ingen anropsplats skickar
 * poolen eller utelämnar argumentet. Den kan inte se om den transaktion vars
 * klient skickas in faktiskt OMSLUTER inserten av raden numret hör till — en
 * `$transaction` som allokerar och sedan skriver raden utanför sig själv
 * passerar R4 utan anmärkning.
 *
 * Det är den egenskapen som mäts här, och bara här: FALL 3 rullar tillbaka en
 * riktig transaktion och kräver att sekvensen är oförändrad efteråt. Går
 * allokeringen ur transaktionen blir den röd.
 *
 * ── VARFÖR DET INTE FINNS NÅGOT "FALL 4" ────────────────────────────────────
 *
 * Mätriggen som föregick den här specen hade ett fall till: allokering UTANFÖR
 * transaktion, som visade att numret förbrukas även när inserten faller. Det
 * fallet går inte längre att skriva — `allocateRentNoticeNumber` tar
 * `Prisma.TransactionClient` obligatoriskt, så en allokering på poolen avvisas
 * av tsc innan den når en körning. Numreringen är kvar i FALL-namnen så att
 * jämförelsen med riggens utfall går att göra.
 *
 * ── POOLEN MÅSTE VARA STÖRRE ÄN N (#695) ────────────────────────────────────
 *
 * Annars mäter specen prismas KÖADE anslutningar i stället för radlåset, och
 * felet kommer som P2028 — som inte skiljer pool från lås. Gränsen sätts
 * explicit i datasource-URL:en och kontrolleras innan klienten byggs.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { allocateRentNoticeNumber } from './rent-notice-number'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const N = 10
const POOL = N + 15
const AR = 2031
const MANAD = 7

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: specen körs mot en RIKTIG databas', () => {
    // Utan den här raden är en skippad svit omöjlig att skilja från en grön.
    expect(HAR_DB).toBe(true)
  })
})

medDb('Avinummerserien mot riktig Postgres', () => {
  let prisma: PrismaClient
  /** Orgar som testet skapat — töms av afterEach, i FK-riktning. */
  let skapade: string[] = []

  beforeAll(() => {
    const url = urlMedPool(process.env.DATABASE_URL as string, POOL)
    expect(Number(new URL(url).searchParams.get('connection_limit'))).toBe(POOL)
    prisma = new PrismaClient({ datasources: { db: { url } } })
  })

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
  })

  /**
   * Riggen skapar sina EGNA förutsättningar (#612) — ingen befintlig rad lånas,
   * så en tom CI-databas ger samma utfall som en lokal med data i.
   */
  async function nyOrg(märke: string): Promise<string> {
    const id = `m3-${Date.now()}-${Math.floor(Math.random() * 1e9)}-${märke}`
    await prisma.organization.create({
      data: {
        id,
        name: `M3 ${märke}`,
        email: `${id}@example.invalid`,
        street: 'Gatan 1',
        city: 'Staden',
        postalCode: '12345',
      },
    })
    skapade.push(id)
    return id
  }

  // Städning per test, i FK-riktning: barn före förälder. Utan den bygger en
  // andra körning mot samma databas på den förstas rader, och då mäter provet
  // sitt eget skräp i stället för koden.
  afterEach(async () => {
    if (skapade.length === 0) return
    const där = { organizationId: { in: skapade } }
    await prisma.rentNotice.deleteMany({ where: där })
    await prisma.lease.deleteMany({ where: där })
    await prisma.unit.deleteMany({ where: { property: { organizationId: { in: skapade } } } })
    await prisma.property.deleteMany({ where: där })
    await prisma.tenant.deleteMany({ where: där })
    await prisma.rentNoticeNumberSequence.deleteMany({ where: där })
    await prisma.organization.deleteMany({ where: { id: { in: skapade } } })
    skapade = []
  })

  async function serieFor(org: string): Promise<number | null> {
    const rad = await prisma.rentNoticeNumberSequence.findUnique({
      where: { organizationId_year_month: { organizationId: org, year: AR, month: MANAD } },
      select: { lastNumber: true },
    })
    return rad?.lastNumber ?? null
  }

  it('FALL 1 — N samtidiga allokeringar i samma org ger N olika nummer utan lucka', async () => {
    const org = await nyOrg('a')
    const nummer = await Promise.all(
      Array.from({ length: N }, () =>
        prisma.$transaction((tx) => allocateRentNoticeNumber(tx, org, AR, MANAD)),
      ),
    )

    expect(new Set(nummer).size).toBe(N)
    const suffix = nummer.map((n) => Number(n.slice(-4))).sort((a, b) => a - b)
    expect(suffix).toEqual(Array.from({ length: N }, (_, i) => i + 1))
    expect(await serieFor(org)).toBe(N)
  })

  it('FALL 2 — två orgar samtidigt påverkar inte varandras serie', async () => {
    const a = await nyOrg('a')
    const b = await nyOrg('b')

    const bada = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        prisma.$transaction((tx) => allocateRentNoticeNumber(tx, a, AR, MANAD)),
      ),
      ...Array.from({ length: 5 }, () =>
        prisma.$transaction((tx) => allocateRentNoticeNumber(tx, b, AR, MANAD)),
      ),
    ])

    // Båda serierna startar på 1 — numret är unikt PER ORG, inte globalt.
    expect(
      bada
        .slice(0, 5)
        .map((n) => Number(n.slice(-4)))
        .sort((x, y) => x - y),
    ).toEqual([1, 2, 3, 4, 5])
    expect(
      bada
        .slice(5)
        .map((n) => Number(n.slice(-4)))
        .sort((x, y) => x - y),
    ).toEqual([1, 2, 3, 4, 5])
    expect(await serieFor(a)).toBe(5)
    expect(await serieFor(b)).toBe(5)
  })

  it('FALL 3 — allokering i en transaktion som rullas tillbaka förbrukar INGET nummer', async () => {
    // DET HÄR ÄR PROVET SOM VAKTEN INTE KAN ERSÄTTA. Att `tx` skickas in syns i
    // typen; att ökningen rullar tillbaka med transaktionen syns bara här.
    const org = await nyOrg('a')
    await prisma.$transaction((tx) => allocateRentNoticeNumber(tx, org, AR, MANAD))
    const fore = await serieFor(org)

    await expect(
      prisma.$transaction(async (tx) => {
        await allocateRentNoticeNumber(tx, org, AR, MANAD)
        throw new Error('framtvingad rollback')
      }),
    ).rejects.toThrow('framtvingad rollback')

    expect(await serieFor(org)).toBe(fore)
    const nasta = await prisma.$transaction((tx) => allocateRentNoticeNumber(tx, org, AR, MANAD))
    expect(Number(nasta.slice(-4))).toBe((fore ?? 0) + 1)
  })

  it('FALL 5 — cron-omkörning ger EN avi och bränner INGET nummer', async () => {
    // Speglar depositionsvägen i avisering.service.ts: allokera + insert i en
    // transaktion, P2002 på periodnyckeln fångas UTANFÖR den som benign
    // idempotens. Före #M3 låg allokeringen på poolen, och varje omkörning
    // kostade ett nummer. Kravet nedan är att den kostnaden är borta.
    const org = await nyOrg('b')
    const t = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: 'M',
        lastName: 'Tre',
        email: `${org}-t@example.invalid`,
      },
    })
    const pr = await prisma.property.create({
      data: {
        organizationId: org,
        name: 'P',
        propertyDesignation: `${org}-1:1`,
        type: 'RESIDENTIAL',
        street: 'G 1',
        city: 'S',
        postalCode: '12345',
        totalArea: new Prisma.Decimal('100'),
      },
    })
    const u = await prisma.unit.create({
      data: {
        propertyId: pr.id,
        name: 'L',
        unitNumber: '1',
        type: 'APARTMENT',
        area: new Prisma.Decimal('50'),
        monthlyRent: new Prisma.Decimal('5000'),
      },
    })
    const l = await prisma.lease.create({
      data: {
        organizationId: org,
        unitId: u.id,
        tenantId: t.id,
        startDate: new Date('2031-01-01'),
        tenancyStartDate: new Date('2031-01-01'),
        monthlyRent: new Prisma.Decimal('5000'),
        depositAmount: new Prisma.Decimal('0'),
      },
    })

    async function korAvisering(): Promise<boolean> {
      try {
        await prisma.$transaction(async (tx) => {
          const nummer = await allocateRentNoticeNumber(tx, org, AR, MANAD)
          await tx.rentNotice.create({
            data: {
              organizationId: org,
              tenantId: t.id,
              leaseId: l.id,
              noticeNumber: nummer,
              ocrNumber: `9${String(Date.now()).slice(-9)}`,
              type: 'RENT',
              status: 'PENDING',
              month: MANAD,
              year: AR,
              dueDate: new Date('2031-07-27'),
              amount: new Prisma.Decimal('5000'),
              totalAmount: new Prisma.Decimal('5000'),
            },
          })
        })
        return true
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err
        return false
      }
    }

    expect(await korAvisering()).toBe(true)
    const efterForsta = await serieFor(org)
    expect(await korAvisering()).toBe(false)

    // EN avi — idempotensen håller, som förr.
    expect(await prisma.rentNotice.count({ where: { leaseId: l.id } })).toBe(1)
    // …och omkörningen kostade INGET nummer. Det är skillnaden mot före #M3.
    expect(await serieFor(org)).toBe(efterForsta)
  })

  it('KANARIEFÅGEL — läs-modifiera-skriv utan lås ger DUBBLETT', async () => {
    // Neutraliserar radlåset genom att göra exakt det #484 tog bort: läs max,
    // vänta, skriv. Kan riggen inte producera felet här mäter FALL 1 ingenting
    // — tio unika nummer bevisar bara att tio anrop inte råkade kollidera.
    const org = await nyOrg('a')
    await prisma.$transaction((tx) => allocateRentNoticeNumber(tx, org, AR, MANAD))

    async function utanLas(): Promise<number> {
      const rad = await prisma.rentNoticeNumberSequence.findUnique({
        where: { organizationId_year_month: { organizationId: org, year: AR, month: MANAD } },
        select: { lastNumber: true },
      })
      const nasta = (rad?.lastNumber ?? 0) + 1
      await new Promise((r) => setTimeout(r, 25)) // fönstret racet behöver
      await prisma.rentNoticeNumberSequence.update({
        where: { organizationId_year_month: { organizationId: org, year: AR, month: MANAD } },
        data: { lastNumber: nasta },
      })
      return nasta
    }

    const nummer = await Promise.all(Array.from({ length: N }, () => utanLas()))
    expect(new Set(nummer).size).toBeLessThan(N)
  })
})
