/**
 * UTILITY-BETALNINGSGRINDEN — fail-closed-vaktens tredje typmedvetna gren.
 *
 * ── VAD SOM VAR FEL ────────────────────────────────────────────────────────
 *
 * En förbrukningsfaktura bokförs ALDRIG som faktura: fordran uppstod redan vid
 * `confirmCharge` under `consumption-charge:<id>`, och `invoiceSeparateCharges`
 * bygger dokumentet förbi `InvoicesService.create` just för att 1510 och
 * intäkten inte ska bokföras en andra gång. `assertInvoiceReceivableBacked`
 * kände bara till två nycklar — `invoice.id` och `deposit-invoice:<id>` — så
 * varje FRISK förbrukningsbetalning falsk-nekades med `MissingAccrualError`.
 * Felet är äldre än rättningen av F017; det reproducerades likadant på
 * revisionen före.
 *
 * ── VARFÖR RIKTIG DATABAS ──────────────────────────────────────────────────
 *
 * Kedjan går genom sex tjänster och tre transaktioner, och det som ska mätas är
 * vad som FAKTISKT står i huvudboken efteråt: att fordran inte bokförs en andra
 * gång, att betalningsverifikatet balanserar mot 1510, och att en ofullständigt
 * bokförd faktura fortsatt nekas. En attrapp hade svarat det den blev tillsagd.
 *
 * ── VAD PROVET INTE SER ────────────────────────────────────────────────────
 *
 * HTTP-lagret, och `ReconciliationService`s egna förgreningar ovanför
 * `applyMatchToInvoice`. Mail/PDF/notiser är inerta attrapper — betalnings- och
 * matchningsvägarna rör dem inte, och inget utskick sker.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

// SAMMA MÖNSTER SOM ÖVRIGA SPECAR SOM IMPORTERAR InvoicesService
// (`invoices/invoice-service-fee-window.db.spec.ts:38-39` m.fl.): PDF- och
// lagringstjänsten dras annars in transitivt och tar med ett ESM-paket som
// jest inte transformerar. Ingen jest-konfiguration ändras; betalnings- och
// matchningsvägarna rör ingen av dem.
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { AccountingService, MissingAccrualError } from './accounting.service'
import { VerifikationsnummerService } from './verifikationsnummer.service'
import { ConsumptionService } from '../consumption/consumption.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { InvoicesService } from '../invoices/invoices.service'
import { OcrService } from '../common/ocr/ocr.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const d = (y: number, m: number, dag: number) => new Date(Date.UTC(y, m - 1, dag, 10, 0, 0))
const inert = new Proxy({}, { get: () => async () => undefined }) as never

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('UTILITY-faktura: betalningsgrinden', () => {
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
    // OcrService är RIKTIG: `generateForInvoiceSequence` är synkron och ren, och
    // den inerta attrappen gav en Promise där Prisma väntade en sträng.
    // Resten (PDF, mail, notiser, kö) rörs inte av betalningsvägarna.
    invoices = new InvoicesService(
      prisma as never, events, inert, inert, accounting, inert, new OcrService(prisma as never), inert,
    )
    reconciliation = new ReconciliationService(
      prisma as never, invoices as never, events as never, accounting,
      inert, inert, inert, inert,
    )
  })

  afterAll(async () => {
    for (const orgId of skapadeOrgar) {
      await prisma.invoicePayment.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: orgId } })
      await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
      await prisma.consumptionCharge.deleteMany({ where: { organizationId: orgId } })
      await prisma.deposit.deleteMany({ where: { organizationId: orgId } })
      await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
      // Org-flyttprovet lämnar en charge i en ANNAN organisation som fortfarande
      // pekar på DEN HÄR organisationens avläsning. Rensa via relationen, annars
      // faller `ConsumptionCharge_meterReadingId_fkey`.
      await prisma.consumptionCharge.deleteMany({ where: { meterReading: { organizationId: orgId } } })
      await prisma.meterReading.deleteMany({ where: { organizationId: orgId } })
      await prisma.meter.deleteMany({ where: { organizationId: orgId } })
      await prisma.consumptionTariff.deleteMany({ where: { organizationId: orgId } })
      await prisma.lease.deleteMany({ where: { organizationId: orgId } })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: orgId } } })
      await prisma.property.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      // Den VANLIGA fakturavägen allokerar ett nummer ur den delade sekvensen
      // (`invoices/invoice-number.ts`); raden håller org:en kvar via FK.
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
    tenantId: string
  }

  /** Syntetisk organisation med kontoplan, hyresförhållande, mätare och tariff. */
  const såRigg = async (): Promise<Rigg> => {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `ub-${sfx}`, email: `ub-${sfx}@example.se`, street: 'a', city: 'b',
              postalCode: '11111', fiscalYearStartMonth: 1 }, select: { id: true } })
    skapadeOrgar.push(org.id)
    const user = await prisma.user.create({
      data: { organizationId: org.id, email: `ub-${sfx}@example.se`, firstName: 'Ä',
              lastName: 'Ö', role: 'OWNER' }, select: { id: true } })
    for (const [nr, namn, typ] of [
      [1510, 'Kundfordringar', 'ASSET'], [1930, 'Företagskonto', 'ASSET'],
      [1920, 'Klientmedel', 'ASSET'], [2420, 'Deposition', 'LIABILITY'],
      [3911, 'Hyresintäkt bostad', 'REVENUE'], [3920, 'Förbrukning', 'REVENUE'],
    ] as const) {
      await prisma.account.create({
        data: { organizationId: org.id, number: nr, name: namn, type: typ } })
    }
    const property = await prisma.property.create({
      data: { organizationId: org.id, name: sfx, propertyDesignation: sfx, type: 'RESIDENTIAL',
              street: 'a', city: 'b', postalCode: '11111', totalArea: 100,
              consumptionBillingMode: 'SEPARATE_INVOICE' }, select: { id: true } })
    const unit = await prisma.unit.create({
      data: { propertyId: property.id, name: '1001', unitNumber: '1001', type: 'APARTMENT',
              area: 60, monthlyRent: 9000 }, select: { id: true } })
    const tenant = await prisma.tenant.create({
      data: { organizationId: org.id, type: 'INDIVIDUAL', firstName: 'H', lastName: 'G',
              email: `t-${sfx}@example.se` }, select: { id: true } })
    const lease = await prisma.lease.create({
      data: { organizationId: org.id, unitId: unit.id, tenantId: tenant.id, status: 'ACTIVE',
              startDate: d(2026, 1, 1), tenancyStartDate: d(2026, 1, 1), monthlyRent: 9000,
              depositAmount: 0, consumptionBillingMode: 'SEPARATE_INVOICE' },
      select: { id: true } })
    const meter = await prisma.meter.create({
      data: { organizationId: org.id, unitId: unit.id, type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
      select: { id: true } })
    await prisma.consumptionTariff.create({
      data: { organizationId: org.id, scope: 'ORGANIZATION', meterType: 'ELECTRICITY',
              pricePerUnit: 2.5, validFrom: d(2026, 1, 1) } })
    // Öppningsavläsning — baslinje, ingen debitering.
    await consumption.recordReading({ meterId: meter.id, value: 1000, readingDate: '2026-04-30',
      periodStart: '2026-04-01', periodEnd: '2026-04-30', source: 'MANUAL' } as never,
      org.id, user.id)
    return { orgId: org.id, userId: user.id, leaseId: lease.id, meterId: meter.id,
             tenantId: tenant.id }
  }

  /** Registrerar en avläsning och bekräftar dess charge. Returnerar charge-id. */
  const debiteraOchBokfor = async (r: Rigg, värde: number, månad: number): Promise<string> => {
    const res = await consumption.recordReading({
      meterId: r.meterId, value: värde, readingDate: `2026-0${månad}-28`,
      periodStart: `2026-0${månad}-01`, periodEnd: `2026-0${månad}-28`, source: 'MANUAL',
    } as never, r.orgId, r.userId)
    const chargeId = (res.charge as { id: string }).id
    await consumption.confirmCharge(chargeId, r.orgId, r.userId)
    return chargeId
  }

  /** Bygger UTILITY-fakturan via den RIKTIGA vägen och för den till SENT. */
  const fakturera = async (r: Rigg) => {
    const faktura = await consumption.invoiceSeparateCharges(r.leaseId, r.orgId, r.userId)
    if (!faktura) throw new Error('ingen faktura — riggen är fel')
    // Samma anrop `sendInvoiceEmail` gör för att sätta SENT. Inget utskick.
    await invoices.transitionStatus(faktura.id, r.orgId, 'SENT' as never, r.userId, 'USER')
    return faktura
  }

  /**
   * BETALD SUMMA ÄR HÄRLEDD, INTE LAGRAD. `Invoice` bär `paidAt` men inget
   * belopp — skulden är ett beräknat tillstånd ur `InvoicePayment`-allokeringarna
   * (`invoice-debt.ts:88 computeInvoiceDebt`). Provet mäter därför allokeringarna,
   * inte ett fält som inte finns.
   */
  const betaltBelopp = async (fakturaId: string): Promise<number> => {
    const rader = await prisma.invoicePayment.findMany({
      where: { invoiceId: fakturaId }, select: { amount: true } })
    return rader.reduce((s, r) => s + Number(r.amount), 0)
  }

  const verifikat = (orgId: string) =>
    prisma.journalEntry.findMany({
      where: { organizationId: orgId },
      select: { sourceId: true, source: true },
      orderBy: { verNumber: 'asc' },
    })

  const betalaManuellt = (fakturaId: string, r: Rigg, belopp: number) =>
    invoices.markAsPaidManually(fakturaId, r.orgId, 'BANK' as never, r.userId, 'USER',
      { enteredAmount: belopp, paidAt: d(2026, 6, 10) })

  const matchaBank = async (fakturaId: string, r: Rigg, belopp: number) => {
    const btx = await prisma.bankTransaction.create({
      data: { organizationId: r.orgId, date: d(2026, 6, 10), amount: belopp,
              description: 'SYNTETISK TESTRAD — ingen riktig bankdata', status: 'UNMATCHED' },
      select: { id: true } })
    await reconciliation.manualMatch(btx.id, { invoiceId: fakturaId }, r.orgId, r.userId)
    return btx.id
  }

  // ── 1. FRISK FAKTURA, EN POST ────────────────────────────────────────────

  it('en bokförd post: manuell betalning går igenom och fordran bokförs INTE igen', async () => {
    const r = await såRigg()
    const chargeId = await debiteraOchBokfor(r, 1240, 5)
    const faktura = await fakturera(r)
    const före = await verifikat(r.orgId)
    expect(före.map((e) => e.sourceId)).toEqual([`consumption-charge:${chargeId}`])

    await betalaManuellt(faktura.id, r, 600)

    const efter = await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })
    expect(efter.status).toBe('PAID')
    expect(efter.paidAt).not.toBeNull()
    expect(await betaltBelopp(faktura.id)).toBe(600)

    const allokeringar = await prisma.invoicePayment.findMany({ where: { invoiceId: faktura.id } })
    expect(allokeringar).toHaveLength(1)
    expect(Number(allokeringar[0]!.amount)).toBe(600)

    // Betalningsverifikatet finns, nycklat på ALLOKERINGEN.
    const efterV = await verifikat(r.orgId)
    expect(efterV).toHaveLength(2)
    expect(efterV[1]!.sourceId).toBe(`invoice-manual-payment:${allokeringar[0]!.id}`)

    // ── FORDRAN/INTÄKT SKAPAS INTE IGEN ────────────────────────────────────
    // Ingen post under fakturans id, och fortfarande exakt ETT
    // förbrukningsverifikat. Betalningen krediterar 1510 mot 1930; den bokför
    // inte om vare sig fordran eller intäkt.
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, sourceId: faktura.id } })).toBe(0)
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, sourceId: `consumption-charge:${chargeId}` } })).toBe(1)

    const betV = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: r.orgId, source: 'PAYMENT' },
      include: { lines: { include: { account: true } } } })
    expect(betV.lines.find((l) => l.account.number === 1930)?.debit?.toString()).toBe('600')
    expect(betV.lines.find((l) => l.account.number === 1510)?.credit?.toString()).toBe('600')
  })

  it('en bokförd post: bankmatchning går igenom', async () => {
    const r = await såRigg()
    await debiteraOchBokfor(r, 1240, 5)
    const faktura = await fakturera(r)

    const btxId = await matchaBank(faktura.id, r, 600)

    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: btxId } })).status)
      .toBe('MATCHED')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })).status)
      .toBe('PAID')
    expect(await prisma.invoicePayment.count({ where: { invoiceId: faktura.id } })).toBe(1)
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, source: 'PAYMENT' } })).toBe(1)
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, sourceId: faktura.id } })).toBe(0)
  })

  // ── 2. FLERA POSTER ──────────────────────────────────────────────────────

  it('FLERA bokförda poster: betalningen går igenom och alla tre fordringar står kvar', async () => {
    const r = await såRigg()
    const a = await debiteraOchBokfor(r, 1100, 5)
    const b = await debiteraOchBokfor(r, 1240, 6)
    const c = await debiteraOchBokfor(r, 1300, 7)
    const faktura = await fakturera(r)
    expect(Number(faktura.total)).toBe(750) // (100 + 140 + 60) × 2,50

    await betalaManuellt(faktura.id, r, 750)

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })).status)
      .toBe('PAID')
    for (const id of [a, b, c]) {
      expect(await prisma.journalEntry.count({
        where: { organizationId: r.orgId, sourceId: `consumption-charge:${id}` } })).toBe(1)
    }
  })

  // ── 3. SAKNAT UNDERLAG FÖR EN AV FLERA — EN TRÄFF RÄCKER INTE ───────────

  it('en av tre saknar sitt verifikat: betalningen NEKAS fortfarande', async () => {
    const r = await såRigg()
    await debiteraOchBokfor(r, 1100, 5)
    const b = await debiteraOchBokfor(r, 1240, 6)
    await debiteraOchBokfor(r, 1300, 7)
    const faktura = await fakturera(r)

    // Efterliknar en post som blev CONFIRMED utan verifikat (det tillstånd F017
    // kunde lämna efter sig). Verifikatet tas bort, posten står kvar ATTACHED.
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: r.orgId, sourceId: `consumption-charge:${b}` } } })
    await prisma.journalEntry.deleteMany({
      where: { organizationId: r.orgId, sourceId: `consumption-charge:${b}` } })

    await expect(betalaManuellt(faktura.id, r, 750)).rejects.toBeInstanceOf(MissingAccrualError)
    await expect(matchaBank(faktura.id, r, 750)).rejects.toBeInstanceOf(MissingAccrualError)

    const efter = await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })
    expect(efter.status).toBe('SENT')
    expect(efter.paidAt).toBeNull()
    expect(await betaltBelopp(faktura.id)).toBe(0)
    expect(await prisma.invoicePayment.count({ where: { invoiceId: faktura.id } })).toBe(0)
  })

  // ── 4. NOLL KOPPLADE POSTER — every([]) FÅR INTE GODKÄNNA ───────────────

  it('UTILITY-faktura utan kopplade poster: NEKAS (tom mängd är inte täckning)', async () => {
    const r = await såRigg()
    const chargeId = await debiteraOchBokfor(r, 1240, 5)
    const faktura = await fakturera(r)

    // Lossa posten från fakturan. Fakturan står kvar med sitt belopp men har
    // inga poster att bära det — exakt det fall `[].every(…) === true` hade
    // släppt igenom.
    await prisma.consumptionCharge.update({
      where: { id: chargeId }, data: { invoiceId: null } })

    await expect(betalaManuellt(faktura.id, r, 600)).rejects.toBeInstanceOf(MissingAccrualError)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })).status)
      .toBe('SENT')
  })

  // ── 5. FEL ORGANISATION / FEL FAKTURA ───────────────────────────────────

  it('posten tillhör en ANNAN organisation: NEKAS (ingen täckning över org-gränsen)', async () => {
    const egen = await såRigg()
    const främmande = await såRigg()
    const chargeId = await debiteraOchBokfor(egen, 1240, 5)
    const faktura = await fakturera(egen)

    // Posten pekar fortfarande på fakturan, men flyttas till en annan org.
    // Uppslaget är org-scopat, så den får inte räknas som täckning.
    await prisma.consumptionCharge.update({
      where: { id: chargeId }, data: { organizationId: främmande.orgId } })

    await expect(betalaManuellt(faktura.id, egen, 600)).rejects.toBeInstanceOf(MissingAccrualError)
  })

  it('posten är kopplad till en ANNAN faktura: NEKAS', async () => {
    const r = await såRigg()
    const chargeId = await debiteraOchBokfor(r, 1240, 5)
    const faktura = await fakturera(r)
    const b = await debiteraOchBokfor(r, 1400, 6)
    const faktura2 = await fakturera(r)

    // Flytta första fakturans post till den andra fakturan. Första fakturan har
    // då inga egna poster kvar.
    await prisma.consumptionCharge.update({
      where: { id: chargeId }, data: { invoiceId: faktura2.id } })

    await expect(betalaManuellt(faktura.id, r, Number(faktura.total)))
      .rejects.toBeInstanceOf(MissingAccrualError)
    expect(b).toBeTruthy()
  })

  // ── 6. BELOPPSMOTSÄGELSE ────────────────────────────────────────────────

  it('fakturans belopp stämmer inte med posternas summa: NEKAS', async () => {
    const r = await såRigg()
    await debiteraOchBokfor(r, 1240, 5)
    const faktura = await fakturera(r)

    // En rad har lagts till i efterhand, eller ett belopp har ändrats: fakturan
    // bär 900 medan posterna bär 600. Fordran täcker då inte kravet.
    await prisma.invoice.update({ where: { id: faktura.id }, data: { total: 900 } })

    await expect(betalaManuellt(faktura.id, r, 900)).rejects.toBeInstanceOf(MissingAccrualError)
  })

  // ── 7. DELBETALNING OCH OMFÖRSÖK ────────────────────────────────────────

  it('delbetalning följd av resten: PARTIAL → PAID, två allokeringar, två verifikat', async () => {
    const r = await såRigg()
    await debiteraOchBokfor(r, 1240, 5)
    const faktura = await fakturera(r)

    await betalaManuellt(faktura.id, r, 250)
    const mellan = await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })
    expect(mellan.status).toBe('PARTIAL')
    expect(await betaltBelopp(faktura.id)).toBe(250)

    await betalaManuellt(faktura.id, r, 350)
    const slut = await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })
    expect(slut.status).toBe('PAID')
    expect(await betaltBelopp(faktura.id)).toBe(600)

    expect(await prisma.invoicePayment.count({ where: { invoiceId: faktura.id } })).toBe(2)
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, source: 'PAYMENT' } })).toBe(2)
    // Fordran fortfarande EN gång bokförd, trots två betalningar.
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, source: 'INVOICE' } })).toBe(1)
  })

  // ── 8. REGRESSION: VANLIG FAKTURA OCH DEPOSITION ────────────────────────

  it('REGRESSION vanlig faktura: bokförd via InvoicesService → betalning går igenom', async () => {
    const r = await såRigg()
    const faktura = await invoices.create(r.orgId, r.userId, {
      leaseId: r.leaseId, type: 'RENT', dueDate: '2026-06-30', issueDate: '2026-06-01',
      lines: [{ description: 'Hyra juni', quantity: 1, unitPrice: 1000, vatRate: 0 }],
    } as never)
    await invoices.transitionStatus(faktura.id, r.orgId, 'SENT' as never, r.userId, 'USER')
    // Den vanliga vägen bokför fakturan under sitt EGET id.
    expect(await prisma.journalEntry.count({
      where: { organizationId: r.orgId, sourceId: faktura.id } })).toBe(1)

    await betalaManuellt(faktura.id, r, 1000)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })).status)
      .toBe('PAID')
  })

  it('REGRESSION vanlig faktura UTAN fordran: NEKAS fortfarande (vakten är inte uppluckrad)', async () => {
    const r = await såRigg()
    const faktura = await invoices.create(r.orgId, r.userId, {
      leaseId: r.leaseId, type: 'RENT', dueDate: '2026-06-30', issueDate: '2026-06-01',
      lines: [{ description: 'Hyra juni', quantity: 1, unitPrice: 1000, vatRate: 0 }],
    } as never)
    await invoices.transitionStatus(faktura.id, r.orgId, 'SENT' as never, r.userId, 'USER')

    // Orphan: intäktsverifikatet raderas. Vakten ska neka — och den nya grenen
    // får inte rädda den, för fakturan är inte UTILITY.
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: r.orgId, sourceId: faktura.id } } })
    await prisma.journalEntry.deleteMany({
      where: { organizationId: r.orgId, sourceId: faktura.id } })

    await expect(betalaManuellt(faktura.id, r, 1000)).rejects.toBeInstanceOf(MissingAccrualError)
  })

  it('REGRESSION deposition: fordran under deposit-invoice:<id> accepteras fortfarande', async () => {
    const r = await såRigg()
    const faktura = await invoices.create(r.orgId, r.userId, {
      leaseId: r.leaseId, type: 'DEPOSIT', dueDate: '2026-06-30', issueDate: '2026-06-01',
      lines: [{ description: 'Deposition', quantity: 1, unitPrice: 5000, vatRate: 0 }],
    } as never)
    await invoices.transitionStatus(faktura.id, r.orgId, 'SENT' as never, r.userId, 'USER')

    const deposit = await prisma.deposit.create({
      data: { organizationId: r.orgId, leaseId: r.leaseId, tenantId: r.tenantId,
              amount: 5000, status: 'PENDING', invoiceId: faktura.id }, select: { id: true } })

    // Depositionsvägen bokför under deposit-invoice:<id>, inte fakturans id.
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: r.orgId, sourceId: faktura.id } } })
    await prisma.journalEntry.updateMany({
      where: { organizationId: r.orgId, sourceId: faktura.id },
      data: { sourceId: `deposit-invoice:${deposit.id}` } })

    await betalaManuellt(faktura.id, r, 5000)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: faktura.id } })).status)
      .toBe('PAID')
  })
})
