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

    return { orgId: org.id, userId: user.id, chargeId: charge.id, leaseId: lease.id }
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

  it('två SAMTIDIGA confirm: ETT verifikat, CONFIRMED, inget halvfärdigt kvar', async () => {
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
    await prisma.journalEntry.create({
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
    })

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    const egna = await verifikat(r)
    expect(egna).toHaveLength(1)
    expect(egna[0]!.organizationId).toBe(r.orgId)
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

  it('ATTACHED utan verifikat: läks utan att statusen eller fakturakopplingen rörs', async () => {
    const r = await såRigg()
    await prisma.consumptionCharge.update({
      where: { id: r.chargeId },
      data: { status: 'ATTACHED' },
    })

    await consumption.confirmCharge(r.chargeId, r.orgId, r.userId)

    expect(await verifikat(r)).toHaveLength(1)
    expect(await status(r.chargeId)).toBe('ATTACHED')
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
