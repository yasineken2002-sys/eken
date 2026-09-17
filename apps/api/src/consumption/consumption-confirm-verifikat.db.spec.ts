/**
 * F017 — BEKRÄFTELSEN MÅSTE TALA SANNING OM VERIFIKATET (mot riktig Postgres).
 *
 * ── VAD SOM PRÖVAS ─────────────────────────────────────────────────────────
 *
 * `confirmCharge` är den punkt där en människa säger ja till att en
 * förbrukningsdebitering blir bindande. Gränssnittet svarar "Posten är bokförd
 * (verifikat skapat)" och posten blir därmed fakturerbar. Provet prövar att det
 * beskedet är SANT: efter ett lyckat confirm finns verifikatet, och efter ett
 * misslyckat finns varken CONFIRMED-status eller ett halvt bokfört tillstånd.
 *
 * ── VARFÖR RIKTIG DATABAS OCH INTE EN ATTRAPP ──────────────────────────────
 *
 * Tre av frågorna nedan går inte att ställa till en attrapp:
 *
 *  1. ATOMICITETEN. Att statusflippen rullas tillbaka när bokföringen faller är
 *     Postgres arbete, inte kodens. En attrapp som svarar "count: 1" på
 *     `updateMany` säger ingenting om vad som står kvar i tabellen efteråt —
 *     och det är exakt det F017 handlar om.
 *  2. SPÄRREN. `assertPeriodOpen` läser AccountingPeriodEvent med "senaste
 *     händelsen per period". En attrapp hade svarat det den blev tillsagd.
 *     Här stängs perioden via den RIKTIGA `AccountingPeriodService.closePeriod`.
 *  3. SAMTIDIGHETEN. Att exakt ett av två samtidiga confirm skapar verifikatet
 *     är det unika indexets (org, source, sourceId) arbete.
 *
 * ── VAD PROVET INTE SER ────────────────────────────────────────────────────
 *
 * HTTP-lagret (controllern mappar undantagen till 409/422) och gränssnittets
 * text. Provet går in på tjänstevägen, ett steg under controllern.
 * `InvoiceEventsService` är den riktiga — confirm-vägen rör den inte, men den
 * attrappas inte heller bort.
 *
 * ── POOLEN SÄTTS AV RIGGEN ─────────────────────────────────────────────────
 *
 * Samtidighetsprovet öppnar två transaktioner samtidigt. Är poolen mindre dör
 * anropen på pool-timeout i stället för på unik-indexet, och utfallet ser ut
 * som ett grönt "bara en vann" — av fel skäl.
 */
import { randomUUID } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { PrismaClient, UserRole } from '@prisma/client'

import { AccountingPeriodService } from '../accounting/accounting-period.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { ConsumptionService } from './consumption.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Samtidiga confirm-försök i samtidighetsprovet … */
const N = 2
/** …plus marginal för riggens egna anslutningar. */
const POOL = N + 8

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

/** Ett datum i svensk civil tid, mitt på dagen (aldrig nära en periodgräns). */
const d = (år: number, månad: number, dag: number) =>
  new Date(Date.UTC(år, månad - 1, dag, 10, 0, 0))

/** Mätperiodens slut: 31 maj 2026 → bokföringsperioden 2026-05. */
const PERIOD_START = d(2026, 5, 1)
const PERIOD_END = d(2026, 5, 31)

