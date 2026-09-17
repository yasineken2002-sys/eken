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

import { ConflictException, NotFoundException } from '@nestjs/common'
import { PrismaClient, UserRole } from '@prisma/client'

import { AccountingPeriodService } from '../accounting/accounting-period.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
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

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
    })
    await prisma.$connect()
    const verifikationsnummer = new VerifikationsnummerService(prisma as never)
    const accounting = new AccountingService(prisma as never, verifikationsnummer)
    const invoiceEvents = new InvoiceEventsService(prisma as never)
    consumption = new ConsumptionService(prisma as never, accounting, invoiceEvents)
    perioder = new AccountingPeriodService(prisma as never, accounting)
  })

  afterAll(async () => {
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

  it('stängd period: inget verifikationsnummer bränns (serien förblir obruten)', async () => {
    const r = await såRigg()
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeDefined()

    const sekvens = await prisma.journalEntrySequence.findMany({
      where: { organizationId: r.orgId },
    })
    expect(sekvens).toHaveLength(0)
  })

  it('stängd period: posten plockas INTE upp som fakturerbar efteråt', async () => {
    const r = await såRigg()
    await stängMaj(r)

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeDefined()

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

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeDefined()

    expect(await status(r.chargeId)).toBe('DRAFT')
    expect(await verifikat(r)).toHaveLength(0)
  })

  // ── 4. OMFÖRSÖK EFTER AVHJÄLPT FEL ───────────────────────────────────────

  it('omförsök efter att perioden öppnats igen: confirm går igenom och ger ETT verifikat', async () => {
    const r = await såRigg()
    await stängMaj(r)
    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeDefined()

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
    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeDefined()

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

    // Ingen av de två får lämna kvar ett halvfärdigt tillstånd, och ingen får
    // svara "bokförd" utan att verifikatet finns.
    expect(utfall.filter((u) => u.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(await status(r.chargeId)).toBe('CONFIRMED')
    expect(await verifikat(r)).toHaveLength(1)
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

    await expect(consumption.confirmCharge(r.chargeId, r.orgId, r.userId)).rejects.toBeDefined()

    expect(await status(r.chargeId)).toBe('CANCELLED')
    expect(await verifikat(r)).toHaveLength(0)
  })
})
