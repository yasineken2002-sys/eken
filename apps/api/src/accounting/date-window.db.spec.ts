/**
 * DATUMFÖNSTER MOT `@db.Date` — mot riktig Postgres (#730).
 *
 * ── VARFÖR DET HÄR INTE GÅR ATT PRÖVA MED EN ATTRAPP ──────────────────────
 *
 * Felet ligger INTE i koden som bygger fönstret utan i vad Prisma skickar till
 * databasen. En attrapp får `{ gte, lt }` och kan svara vad den vill; hela
 * frågan är vad Postgres gör med de värdena mot en kolumn utan tid. Uppmätt:
 *
 *   A) Prisma ORM  gte/lt  ur stockholmMonthBounds  →  2026-11-30 · 2026-12-01
 *   B) rå SQL      >=/<    samma gränser            →  2026-12-01 · 2026-12-31
 *   C) Prisma      gte/lt  som DAGAR                →  2026-12-01 · 2026-12-31
 *
 * A är den gamla formen. Den tog med föregående månads sista dag och tappade
 * sin egen — och den tappade dagen är den `runYearEndAccrual` och
 * `closeFiscalYear` daterar sina bokslutsposter på.
 *
 * ── VARFÖR JUST MÅNADSSAMMANFATTNINGEN ────────────────────────────────────
 *
 * `buildSummary` skriver in sina tal i `AccountingPeriodEvent.summary`, som är
 * append-only och ALDRIG räknas om. Ett fönster som räknar fel blir därför inte
 * ett fel som rättas nästa gång någon tittar — det blir permanent i historiken.
 *
 * ── VAD PROVET INTE KAN SE ────────────────────────────────────────────────
 *
 * Om talen är redovisningsmässigt rätt. Det mäts på annat håll. Här mäts VILKA
 * DAGAR som ingår i fönstret.
 */
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import { AccountingPeriodService } from './accounting-period.service'
import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { stockholmMonthBounds, stockholmMonthDayBounds } from '../common/time/stockholm-period'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('#730 · datumfönster mot @db.Date', () => {
  let prisma: PrismaClient
  let service: AccountingPeriodService
  const städa: string[] = []

  let accounting: AccountingService

  beforeAll(() => {
    prisma = new PrismaClient()
    accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    service = new AccountingPeriodService(prisma as never, accounting)
  })

  afterEach(async () => {
    for (const orgId of städa.splice(0)) {
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntry: { organizationId: orgId } },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: orgId } })
      await prisma.lease.deleteMany({ where: { organizationId: orgId } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
      await prisma.property.deleteMany({ where: { organizationId: orgId } })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      // Stängningen i provet ovan skriver BÅDE händelsen och speglingen, och
      // båda är Restrict mot Organization. Utan de här två raderna faller
      // städningen på en FK — vilket rapporteras som att PROVET föll.
      await prisma.accountingPeriodEvent.deleteMany({ where: { organizationId: orgId } })
      await prisma.closedAccountingPeriod.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function nyOrg(): Promise<{ orgId: string; konto: Map<number, string> }> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `dw-${sfx}`,
        email: `dw-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    städa.push(org.id)
    const konto = new Map<number, string>()
    for (const [nr, namn, typ] of [
      [1510, 'Kundfordringar', 'ASSET'],
      [3911, 'Hyresintäkter', 'REVENUE'],
      [5010, 'Lokalhyra', 'EXPENSE'],
    ] as const) {
      const a = await prisma.account.create({
        data: { organizationId: org.id, number: nr, name: namn, type: typ },
        select: { id: true },
      })
      konto.set(nr, a.id)
    }
    return { orgId: org.id, konto }
  }

  let ver = 0
  const bokför = async (
    orgId: string,
    konto: Map<number, string>,
    datum: string,
    rader: Array<{ konto: number; debit?: number; credit?: number }>,
  ) => {
    ver += 1
    await prisma.journalEntry.create({
      data: {
        organizationId: orgId,
        date: new Date(`${datum}T00:00:00Z`),
        description: `fixtur ${datum}`,
        source: 'MANUAL',
        sourceId: `dw:${randomUUID()}`,
        fiscalYear: 2026,
        series: 'A',
        verNumber: ver,
        lines: {
          create: rader.map((r) => ({
            accountId: konto.get(r.konto) as string,
            ...(r.debit != null ? { debit: new Prisma.Decimal(r.debit) } : {}),
            ...(r.credit != null ? { credit: new Prisma.Decimal(r.credit) } : {}),
            description: `k${r.konto}`,
          })),
        },
      },
    })
  }

  // ── 1. Månadssammanfattningen: båda ändarna ──────────────────────────────
  it('SUMMARY: bokslutsposten daterad ÅRETS SISTA DAG ingår, och föregående månad ingår INTE', async () => {
    const { orgId, konto } = await nyOrg()

    // 30 november — FÖREGÅENDE månad. Fick förut smyga in i december.
    await bokför(orgId, konto, '2026-11-30', [
      { konto: 1510, debit: 500 },
      { konto: 3911, credit: 500 },
    ])
    // 15 december — mitt i månaden, ingår oavsett fönster.
    await bokför(orgId, konto, '2026-12-15', [
      { konto: 1510, debit: 1_000 },
      { konto: 3911, credit: 1_000 },
    ])
    // 31 december — BOKSLUTSPOSTEN. Föll förut ur fönstret.
    await bokför(orgId, konto, '2026-12-31', [
      { konto: 5010, debit: 200 },
      { konto: 1510, credit: 200 },
    ])
    // 1 januari — NÄSTA månad, ska aldrig ingå.
    await bokför(orgId, konto, '2027-01-01', [
      { konto: 1510, debit: 9_999 },
      { konto: 3911, credit: 9_999 },
    ])

    // `buildSummary` är privat; den anropas via stängningen. Vi når den genom
    // att stänga december och läsa ögonblicksbilden ur händelsen — det är
    // dessutom exakt den väg talen faktiskt tar till historiken.
    await service.closePeriod(orgId, 2026, 12, { actorRole: 'ADMIN', actorUserId: null })
    const händelse = await prisma.accountingPeriodEvent.findFirstOrThrow({
      where: { organizationId: orgId, year: 2026, month: 12, type: 'CLOSED' },
      select: { summary: true },
    })
    const s = händelse.summary as unknown as {
      revenue: number
      expenses: number
      result: number
      entriesCount: number
    }

    // Intäkt: BARA 15 december. 30 november (500) och 1 januari (9 999) utanför.
    expect(s.revenue).toBe(1_000)
    // Kostnad: bokslutsposten 31 december. Var 0 innan #730 — den dagen fanns
    // inte i fönstret.
    expect(s.expenses).toBe(200)
    expect(s.result).toBe(800)
    // Två verifikat, inte ett och inte tre.
    expect(s.entriesCount).toBe(2)
  })

  // ── 2. Kontrakt som upphörde sista dagen i föregående månad ──────────────
  it('UNBILLED LEASES: ett kontrakt som upphörde 30 november räknas INTE som aktivt i december', async () => {
    const { orgId } = await nyOrg()
    const sfx = randomUUID().slice(0, 8)
    const tenant = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `dw-t-${sfx}@example.se` },
      select: { id: true },
    })
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `F ${sfx}`,
        propertyDesignation: `DW ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Lgh 1',
        unitNumber: '101',
        type: 'APARTMENT',
        area: 50,
        rooms: 2,
        monthlyRent: 8000,
      },
      select: { id: true },
    })
    await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId: tenant.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startDate: new Date('2026-01-01T00:00:00Z'),
        tenancyStartDate: new Date('2026-01-01T00:00:00Z'),
        // UPPHÖRDE sista dagen i november — alltså inte aktivt i december.
        endDate: new Date('2026-11-30T00:00:00Z'),
        monthlyRent: 8000,
        depositAmount: 0,
      },
    })

    const pre = await service.precheck(orgId, 2026, 12)
    const oaviserade = pre.checks.find((c) => c.code === 'unbilled-leases')
    // Före #730 trunkerades `endDate >= 2026-11-30T23:00Z` till `>= 2026-11-30`,
    // så kontraktet räknades som aktivt och gav ett falskt larm om oaviserad hyra.
    expect(oaviserade).toBeUndefined()
  })

  // ── 3. Årets intäkter hittills, sent på UTC-dygnet ──────────────────────
  it('REVENUE TO DATE: en intäkt daterad i dag räknas även när UTC-dygnet redan bytt', async () => {
    const { orgId, konto } = await nyOrg()
    await bokför(orgId, konto, '2026-12-31', [
      { konto: 1510, debit: 300 },
      { konto: 3911, credit: 300 },
    ])
    await bokför(orgId, konto, '2027-01-01', [
      { konto: 1510, debit: 400 },
      { konto: 3911, credit: 400 },
    ])

    const från = new Date(Date.UTC(2026, 0, 1))
    // 2026-12-31T23:30Z ÄR 1 januari 00:30 i Sverige. "Hittills i dag" ska
    // därför inkludera raden daterad 2027-01-01. Före #730 trunkerades gränsen
    // till UTC-datumet 2026-12-31 och raden föll bort.
    const sentPåDygnet = await accounting.getRevenueTotal(
      orgId,
      från,
      new Date('2026-12-31T23:30:00Z'),
    )
    expect(sentPåDygnet).toBe(700)

    // Mitt på dagen samma svenska datum ger samma svar — gränsen får inte bero
    // på klockslaget.
    const middag = await accounting.getRevenueTotal(orgId, från, new Date('2027-01-01T11:00:00Z'))
    expect(middag).toBe(700)

    // …och dagen INNAN ska fortfarande bara se den första raden.
    const dagenInnan = await accounting.getRevenueTotal(
      orgId,
      från,
      new Date('2026-12-31T11:00:00Z'),
    )
    expect(dagenInnan).toBe(300)
  })

  // ── 4. Gränsfunktionerna själva ─────────────────────────────────────────
  it('DE TVÅ SORTERNAS GRÄNSER är olika, och båda behövs', () => {
    const ögonblick = stockholmMonthBounds(2026, 12)
    const dagar = stockholmMonthDayBounds(2026, 12)

    // Ögonblicken ligger på föregående dag i UTC — det är hela poängen med dem
    // mot en tidsstämpelkolumn, och exakt det som trunkeras fel mot en datumkolumn.
    expect(ögonblick.from.toISOString()).toBe('2026-11-30T23:00:00.000Z')
    expect(ögonblick.to.toISOString()).toBe('2026-12-31T23:00:00.000Z')

    expect(dagar.from.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(dagar.to.toISOString()).toBe('2027-01-01T00:00:00.000Z')

    // Sommartid: juli har offset +2, så ögonblicket ligger 22:00.
    expect(stockholmMonthBounds(2026, 7).from.toISOString()).toBe('2026-06-30T22:00:00.000Z')
    // Dagsgränsen bryr sig inte om DST — den bär ingen tid.
    expect(stockholmMonthDayBounds(2026, 7).from.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })
})