interface Rigg {
  orgId: string
  userId: string
  chargeId: string
  leaseId: string
  meterId: string
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('F017 · confirmCharge — status och verifikat följs åt', () => {
  let prisma: PrismaClient
  let consumption: ConsumptionService
  let perioder: AccountingPeriodService
  let accounting: AccountingService
  /** Varje organisation riggen skapat — städas i afterAll, aldrig något annat. */
  const skapadeOrgar: string[] = []

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
    })
    await prisma.$connect()
    const verifikationsnummer = new VerifikationsnummerService(prisma as never)
    accounting = new AccountingService(prisma as never, verifikationsnummer)
    const invoiceEvents = new InvoiceEventsService(prisma as never)
    consumption = new ConsumptionService(prisma as never, accounting, invoiceEvents)
    perioder = new AccountingPeriodService(prisma as never, accounting)
  })

  afterAll(async () => {
    // Städar ENBART det riggen själv skapade (id:n samlade i `skapadeOrgar`),
    // aldrig en bred `deleteMany` över tabellen. FK-riktningen är omvänd
    // skapandeordning; flera relationer är `onDelete: Restrict`.
    for (const orgId of skapadeOrgar) {
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntry: { organizationId: orgId } },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.accountingPeriodEvent.deleteMany({ where: { organizationId: orgId } })
      // Stängningen skriver TVÅ rader: händelsen ovan och speglingen här. Båda
      // har `onDelete: Restrict` mot Organization.
      await prisma.closedAccountingPeriod.deleteMany({ where: { organizationId: orgId } })
      await prisma.consumptionCharge.deleteMany({ where: { organizationId: orgId } })
      await prisma.meterReading.deleteMany({ where: { organizationId: orgId } })
      await prisma.meter.deleteMany({ where: { organizationId: orgId } })
      await prisma.consumptionTariff.deleteMany({ where: { organizationId: orgId } })
      await prisma.lease.deleteMany({ where: { organizationId: orgId } })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
      await prisma.property.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.delete({ where: { id: orgId } })
    }
    await prisma.$disconnect()
  })

  /**
   * En egen organisation per prov. Sås med kontoplan (1510 + 3920), ett
   * hyresförhållande, en mätare med en avläsning och EN förbrukningspost i
   * DRAFT — precis det läge en förvaltare möter när hen ska trycka "Bekräfta".
   */
  const såRigg = async (opts: { utanIntäktskonto?: boolean } = {}): Promise<Rigg> => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `f017-${sfx}`,
        email: `f017-${sfx}@example.se`,
        street: 'Storgatan 1',
        city: 'Stockholm',
        postalCode: '11111',
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    skapadeOrgar.push(org.id)
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `f017-${sfx}@example.se`,
        firstName: 'Ägare',
        lastName: 'Ägarsson',
        role: UserRole.OWNER,
      },
      select: { id: true },
    })

    await prisma.account.create({
      data: { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
    })
    if (!opts.utanIntäktskonto) {
      await prisma.account.create({
        data: {
          organizationId: org.id,
          number: 3920,
          name: 'Förbrukningsersättning el/värme',
          type: 'REVENUE',
        },
      })
    }

    const property = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: `Fastighet ${sfx}`,
        propertyDesignation: `Eken ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'Storgatan 1',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 500,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Lgh 1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 62,
        monthlyRent: 9000,
      },
      select: { id: true },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: 'Gäst',
        email: `hg-${sfx}@example.se`,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: tenant.id,
        status: 'ACTIVE',
        startDate: d(2026, 1, 1),
        tenancyStartDate: d(2026, 1, 1),
        monthlyRent: 9000,
        depositAmount: 0,
      },
      select: { id: true },
    })
    const meter = await prisma.meter.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        type: 'ELECTRICITY',
        unitOfMeasure: 'kWh',
      },
      select: { id: true },
    })
    const reading = await prisma.meterReading.create({
      data: {
        organizationId: org.id,
        meterId: meter.id,
        unitId: unit.id,
        leaseId: lease.id,
        value: 1240,
        readingType: 'CUMULATIVE',
        readingDate: PERIOD_END,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        source: 'MANUAL',
        registeredById: user.id,
      },
      select: { id: true },
    })
    const charge = await prisma.consumptionCharge.create({
      data: {
        organizationId: org.id,
        leaseId: lease.id,
        unitId: unit.id,
        tenantId: tenant.id,
        meterReadingId: reading.id,
        meterType: 'ELECTRICITY',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        quantity: 240,
        pricePerUnit: 2.5,
        netAmount: 600,
        vatStatus: 'EXEMPT',
        vatRate: 0,
        vatAmount: 0,
        totalAmount: 600,
        kind: 'ACTUAL',
        status: 'DRAFT',
        deliveryMode: 'RENT_NOTICE_LINE',
      },
      select: { id: true },
    })

    return {
      orgId: org.id,
      userId: user.id,
      chargeId: charge.id,
      leaseId: lease.id,
      meterId: meter.id,
    }
  }

  const stängMaj = (r: Rigg) =>
    perioder.closePeriod(r.orgId, 2026, 5, { actorRole: UserRole.OWNER, actorUserId: r.userId })

  const status = async (chargeId: string) =>
    (await prisma.consumptionCharge.findUniqueOrThrow({ where: { id: chargeId } })).status

  const verifikat = (r: Rigg) =>
    prisma.journalEntry.findMany({
      where: { organizationId: r.orgId, sourceId: `consumption-charge:${r.chargeId}` },
      include: { lines: true },
    })

  /**
   * En EGEN anslutning. Överlappsprovet behöver verkliga, skilda anslutningar —
   * två `$transaction` på samma klient hade kunnat serialiseras av poolen i
   * stället för av databasen, och då hade provet mätt poolen.
   */
  const nyKlient = (): PrismaClient =>
    new PrismaClient({
      datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
    })

  /** Egen anslutning med sin egen hela tjänstegraf ovanpå. */
  const nyTjänst = (): { klient: PrismaClient; consumption: ConsumptionService } => {
    const klient = nyKlient()
    const verif = new VerifikationsnummerService(klient as never)
    const acc = new AccountingService(klient as never, verif)
    return {
      klient,
      consumption: new ConsumptionService(
        klient as never,
        acc,
        new InvoiceEventsService(klient as never),
      ),
    }
  }

  // ── 1. ÖPPEN PERIOD: bekräftelsen håller vad den lovar ────────────────────

  it('öppen period: posten blir CONFIRMED OCH får sitt verifikat (1510 D 600 / 3920 K 600)', async () => {
    const r = await såRigg()

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    expect(await status(r.chargeId)).toBe('CONFIRMED')
    const entries = await verifikat(r)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    const debet = entry.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)
    const kredit = entry.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)
    expect(debet).toBe(600)
    expect(kredit).toBe(600)
    // Mätperiodens slut styr räkenskapsåret — inte bekräftelsedagen.
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-05-31')
  })

  // ── 2. STÄNGD PERIOD: kärnan i F017 ───────────────────────────────────────

  it('stängd period: confirm AVVISAS, posten står kvar som DRAFT och inget verifikat finns', async () => {
    const r = await såRigg()
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      ConflictException,
    )

    // Sanningen om status …
    expect(await status(r.chargeId)).toBe('DRAFT')
    // … och om verifikatet.
    expect(await verifikat(r)).toHaveLength(0)
  })

  it('stängd period: felet är begripligt och på svenska, och pekar ut perioden', async () => {
    const r = await såRigg()
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toThrow(
      /2026-05.*stängd/s,
    )
  })

  it('stängd period: inget verifikationsnummer bränns — och sonden kan ge något annat', async () => {
    const r = await såRigg()
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      ConflictException,
    )

    const efterNej = await prisma.journalEntrySequence.findMany({
      where: { organizationId: r.orgId },
    })
    expect(efterNej).toHaveLength(0)

    // NOLLSONDENS MOTBEVIS. En tom sekvenstabell är ett svagt påstående så länge
    // ingen visat att den KAN fyllas av just den här vägen — en trasig `where`
    // hade gett noll rader av fel skäl. Efter att perioden öppnats igen ska
    // samma org ha exakt ett allokerat nummer.
    //
    // Provet mäter alltså att numret aldrig DELAS UT vid stängd period
    // (`assertPeriodOpen` ligger före `upsert` i `allocate`), inte att en redan
    // tagen ökning rullas tillbaka. Den ordningen är själva skyddet.
    await perioder.reopenPeriod(r.orgId, 2026, 5, {
      actorRole: UserRole.OWNER,
      actorUserId: r.userId,
      reason: 'Sent inkommen mätaravläsning saknas i perioden',
      reasonCategory: 'MISSING_ENTRY',
    })
    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    const efterJa = await prisma.journalEntrySequence.findMany({
      where: { organizationId: r.orgId },
    })
    expect(efterJa).toHaveLength(1)
    expect(efterJa[0]!.lastNumber).toBe(1)
  })

  it('stängd period: posten plockas INTE upp som fakturerbar efteråt', async () => {
    const r = await såRigg()
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      ConflictException,
    )

    // Fakturerings-/avi-vägarna filtrerar på status. Står posten kvar i DRAFT
    // kan den inte krävas in — det är hela skyddet mot "krav utan huvudbok".
    const fakturerbara = await prisma.consumptionCharge.findMany({
      where: { organizationId: r.orgId, status: { in: ['CONFIRMED', 'ATTACHED'] } },
    })
    expect(fakturerbara).toHaveLength(0)
  })

  // ── 3. VERKLIGT VERIFIKATSKAPANDEFEL som inte är en stängd period ─────────

  it('intäktskonto saknas i kontoplanen: confirm AVVISAS, posten står kvar som DRAFT', async () => {
    const r = await såRigg({ utanIntäktskonto: true })

    // Exakt typ, inte "något fel": 422 är den omdiskuterade delen av rättningen
    // (husets övriga `null`-vägar kastar 500) och måste pinnas, annars kan den
    // glida till ett ramverksfel utan att provet märker det.
    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    )

    expect(await status(r.chargeId)).toBe('DRAFT')
    expect(await verifikat(r)).toHaveLength(0)
  })

  // ── 4. OMFÖRSÖK EFTER AVHJÄLPT FEL ───────────────────────────────────────

  it('omförsök efter att perioden öppnats igen: confirm går igenom och ger ETT verifikat', async () => {
    const r = await såRigg()
    await stängMaj(r)
    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      ConflictException,
    )

    await perioder.reopenPeriod(r.orgId, 2026, 5, {
      actorRole: UserRole.OWNER,
      actorUserId: r.userId,
      reason: 'Sent inkommen mätaravläsning saknas i perioden',
      reasonCategory: 'MISSING_ENTRY',
    })

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    expect(await status(r.chargeId)).toBe('CONFIRMED')
    expect(await verifikat(r)).toHaveLength(1)
  })

  it('omförsök efter att kontoplanen kompletterats: confirm går igenom', async () => {
    const r = await såRigg({ utanIntäktskonto: true })
    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    )

    await prisma.account.create({
      data: {
        organizationId: r.orgId,
        number: 3920,
        name: 'Förbrukningsersättning el/värme',
        type: 'REVENUE',
      },
    })

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    expect(await status(r.chargeId)).toBe('CONFIRMED')
    expect(await verifikat(r)).toHaveLength(1)
  })

  // ── 5. DUBBELT OCH SAMTIDIGT ─────────────────────────────────────────────

  it('dubbel confirm i följd: ETT verifikat, ingen dubbel bokning', async () => {
    const r = await såRigg()

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)
    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    expect(await status(r.chargeId)).toBe('CONFIRMED')
    expect(await verifikat(r)).toHaveLength(1)
  })

  // MÄTER UTFALLET, INTE INTERLEAVINGEN. Två anrop startas utan att det första
  // inväntas, vilket gör överlapp sannolikt men inte bevisat — `Promise.allSettled`
  // säger ingenting om huruvida transaktionerna var öppna samtidigt, och
  // `lastNumber === 1` skiljer inte fallen åt (vid äkta överlapp allokerar
  // förloraren 2 och rullas tillbaka till 1; vid full serialisering allokerar den
  // aldrig). Överlappet BEVISAS i provet därefter.
  it('två confirm startade utan att invänta varandra: ETT verifikat, inget halvfärdigt kvar', async () => {
    const r = await såRigg()

    const utfall = await Promise.allSettled([
      consumption.confirmCharge(r.chargeId, r.orgId, r.userId),
      consumption.confirmCharge(r.chargeId, r.orgId, r.userId),
    ])

    // BÅDA, inte "minst en". Omtaget i `confirmCharge` och omläsningen i
    // `count === 0`-grenen finns just för att förloraren i racet ska få
    // vinnarens svar i stället för ett fel — med `toBeGreaterThanOrEqual(1)`
    // hade provet varit grönt även om båda de mekanismerna togs bort, och det
    // hade dolt ett 409 med texten "ingenting har bokförts" till en användare
    // vars post faktiskt är bokförd.
    const fel = utfall.flatMap((u) => (u.status === 'rejected' ? [String(u.reason)] : []))
    expect(fel).toEqual([])
    expect(utfall.filter((u) => u.status === 'fulfilled')).toHaveLength(2)
    expect(await status(r.chargeId)).toBe('CONFIRMED')

    // ETT verifikat — och det ska vara ett KORREKT verifikat, inte bara ett
    // ensamt. Ett race som skrivit halva konteringen hade passerat ett blott
    // `toHaveLength(1)`.
    const entries = await verifikat(r)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.lines).toHaveLength(2)
    expect(entries[0]!.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)).toBe(600)
    expect(entries[0]!.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)).toBe(600)

    // Och exakt ETT nummer ur serien: två nummer hade betytt att bägge
    // transaktionerna skrivit, även om bara en rad blev kvar.
    const sekvens = await prisma.journalEntrySequence.findMany({
      where: { organizationId: r.orgId },
    })
    expect(sekvens).toHaveLength(1)
    expect(sekvens[0]!.lastNumber).toBe(1)
  })

  // ── ÖVERLAPPET, MÄTT I STÄLLET FÖR ANTAGET ───────────────────────────────
  //
  // Provet ovan kan inte skilja äkta samtidighet från två serialiserade anrop.
  // Det här kan, och gör det utan att röra produktkoden och utan en enda sleep.
  //
  // MEKANIKEN. `allocate` tar en radlåsning på `JournalEntrySequence` INNAN
  // verifikatet skrivs (`verifikationsnummer.service.ts:79`, upsert på
  // primärnyckeln). En tredje anslutning håller den raden låst i en egen öppen
  // transaktion. Båda bekräftelserna kör då fram till exakt den punkten och
  // BLOCKERAS av databasen.
  //
  // FASOBSERVATIONEN ÄR BUNDEN OCH MÄTBAR, inte en tidsgissning: vi läser
  // `pg_locks` och väntar tills exakt TVÅ backends har en ICKE BEVILJAD
  // låsförfrågan. Det är databasens eget besked om att båda transaktionerna är
  // öppna samtidigt. Deadline finns, och missas den faller provet — den
  // frågan kan alltså ge ett annat svar än det önskade.
  //
  // DÄRMED BEVISAS OCKSÅ ATT BÅDA PASSERAT IDEMPOTENSUPPSLAGET. `findFirst` på
  // (org, source, sourceId) ligger FÖRE `allocate` i `createNumberedEntry`, och
  // vid barriären mäter vi att det ännu inte finns något verifikat alls. Ingen av
  // dem kan alltså ha tagit snabbvägen "hittade befintligt" — förloraren MÅSTE
  // gå vidare till `create`, kollidera på (org, source, sourceId) och tas om hand
  // av omtagsvägen i `confirmCharge`. Det är den riktiga konfliktvägen koden har.
  //
  // INGEN SPÄRR SOM KAN AKTIVERAS I PRODUKTION: barriären är en vanlig öppen
  // transaktion på en testanslutning i den här filen. Produktkoden vet inte om
  // att den finns och har ingen krok för den.
  it('två SAMTIDIGA confirm: överlappet är MÄTT via databasens låsvänta', async () => {
    const r = await såRigg()

    // Sekvensraden finns men inget nummer är allokerat — normaltillståndet för
    // en organisation vars första verifikat är på väg. Raden måste finnas för
    // att kunna låsas; `lastNumber: 0` är schemats egen default.
    await prisma.journalEntrySequence.create({
      data: { organizationId: r.orgId, fiscalYear: 2026, series: 'A', lastNumber: 0 },
    })

    const a = nyTjänst()
    const b = nyTjänst()
    const spärrKlient = nyKlient()
    let släpp!: () => void
    const släppt = new Promise<void>((res) => {
      släpp = res
    })

    /** Antal backends i databasen med en ICKE BEVILJAD låsförfrågan just nu. */
    const blockeradeNu = async (): Promise<number> => {
      const rader = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(DISTINCT l.pid)::int AS n
        FROM pg_locks l
        JOIN pg_stat_activity act ON act.pid = l.pid
        WHERE NOT l.granted AND act.datname = current_database()`
      return rader[0]?.n ?? 0
    }

    try {
      // SONDEN MÅSTE KUNNA GE NÅGOT ANNAT ÄN SVARET VI VILL HA. Före barriären
      // väntar ingen på något lås. Mäts den till 0 här och till 2 nedan är det
      // samma fråga som gett två olika svar — inte en fråga som alltid säger 2.
      expect(await blockeradeNu()).toBe(0)

      // Tredje anslutningen håller sekvensraden. Transaktionen står öppen tills
      // vi släpper den; timeouten är riggens, inte produktens.
      const spärr = spärrKlient.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "JournalEntrySequence"
            WHERE "organizationId" = ${r.orgId} AND "fiscalYear" = 2026 AND "series" = 'A'
            FOR UPDATE`
          await släppt
        },
        { maxWait: 5_000, timeout: 20_000 },
      )

      const pA = a.consumption.confirmCharge(r.chargeId, r.orgId, r.userId)
      const pB = b.consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

      // ── BUNDEN FASOBSERVATION ──────────────────────────────────────────────
      const deadline = Date.now() + 3_000
      let blockerade = 0
      while (Date.now() < deadline) {
        blockerade = await blockeradeNu()
        if (blockerade >= 2) break
        await new Promise((res) => setImmediate(res))
      }

      // DATABASENS EGET BESKED: två transaktioner är öppna samtidigt och väntar.
      expect(blockerade).toBe(2)
      // …och ingen av dem kan ha hittat ett befintligt verifikat, för det finns
      // inget. Båda är alltså förbi idempotensuppslaget.
      expect(await prisma.journalEntry.count({ where: { organizationId: r.orgId } })).toBe(0)

      släpp()
      await spärr

      const utfall = await Promise.allSettled([pA, pB])

      // ── SLUTASSERTIONS (oförändrade krav) ─────────────────────────────────
      const fel = utfall.flatMap((u) => (u.status === 'rejected' ? [String(u.reason)] : []))
      expect(fel).toEqual([]) // sanningsenliga svar: ingen får ett fel om en post som ÄR bokförd
      expect(utfall.filter((u) => u.status === 'fulfilled')).toHaveLength(2)
      expect(await status(r.chargeId)).toBe('CONFIRMED') // en charge-status

      const entries = await verifikat(r)
      expect(entries).toHaveLength(1) // exakt ett verifikat
      expect(entries[0]!.lines).toHaveLength(2) // två rätta rader
      expect(entries[0]!.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)).toBe(600)
      expect(entries[0]!.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)).toBe(600)

      // EN nummerallokering: förlorarens ökning till 2 rullades tillbaka med
      // hens transaktion, så serien står på 1 och verifikatet bär nummer 1.
      expect(entries[0]!.verNumber).toBe(1)
      const sekvens = await prisma.journalEntrySequence.findMany({
        where: { organizationId: r.orgId },
      })
      expect(sekvens).toHaveLength(1)
      expect(sekvens[0]!.lastNumber).toBe(1)
    } finally {
      släpp()
      await a.klient.$disconnect()
      await b.klient.$disconnect()
      await spärrKlient.$disconnect()
    }
  })

  it('stängd period + två SAMTIDIGA confirm: båda avvisas, inget spår lämnas', async () => {
    const r = await såRigg()
    await stängMaj(r)

    const utfall = await Promise.allSettled([
      consumption.confirmCharge(r.chargeId, r.orgId, r.userId),
      consumption.confirmCharge(r.chargeId, r.orgId, r.userId),
    ])

    expect(utfall.every((u) => u.status === 'rejected')).toBe(true)
    expect(await status(r.chargeId)).toBe('DRAFT')
    expect(await verifikat(r)).toHaveLength(0)
  })

  // ── 5b. ETT REDAN INSATT VERIFIKAT MÅSTE RULLAS TILLBAKA ─────────────────
  //
  // VARFÖR DET HÄR PROVET BEHÖVS, OCH VAD DE ANDRA INTE SER.
  //
  // Proven ovan visar att en stängd period inte lämnar något verifikat. Men de
  // bevisar INTE att en redan INSATT rad rullas tillbaka, för i just det fallet
  // hinner ingen rad skapas: `assertPeriodOpen` ligger FÖRE
  // `journalEntrySequence.upsert` och före `journalEntry.create`
  // (`verifikationsnummer.service.ts:77-79`). Spärren fäller alltså innan
  // skrivningen börjat.
  //
  // Hela `confirmCharge` vilar ändå på att en insatt rad KAN rullas tillbaka —
  // det är det som gör statusflippen och verifikatet till en enhet. Provet nedan
  // mäter just den egenskapen, på den riktiga skrivvägen, utan attrapp: en äkta
  // transaktion där verifikatet först skapas på riktigt (rad, rader OCH
  // sekvensökning), och som därefter fälls.
  //
  // VAD PROVET INTE ÄR: felet injiceras av provet, inte av en produktväg.
  // `confirmCharge`s egen skriv-sedan-fall-gren — verifikatet skapat, `count`
  // blir 0, omläsningen visar något annat än CONFIRMED/ATTACHED — kräver en
  // samtidig annullering, och någon annulleringsväg för charges finns inte. Den
  // grenen mäts i stället på enhetsnivå i `consumption.compliance.spec.ts`.
  // Här mäts mekanismen den grenen förlitar sig på.
  it('verifikat som hunnit skapas rullas tillbaka med transaktionen — rad, rader och nummerserie', async () => {
    const r = await såRigg()
    const charge = await prisma.consumptionCharge.findUniqueOrThrow({ where: { id: r.chargeId } })

    class AvsiktligtFel extends Error {}
    let sedanInutiTx: { id: string; rader: number } | null = null

    await expect(
      prisma.$transaction(async (tx) => {
        const entry = await accounting.createJournalEntryForConsumptionCharge(
          charge,
          r.orgId,
          r.userId,
          tx as never,
        )
        // INUTI transaktionen finns verifikatet på riktigt — annars mäter provet
        // ingenting alls efteråt (en rollback av något som aldrig skrevs är
        // grön av fel skäl).
        const inne = await tx.journalEntry.findFirstOrThrow({
          where: { organizationId: r.orgId, sourceId: `consumption-charge:${r.chargeId}` },
          include: { lines: true },
        })
        sedanInutiTx = { id: inne.id, rader: inne.lines.length }
        expect(entry).not.toBeNull()
        throw new AvsiktligtFel('fel efter att verifikatet skrivits')
      }, PRISMA_DEFAULT_TX_LIMITS),
    ).rejects.toBeInstanceOf(AvsiktligtFel)

    // Sonden kunde ge något annat än noll: den gav en rad med två konteringsrader.
    expect(sedanInutiTx).not.toBeNull()
    expect(sedanInutiTx!.rader).toBe(2)

    // Och efteråt finns ingenting kvar — varken posten, raderna eller numret.
    expect(await verifikat(r)).toHaveLength(0)
    expect(
      await prisma.journalEntryLine.count({ where: { journalEntryId: sedanInutiTx!.id } }),
    ).toBe(0)
    expect(
      await prisma.journalEntrySequence.findMany({ where: { organizationId: r.orgId } }),
    ).toHaveLength(0)
    expect(await status(r.chargeId)).toBe('DRAFT')
  })

  // ── 5c. VAD SOM RÄKNAS SOM "REDAN BOKFÖRD" ───────────────────────────────

  it('en annan organisations verifikat med IDENTISK sourceId ger inget klartecken', async () => {
    const r = await såRigg()
    const främmande = await såRigg()

    // Samma sourceId-sträng, men i en annan organisation. Uppslaget får inte
    // läsa den som "redan bokförd" — då hade posten blivit CONFIRMED utan ett
    // eget verifikat, alltså exakt F017 igen fast via org-gränsen.
    const konton = await prisma.account.findMany({ where: { organizationId: främmande.orgId } })
    const f1510 = konton.find((k) => k.number === 1510)!
    const f3920 = konton.find((k) => k.number === 3920)!
    const främmandePost = await prisma.journalEntry.create({
      data: {
        organizationId: främmande.orgId,
        date: PERIOD_END,
        description: 'Främmande post med samma nyckel',
        source: 'INVOICE',
        sourceId: `consumption-charge:${r.chargeId}`,
        series: 'A',
        verNumber: 9001,
        fiscalYear: 2026,
        lines: {
          create: [
            { accountId: f1510.id, debit: 1 },
            { accountId: f3920.id, credit: 1 },
          ],
        },
      },
      select: { id: true },
    })

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    // Ett EGET verifikat skapades — inte den främmande raden återanvänd.
    // (Att `egna[0].organizationId` är r.orgId vore en tautologi: `verifikat()`
    // filtrerar redan på org. Det som kan falla är att raden är en ANNAN rad.)
    const egna = await verifikat(r)
    expect(egna).toHaveLength(1)
    expect(egna[0]!.id).not.toBe(främmandePost.id)
    expect(egna[0]!.lines).toHaveLength(2)
    expect(egna[0]!.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)).toBe(600)

    // Och den främmande posten är orörd — varken läst som vår eller ändrad.
    const kvar = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: främmandePost.id },
      include: { lines: true },
    })
    expect(kvar.verNumber).toBe(9001)
    expect(kvar.lines).toHaveLength(2)
    expect(await status(r.chargeId)).toBe('CONFIRMED')
  })

  it('gammal CONFIRMED utan verifikat, öppen period: läks och bokförs på periodEnd — inte på idag', async () => {
    const r = await såRigg()
    // Efterliknar en post som blev CONFIRMED före rättningen: status satt,
    // verifikat saknas. Inget fabricerat verifikat, ingen historikändring —
    // enbart det tillstånd F017 kunde lämna efter sig.
    await prisma.consumptionCharge.update({
      where: { id: r.chargeId },
      data: { status: 'CONFIRMED' },
    })
    expect(await verifikat(r)).toHaveLength(0)

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    const entries = await verifikat(r)
    expect(entries).toHaveLength(1)
    // AVGÖRANDE: mätperiodens slut, aldrig bekräftelsedagen. En self-heal som
    // bokförde på dagens datum hade flyttat intäkten till ett annat år.
    expect(entries[0]!.date.toISOString().slice(0, 10)).toBe('2026-05-31')
    expect(entries[0]!.fiscalYear).toBe(2026)
    expect(await status(r.chargeId)).toBe('CONFIRMED')
  })

  it('gammal CONFIRMED utan verifikat, STÄNGD period: avvisas — statusen rörs inte', async () => {
    const r = await såRigg()
    await prisma.consumptionCharge.update({
      where: { id: r.chargeId },
      data: { status: 'CONFIRMED' },
    })
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      ConflictException,
    )

    // Statusen får inte nedgraderas av ett misslyckat läkningsförsök, och
    // ingenting får bokföras i en annan period för att komma runt spärren.
    expect(await status(r.chargeId)).toBe('CONFIRMED')
    expect(await verifikat(r)).toHaveLength(0)
  })

  it('ATTACHED utan verifikat: läks med rätt belopp, och statusen nedgraderas inte', async () => {
    const r = await såRigg()
    await prisma.consumptionCharge.update({
      where: { id: r.chargeId },
      data: { status: 'ATTACHED' },
    })
    const före = await prisma.consumptionCharge.findUniqueOrThrow({ where: { id: r.chargeId } })

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    const entries = await verifikat(r)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)).toBe(600)
    expect(entries[0]!.date.toISOString().slice(0, 10)).toBe('2026-05-31')

    // Statusen får inte falla tillbaka till CONFIRMED, och kopplingen till
    // dokumentet får inte skrivas om av en läkning. (Riggen har ingen faktura,
    // så `invoiceId` är null här — det som mäts är att fältet är OFÖRÄNDRAT,
    // inte att det har ett visst värde.)
    const efter = await prisma.consumptionCharge.findUniqueOrThrow({ where: { id: r.chargeId } })
    expect(efter.status).toBe('ATTACHED')
    expect(efter.invoiceId).toBe(före.invoiceId)
  })

  // ── 5d. LÄSANDE INVENTERING AV REDAN SKADADE POSTER ──────────────────────
  //
  // INTE EN PRODUKTFUNKTION. Frågan nedan är inte kopplad till någon rutt, något
  // jobb eller någon vy — den finns här för att en inventering av vad F017
  // redan hunnit lämna efter sig ska kunna beslutas separat, på ett underlag
  // som är PRÖVAT i stället för påstått. Ingen backfill, ingen rättelse, inget
  // skrivande: frågan är en ren SELECT.
  //
  // Provet är kanariefågeln åt båda hållen. En diagnosfråga som alltid svarar
  // "noll" ser likadan ut som en frisk databas, och en som alltid svarar
  // "något" ser likadan ut som en trasig. Därför mäts båda riktningarna på
  // samma syntetiska data.
  const INVENTERING_SQL = `
    SELECT c."organizationId",
           count(*)                                      AS antal,
           count(*) FILTER (WHERE c.status = 'ATTACHED')  AS varav_redan_levererade,
           min(c."periodEnd")                             AS aldsta_period,
           max(c."periodEnd")                             AS nyaste_period,
           sum(c."totalAmount")                           AS totalbelopp
    FROM "ConsumptionCharge" c
    WHERE c.status IN ('CONFIRMED', 'ATTACHED')
      AND NOT EXISTS (
            SELECT 1
            FROM "JournalEntry" j
            WHERE j."organizationId" = c."organizationId"
              AND j.source = 'INVOICE'
              AND j."sourceId" = 'consumption-charge:' || c.id)
    GROUP BY c."organizationId"
    ORDER BY antal DESC`

  interface InventeringsRad {
    organizationId: string
    antal: bigint
    varav_redan_levererade: bigint
    aldsta_period: Date
    nyaste_period: Date
    totalbelopp: unknown
  }

  const inventera = async (orgId: string): Promise<InventeringsRad | undefined> => {
    const rader = await prisma.$queryRawUnsafe<InventeringsRad[]>(INVENTERING_SQL)
    return rader.find((r) => r.organizationId === orgId)
  }

  it('inventeringsfrågan hittar skadade poster — och tiger om friska', async () => {
    const r = await såRigg()

    // (1) FRISK: bekräftad på riktigt, alltså med verifikat. Får inte listas.
    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)
    expect(await verifikat(r)).toHaveLength(1)
    expect(await inventera(r.orgId)).toBeUndefined()

    // (2) SKADAD: en post som står CONFIRMED utan verifikat, och en som hunnit
    // bli ATTACHED — exakt de två tillstånd F017 kunde lämna efter sig. Byggda
    // på syntetiska rader i den här riggen, aldrig på produktionsdata.
    const skadad = async (status: 'CONFIRMED' | 'ATTACHED') => {
      const rad = await prisma.consumptionCharge.findFirstOrThrow({
        where: { organizationId: r.orgId },
      })
      const ny = await prisma.consumptionCharge.create({
        data: {
          organizationId: rad.organizationId,
          leaseId: rad.leaseId,
          unitId: rad.unitId,
          tenantId: rad.tenantId,
          meterReadingId: rad.meterReadingId,
          meterType: rad.meterType,
          periodStart: rad.periodStart,
          periodEnd: rad.periodEnd,
          quantity: rad.quantity,
          pricePerUnit: rad.pricePerUnit,
          netAmount: rad.netAmount,
          vatStatus: rad.vatStatus,
          vatRate: rad.vatRate,
          vatAmount: rad.vatAmount,
          totalAmount: rad.totalAmount,
          kind: rad.kind,
          status,
          deliveryMode: rad.deliveryMode,
        },
        select: { id: true },
      })
      return ny.id
    }
    await skadad('CONFIRMED')
    await skadad('ATTACHED')

    // (3) Sonden ger nu något ANNAT än noll, och rätt uppdelning.
    const träff = await inventera(r.orgId)
    expect(träff).toBeDefined()
    expect(Number(träff!.antal)).toBe(2)
    expect(Number(träff!.varav_redan_levererade)).toBe(1)
    expect(Number(träff!.totalbelopp)).toBe(1200)
    // Periodkolumnerna är det som gör träffen handlingsbar — utan dem vet den
    // som läser inventeringen inte vilka bokföringsperioder som berörs, och de
    // avgör om posterna alls går att läka (stängd period nekar).
    expect(new Date(träff!.aldsta_period).toISOString().slice(0, 10)).toBe('2026-05-31')
    expect(new Date(träff!.nyaste_period).toISOString().slice(0, 10)).toBe('2026-05-31')

    // (4) Den friska posten är fortfarande utanför träffmängden — annars mätte
    // frågan "alla bekräftade poster", inte "bekräftade poster utan verifikat".
    const alla = await prisma.consumptionCharge.count({
      where: { organizationId: r.orgId, status: { in: ['CONFIRMED', 'ATTACHED'] } },
    })
    expect(alla).toBe(3)
  })

  // ── 5e. NEGATIV TARIFF PÅ DEN RIKTIGA VÄGEN ──────────────────────────────
  //
  // Spärren mot negativt belopp (`recordReading`) prövas på enhetsnivå med en
  // attrapp som lämnar tillbaka en negativ tariff. Det provet mäter att spärren
  // FALLER — men det tar premissen på förtroende: att en negativ tariffrad alls
  // kan ligga i databasen. `CreateTariffDto.pricePerUnit` har `@Min(0)`, och om
  // kolumnen dessutom hade en CHECK-constraint vore spärren onåbar dekoration.
  //
  // Provet nedan mäter premissen i stället för att påstå den: raden SKRIVS mot
  // riktig Postgres, och först därefter körs den riktiga tjänstevägen. Skulle
  // någon senare lägga till en CHECK-constraint blir det HÄR provet rött — och
  // det är det ärliga utfallet, för då ska spärren i tjänsten tas bort.
  it('negativ tariff går att skriva i databasen — och avvisas av tjänsten, utan att något sparas', async () => {
    const r = await såRigg()

    // (1) Premissen, mätt: kolumnen tar emot ett negativt pris.
    const tariff = await prisma.consumptionTariff.create({
      data: {
        organizationId: r.orgId,
        scope: 'ORGANIZATION',
        meterType: 'ELECTRICITY',
        pricePerUnit: -2.5,
        validFrom: d(2026, 1, 1),
      },
      select: { id: true, pricePerUnit: true },
    })
    expect(Number(tariff.pricePerUnit)).toBeLessThan(0)

    const avläsningarFöre = await prisma.meterReading.count({ where: { organizationId: r.orgId } })

    // (2) Den riktiga tjänstevägen, inte en attrapp.
    await expect(
      consumption.recordReading(
        {
          meterId: r.meterId,
          value: 1300,
          readingDate: '2026-06-30',
          periodStart: '2026-06-01',
          periodEnd: '2026-06-30',
          source: 'MANUAL',
        } as never,
        r.orgId,
        r.userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)

    // (3) Ingenting sparat — varken avläsning eller debitering.
    expect(await prisma.meterReading.count({ where: { organizationId: r.orgId } })).toBe(
      avläsningarFöre,
    )
    expect(
      await prisma.consumptionCharge.count({
        where: { organizationId: r.orgId, periodEnd: d(2026, 6, 30) },
      }),
    ).toBe(0)
  })

  // ── 6. ORG-ISOLERING ─────────────────────────────────────────────────────

  it('en annan organisations id kan varken bokföra eller flippa posten', async () => {
    const egen = await såRigg()
    const främmande = await såRigg()

    await expect(
      consumption.confirmCharge(egen.chargeId, främmande.orgId, främmande.userId),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(await status(egen.chargeId)).toBe('DRAFT')
    expect(await verifikat(egen)).toHaveLength(0)
  })

  it('en stängd period hos EN organisation fäller inte en annans confirm', async () => {
    const stängd = await såRigg()
    const öppen = await såRigg()
    await stängMaj(stängd)

    await consumption.confirmCharge(öppen.chargeId, öppen.orgId, öppen.userId)

    expect(await status(öppen.chargeId)).toBe('CONFIRMED')
    expect(await verifikat(öppen)).toHaveLength(1)
  })

  // ── 7. ANNULLERAD POST ───────────────────────────────────────────────────

  it('annullerad post kan inte bokföras och får inget verifikat', async () => {
    const r = await såRigg()
    await prisma.consumptionCharge.update({
      where: { id: r.chargeId },
      data: { status: 'CANCELLED' },
    })

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeInstanceOf(
      BadRequestException,
    )

    expect(await status(r.chargeId)).toBe('CANCELLED')
    expect(await verifikat(r)).toHaveLength(0)
  })
})
