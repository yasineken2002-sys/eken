/**
 * INTEGRATIONSPROV FÖR DEN SAMLADE GRENEN — den söm ingen enskild PR äger.
 *
 * ── VARFÖR FILEN FINNS ─────────────────────────────────────────────────────
 *
 * De tre kandidaterna i `integration/3fix-20260917` provar var sitt ben:
 *
 *   #902 (F034)  `bankimport-transaktionsidentitet.db.spec.ts` — importen, men
 *                aldrig mot en förbrukningsfaktura (noll träffar på UTILITY).
 *   #903 (F017)  `utility-invoice-payment-accrual.db.spec.ts` — betalningen,
 *                men med en bankrad som riggen skapar DIREKT med
 *                `prisma.bankTransaction.create`, inte via filimport.
 *
 * Ingen av dem följer kedjan HELA vägen. Den här filen gör det, och bara det:
 * bekräftad förbrukningsfordran → verklig filimport → verklig matchning.
 *
 * ── INGENTING I KEDJAN ÄR STUBBAT ──────────────────────────────────────────
 *
 * `confirmCharge` (#901), fält-dedupen i `ingestFromFile` (#902),
 * `assertInvoiceReceivableBacked` med UTILITY-grenen (#903) och
 * betalningsbokningen är riktiga, mot riktig Postgres, med riktig
 * `PaymentFreshnessService`. Inerta attrapper endast för PDF, lagring, mail,
 * notiser och kö — ingen av dem ligger i kedjan som mäts.
 *
 * ── GRÄNSEN, LÄST UR KODEN OCH INTE UPPFUNNEN ──────────────────────────────
 *
 * En importerad bankrad AUTOMATMATCHAS ALDRIG mot en förbrukningsfaktura, och
 * provet låtsas inte att den gör det:
 *
 *   1. `invoiceSeparateCharges` skapar fakturan utan `ocrNumber` och utan
 *      `reference` (`consumption.service.ts`, rå `tx.invoice.create`).
 *   2. `matchTransaction`s OCR-gren slår upp just `Invoice.ocrNumber` och
 *      `Invoice.reference` — ingen av dem är satt, alltså ingen träff.
 *   3. Bär raden ett `rawOcr` som inte löser ut hoppas fuzzy över MED FLIT
 *      (M2-grinden i `reconciliation.service.ts`).
 *
 * Matchningen kräver därför ett EXPLICIT tjänsteanrop, och provet kör det:
 * `reconciliation.manualMatch(...)`. Det är produktens verkliga kontrakt i dag.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

// Samma mönster som `utility-invoice-payment-accrual.db.spec.ts`: PDF- och
// lagringstjänsten dras annars in transitivt med ett ESM-paket jest inte
// transformerar. Ingen jest-konfiguration ändras.
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AccountingService } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { ConsumptionService } from '../consumption/consumption.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { InvoicesService } from '../invoices/invoices.service'
import { OcrService } from '../common/ocr/ocr.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const d = (y: number, m: number, dag: number) => new Date(Date.UTC(y, m - 1, dag, 10, 0, 0))
const inert = new Proxy({}, { get: () => async () => undefined }) as never

const BETALDAG = '2026-06-10'
const BANKTEXT = 'Insattning'
const BELOPP = 600
// Två skilda betalningsreferenser. Under basen kollapsar raderna till EN
// (`{date, description, amount}`); med #902 bär nyckeln även `reference`.
const REF_A = '77012345'
const REF_B = '88054321'

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('INTEGRATION: förbrukningsfordran → filimport → betalningsmatchning', () => {
  let prisma: PrismaClient
  let accounting: AccountingService
  let consumption: ConsumptionService
  let invoices: InvoicesService
  let reconciliation: ReconciliationService
  const skapadeOrgar: string[] = []

  beforeAll(async () => {
    prisma = new PrismaClient()
    await prisma.$connect()
    const verif = new VerifikationsnummerService(prisma as never)
    accounting = new AccountingService(prisma as never, verif)
    const events = new InvoiceEventsService(prisma as never)
    consumption = new ConsumptionService(prisma as never, accounting, events)
    invoices = new InvoicesService(
      prisma as never,
      events,
      inert,
      inert,
      accounting,
      inert,
      new OcrService(prisma as never),
      inert,
    )
    // RIKTIG färskhetstjänst: importen ska flytta fram `paymentDataThrough` på
    // riktigt, inte mot en attrapp som svarar det den blir tillsagd.
    const freshness = new PaymentFreshnessService(prisma as never, inert)
    reconciliation = new ReconciliationService(
      prisma as never,
      invoices as never,
      events as never,
      accounting,
      freshness as never,
      inert,
      inert,
      inert,
      // #F034b — filnivåns importskydd. Riktig tjänst över samma prisma som
      // resten av riggen: proven nedan som inte kör en import når den aldrig,
      // och de som gör det ska se skyddet och inte ett genomsläpp.
      new BankImportAttemptService(prisma as never),
    )
  })

  afterAll(async () => {
    for (const orgId of skapadeOrgar) {
      await prisma.invoicePayment.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
      await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntry: { organizationId: orgId } },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.consumptionCharge.deleteMany({ where: { organizationId: orgId } })
      await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
      await prisma.meterReading.deleteMany({ where: { organizationId: orgId } })
      await prisma.meter.deleteMany({ where: { organizationId: orgId } })
      await prisma.consumptionTariff.deleteMany({ where: { organizationId: orgId } })
      await prisma.lease.deleteMany({ where: { organizationId: orgId } })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
      await prisma.property.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      await prisma.invoiceNumberSequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.delete({ where: { id: orgId } })
    }
    await prisma.$disconnect()
  })

  interface Rigg {
    orgId: string
    userId: string
    leaseId: string
    meterId: string
  }

  /** Samma syntetiska rigg som #903:s spec — organisation, kontoplan, mätare, tariff. */
  const såRigg = async (): Promise<Rigg> => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `int-${sfx}`,
        email: `int-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    skapadeOrgar.push(org.id)
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `int-${sfx}@example.se`,
        firstName: 'Ä',
        lastName: 'Ö',
        role: 'OWNER',
      },
      select: { id: true },
    })
    for (const [nr, namn, typ] of [
      [1510, 'Kundfordringar', 'ASSET'],
      [1930, 'Företagskonto', 'ASSET'],
      [3920, 'Förbrukning', 'REVENUE'],
    ] as const) {
      await prisma.account.create({
        data: { organizationId: org.id, number: nr, name: namn, type: typ },
      })
    }
    const property = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: sfx,
        propertyDesignation: sfx,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
        consumptionBillingMode: 'SEPARATE_INVOICE',
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: '1001',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 60,
        monthlyRent: 9000,
      },
      select: { id: true },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'H',
        lastName: 'G',
        email: `t-${sfx}@example.se`,
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
        consumptionBillingMode: 'SEPARATE_INVOICE',
      },
      select: { id: true },
    })
    const meter = await prisma.meter.create({
      data: { organizationId: org.id, unitId: unit.id, type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
      select: { id: true },
    })
    await prisma.consumptionTariff.create({
      data: {
        organizationId: org.id,
        scope: 'ORGANIZATION',
        meterType: 'ELECTRICITY',
        pricePerUnit: 2.5,
        validFrom: d(2026, 1, 1),
      },
    })
    // Öppningsavläsning — baslinje, ingen debitering.
    await consumption.recordReading(
      {
        meterId: meter.id,
        value: 1000,
        readingDate: '2026-04-30',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        source: 'MANUAL',
      } as never,
      org.id,
      user.id,
    )
    return { orgId: org.id, userId: user.id, leaseId: lease.id, meterId: meter.id }
  }

  /** CSV med svenska kolumnnamn — samma form importvägen känner igen. */
  const csv = (rader: Array<[string, string, string, string]>): Buffer =>
    Buffer.from(['Datum;Text;Belopp;Referens', ...rader.map((r) => r.join(';'))].join('\n'), 'utf8')

  const verifikatFor = (orgId: string, sourceId: string) =>
    prisma.journalEntry.count({ where: { organizationId: orgId, sourceId } })

  it('hela kedjan: bekräftad fordran → import med två referenser → matchning utan ny fordran → oförändrad återimport', async () => {
    const r = await såRigg()

    // ── STEG 1: FORDRAN (binder #901 F017) ────────────────────────────────
    // 240 kWh × 2,5 kr = 600 kr. `confirmCharge` bokför fordran ATOMISKT under
    // `consumption-charge:<id>` — det är den fordran hela provet vilar på.
    const res = await consumption.recordReading(
      {
        meterId: r.meterId,
        value: 1240,
        readingDate: '2026-05-28',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-28',
        source: 'MANUAL',
      } as never,
      r.orgId,
      r.userId,
    )
    const chargeId = (res.charge as { id: string }).id
    await consumption.confirmCharge(chargeId, r.orgId, r.userId)

    expect(await verifikatFor(r.orgId, `consumption-charge:${chargeId}`)).toBe(1)

    const faktura = await consumption.invoiceSeparateCharges(r.leaseId, r.orgId, r.userId)
    if (!faktura) throw new Error('ingen faktura — riggen är fel')
    await invoices.transitionStatus(faktura.id, r.orgId, 'SENT' as never, r.userId, 'USER')

    expect(Number(faktura.total)).toBe(BELOPP)
    // Fakturan bokförs ALDRIG som faktura — annars vore 1510 bokförd två gånger.
    expect(await verifikatFor(r.orgId, faktura.id)).toBe(0)
    // Gränsen, mätt och inte antagen: utan OCR/referens finns ingen nyckel som
    // automatmatchningen kan träffa på.
    const fakturaRad = await prisma.invoice.findUniqueOrThrow({
      where: { id: faktura.id },
      select: { ocrNumber: true, reference: true, type: true },
    })
    expect(fakturaRad.type).toBe('UTILITY')
    expect(fakturaRad.ocrNumber).toBeNull()
    expect(fakturaRad.reference).toBeNull()

    // ── STEG 2: FILIMPORT (binder #902 F034) ──────────────────────────────
    // Två rader som är identiska i allt utom referensen. På basen svaldes den
    // andra som dubblett — det är precis den tappade betalningen F034 rättar.
    const fil = csv([
      [BETALDAG, BANKTEXT, '600,00', REF_A],
      [BETALDAG, BANKTEXT, '600,00', REF_B],
    ])
    const imp = await reconciliation.importBankStatement(fil, 'kontoutdrag.csv', r.orgId)

    expect(imp.errors).toEqual([])
    expect(imp.imported).toBe(2)
    expect(imp.duplicates).toBe(0)

    const rader = await prisma.bankTransaction.findMany({
      where: { organizationId: r.orgId },
      orderBy: { reference: 'asc' },
      select: { id: true, reference: true, status: true },
    })
    expect(rader).toHaveLength(2)
    expect(rader.map((b) => b.reference)).toEqual([REF_A, REF_B])
    // Ingen automatmatchning skedde — se gränsen i filhuvudet.
    expect(rader.every((b) => b.status === 'UNMATCHED')).toBe(true)

    // F034:s färskhetsben: en komplett fil flyttar fram betalningsunderlagets
    // datum. Riktig PaymentFreshnessService, riktig kolumn.
    const orgEfterImport = await prisma.organization.findUniqueOrThrow({
      where: { id: r.orgId },
      select: { paymentDataThrough: true },
    })
    expect(orgEfterImport.paymentDataThrough?.toISOString().slice(0, 10)).toBe(BETALDAG)

    // ── STEG 3: MATCHNING (binder #903 UTILITY-grinden) ───────────────────
    // EXPLICIT anrop, eftersom automatmatchning inte finns för den här
    // fakturatypen. Går genom applyMatchToInvoice →
    // assertInvoiceReceivableBacked → harForbrukningstackning.
    const valdRad = rader[0]!
    await reconciliation.manualMatch(valdRad.id, { invoiceId: faktura.id }, r.orgId, r.userId)

    const efterMatch = await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })
    expect(efterMatch.status).toBe('PAID')

    const allokeringar = await prisma.invoicePayment.findMany({
      where: { invoiceId: faktura.id },
      select: { amount: true },
    })
    expect(allokeringar).toHaveLength(1)
    expect(Number(allokeringar[0]!.amount)).toBe(BELOPP)

    expect(
      await prisma.journalEntry.count({ where: { organizationId: r.orgId, source: 'PAYMENT' } }),
    ).toBe(1)
    // INGEN NY FORDRAN: varken under fakturans id eller en andra gång under
    // förbrukningsposten. Betalningen krediterar 1510 mot den fordran som redan
    // fanns — den skapar den inte.
    expect(await verifikatFor(r.orgId, faktura.id)).toBe(0)
    expect(await verifikatFor(r.orgId, `consumption-charge:${chargeId}`)).toBe(1)

    // Rätt rad matchades, och bara den.
    const statusEfter = await prisma.bankTransaction.findMany({
      where: { organizationId: r.orgId },
      orderBy: { reference: 'asc' },
      select: { reference: true, status: true },
    })
    expect(statusEfter).toEqual([
      { reference: REF_A, status: 'MATCHED' },
      { reference: REF_B, status: 'UNMATCHED' },
    ])

    // ── STEG 4: BYTEIDENTISK ÅTERIMPORT ──────────────────────────────────
    const verifikatFore = await prisma.journalEntry.count({ where: { organizationId: r.orgId } })

    const omimport = await reconciliation.importBankStatement(fil, 'kontoutdrag.csv', r.orgId)

    expect(omimport.errors).toEqual([])
    expect(omimport.imported).toBe(0)
    expect(omimport.duplicates).toBe(2)

    // Inga nya bankrader, inga nya betalningseffekter, inga nya verifikat.
    expect(await prisma.bankTransaction.count({ where: { organizationId: r.orgId } })).toBe(2)
    expect(await prisma.invoicePayment.count({ where: { invoiceId: faktura.id } })).toBe(1)
    expect(
      await prisma.journalEntry.count({ where: { organizationId: r.orgId, source: 'PAYMENT' } }),
    ).toBe(1)
    expect(await prisma.journalEntry.count({ where: { organizationId: r.orgId } })).toBe(
      verifikatFore,
    )
  })
})
