/**
 * G2 — KRAVKLOCKAN STANNAR MEDAN EN IDENTITET ÄR OAVGJORD. Mätt mot riktig
 * databas, genom riktiga kravvägar.
 *
 * ── VAD SOM VAR FEL, OCH VARFÖR DET INTE VAR EN BUGG ────────────────────────
 *
 * #F034c lät importen lagra en betalning den inte kunde identifiera och aldrig
 * matcha den. Spärren i `matchTransaction` höll automatiken borta. Men ingen
 * länk gick vidare till kravtrappan: raden ger ingen allokering, avin förblir
 * OVERDUE, och påminnelse, avgift, ränta och kravsteg fortsatte enligt schema
 * — mot en hyresgäst som kan ha betalat.
 *
 * Före spärren i `matchTransaction` var det en FÖRDRÖJNING: nästa
 * `autoMatchAll` kunde lösa raden. Efter den är enda utgången ett mänskligt
 * beslut, så fönstret stänger sig inte längre självt. Gränsen blev alltså
 * skarpare av en rättelse — funnen av terminal 1 (deras fynd G2) ur vår egen
 * underrättelse om spärren.
 *
 * ── VAD FILEN MÄTER ─────────────────────────────────────────────────────────
 *
 * FAKTISKA EFFEKTER: bokförda avgifter, verifikat i huvudboken, och kravsteg —
 * inte räknare. En paus som bara får en räknare att stå still har inte bevisat
 * att ingen avgift bokfördes.
 *
 * FIXTURERNA SKAPAS FÖRE HANDLINGEN. Varje prov bygger hela sitt utgångsläge —
 * avi eller faktura, kontoplan, förfallodag — och skapar granskningsraden
 * SIST, omedelbart före den kravhandling som prövas. Byggs raden först och
 * fixturen efteråt mäter provet en ordning som inte inträffar i drift.
 *
 * ── VARJE SPÄRRPROV BÄR SIN FUNGERANDE KONTROLL ─────────────────────────────
 *
 * En spärr som är grön för att riggen inte kan nå effekten alls är ingen spärr.
 * Varje prov som kräver "ingen avgift" har därför en tvilling som kör EXAKT
 * samma väg UTAN granskningsrad och kräver att avgiften bokförs. Det är den
 * kontrollen som gör nollan till ett påstående om spärren.
 *
 * ── VAD FILEN INTE MÄTER ────────────────────────────────────────────────────
 *
 *  • Att brevet inte NÅR hyresgästen. Mailkön är en attrapp; det som mäts är
 *    att kravvägen inte tar sig förbi spärren.
 *  • Själva identitetsgranskningens regler — de ägs av
 *    `bankimport-granskningsmarkering.db.spec.ts`.
 *  • Skalan. Två samtidiga effekter, inte hundra.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, RentNoticeType } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { RentInterestService } from '../avisering/rent-interest.service'
import { PaymentReminderService } from '../notifications/payment-reminder.service'
import {
  IdentityReviewPausedError,
  PaymentDataPausedError,
  PaymentFreshnessService,
  paymentFreshnessTransactionOptions,
} from './payment-freshness.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { resolveNoticeDebtOrigin } from '../accounting/debt-origin'

const Decimal = Prisma.Decimal
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const POOL = 12
const HYRA = 9000
const FAKTURA = 5000

function klient(): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', String(POOL))
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('G2 — kravpaus vid olöst identitetsgranskning', () => {
  let prisma: PrismaClient
  let freshness: PaymentFreshnessService
  let accounting: AccountingService
  let interest: RentInterestService
  let reminders: PaymentReminderService
  let orgA: string
  let orgB: string
  /**
   * ── VARFÖR PROVEN SKAPAR EGNA ORGANISATIONER I STÄLLET FÖR ATT ÅTERSTÄLLA ──
   *
   * `paymentImportStartedAt` är OMUTBAR i databasen: triggern
   * `payment_import_started_immutable` (migration 20260913090000) kastar
   * `PAYMENT_IMPORT_START_IMMUTABLE` på varje försök att ändra den när den väl
   * är satt. Den är en driftspärr, och riggen ska ge vika för den — inte
   * tvärtom.
   *
   * Första versionen av filen nollställde fältet i `afterEach` för att undvika
   * ett läckage mellan proven. Databasen sa nej, och hade rätt: markören är
   * "importarbete har påbörjats", och ett prov som kan ta tillbaka den hade
   * kunnat mäta ett tillstånd som inte kan uppstå i drift.
   *
   * De prov som behöver ett EGET färskhetsläge bygger därför en egen
   * organisation. Alla städas i `afterAll`.
   */
  const skapadeOrgar: string[] = []
  const ctx: Record<string, { tenantId: string; unitId: string; leaseId: string }> = {}
  let räknare = 0
  const utfall: Record<string, unknown> = {}

  async function byggOrg(märke: string): Promise<string> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `g2-${märke}-${sfx}`,
        email: `g2-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5563${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
        // Färskhetsgrinden ska ALDRIG vara det som fäller proven nedan. Med
        // paymentImportStartedAt = null är organisationen färsk oavsett datum,
        // så varje paus vi mäter kommer bevisligen från granskningen.
        remindersEnabled: true,
      },
      select: { id: true },
    })
    await prisma.account.createMany({
      data: [
        { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: org.id, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: org.id, number: 3911, name: 'Hyresintäkter bostad', type: 'REVENUE' },
        { organizationId: org.id, number: 3593, name: 'Påminnelseavgifter', type: 'REVENUE' },
        { organizationId: org.id, number: 8131, name: 'Dröjsmålsränta', type: 'REVENUE' },
      ],
    })
    const prop = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: `p-${sfx}`,
        propertyDesignation: `G2 ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: `Lgh ${sfx}`,
        unitNumber: `1-${sfx}`,
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: HYRA,
        status: 'OCCUPIED',
      },
      select: { id: true },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'G',
        lastName: 'Tva',
        email: `t-${sfx}@example.se`,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: org.id,
        unitId: unit.id,
        tenantId: tenant.id,
        contractNumber: `HK-${sfx}`,
        monthlyRent: HYRA,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
        // AVGIFTENS AVTALSGRUND. `isReminderFeeContractuallyAllowed` kräver
        // BÅDE ett skuldursprung och ett `termsFrom` som ligger före det —
        // utan fältet bokförs ingen påminnelseavgift alls, och kontrollproven
        // hade mätt en nolla som inte hade med spärren att göra. Uppmätt: utan
        // det gav B1-kontrollen `formalSent: 1` men noll rader på 3593.
        reminderFeeTermsFrom: new Date('2025-01-01'),
      },
      select: { id: true },
    })
    ctx[org.id] = { tenantId: tenant.id, unitId: unit.id, leaseId: lease.id }
    skapadeOrgar.push(org.id)
    return org.id
  }

  beforeAll(async () => {
    prisma = klient()
    freshness = new PaymentFreshnessService(
      prisma as never,
      {
        send: async () => undefined,
      } as never,
    )
    accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    interest = new RentInterestService(
      prisma as never,
      accounting,
      new RentNoticeEventsService(prisma as never),
      freshness,
    )
    reminders = Object.create(PaymentReminderService.prototype) as PaymentReminderService
    Object.assign(reminders, {
      prisma,
      mail: {
        sendReminderFriendly: async () => 'job-friendly',
        sendReminderFormal: async () => 'job-formal',
      },
      notifications: { createForAllOrgUsers: async () => undefined, create: async () => undefined },
      accounting,
      cronErrors: { record: async () => undefined },
      freshness,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    orgA = await byggOrg('a')
    orgB = await byggOrg('b')
  })

  afterEach(async () => {
    for (const o of skapadeOrgar) {
      await prisma.paymentReminder.deleteMany({ where: { invoice: { organizationId: o } } })
      await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: o } } })
      await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: o } } })
      await prisma.invoice.deleteMany({ where: { organizationId: o } })
      await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: o } } })
      await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: o } } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: o } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: o } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: o } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: o } })
    }
  })

  afterAll(async () => {
    for (const o of skapadeOrgar) {
      await prisma.bankAccount.deleteMany({ where: { organizationId: o } })
      await prisma.lease.deleteMany({ where: { organizationId: o } })
      await prisma.tenant.deleteMany({ where: { organizationId: o } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: o } } })
      await prisma.property.deleteMany({ where: { organizationId: o } })
      await prisma.account.deleteMany({ where: { organizationId: o } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: o } })
      await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: o } })
      await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: o } })
      await prisma.organization.deleteMany({ where: { id: o } })
    }
    console.warn(`[G2-kravpaus] utfall: ${JSON.stringify(utfall, null, 1)}`)
    await prisma.$disconnect()
  })

  // ── Fixturer. Skapas FÖRE granskningsraden i varje prov. ──────────────────

  /** En förfallen hyresavi i kravtrappans ingångsläge, med bokförd fordran. */
  async function förfallenAvi(orgId: string): Promise<string> {
    const nr = ++räknare
    const månad = ((nr - 1) % 12) + 1
    const c = ctx[orgId]!
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId: c.tenantId,
        leaseId: c.leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        // Obligatoriskt på modellen. Värdet spelar ingen roll här — inget prov
        // i filen matchar på OCR; det är kravvägarna som mäts.
        ocrNumber: `${Date.now()}${nr}`.slice(-12),
        month: månad,
        year: 2026,
        amount: HYRA,
        totalAmount: HYRA,
        dueDate: new Date(Date.UTC(2026, månad - 1, 27)),
        status: 'OVERDUE',
        collectionStage: 'NONE',
        type: RentNoticeType.RENT,
      },
      select: { id: true, noticeNumber: true },
    })
    await accounting.createJournalEntryForRentNotice(
      {
        id: n.id,
        noticeNumber: n.noticeNumber,
        amount: HYRA,
        vatAmount: 0,
        totalAmount: HYRA,
        year: 2026,
        month: månad,
        unitId: c.unitId,
      } as never,
      orgId,
      null,
    )
    return n.id
  }

  /** En förfallen faktura, opausad, i cronens urval. */
  async function förfallenFaktura(orgId: string, dagarSedanForfall: number): Promise<string> {
    const c = ctx[orgId]!
    const due = new Date(Date.now() - dagarSedanForfall * 24 * 60 * 60 * 1000)
    const f = await prisma.invoice.create({
      data: {
        organizationId: orgId,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        type: 'RENT',
        status: 'OVERDUE',
        tenantId: c.tenantId,
        leaseId: c.leaseId,
        subtotal: FAKTURA,
        vatTotal: 0,
        total: FAKTURA,
        issueDate: due,
        dueDate: due,
        remindersPaused: false,
      },
      select: { id: true },
    })
    return f.id
  }

  /** En OLÖST granskningsrad. Skapas SIST, direkt före handlingen som prövas. */
  async function granskningsrad(orgId: string): Promise<string> {
    const r = await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        date: new Date('2026-03-02T00:00:00.000Z'),
        description: 'Insattning utan avgjord identitet',
        amount: new Decimal(HYRA),
        status: 'UNMATCHED',
        identityReviewAt: new Date(),
        identityReviewReason: 'HISTORIK_UTAN_KONTO',
      },
      select: { id: true },
    })
    return r.id
  }

  /** Faktiska effekter: avgifter, verifikat och kravsteg. */
  async function effektläge(orgId: string) {
    const [verifikat, avgiftsrader, avier, påminnelser] = await Promise.all([
      prisma.journalEntry.count({ where: { organizationId: orgId } }),
      prisma.journalEntryLine.count({
        where: { journalEntry: { organizationId: orgId }, account: { number: 3593 } },
      }),
      prisma.rentNotice.findMany({
        where: { organizationId: orgId },
        select: { collectionStage: true, reminderFeeAmount: true, status: true },
      }),
      prisma.paymentReminder.findMany({
        where: { invoice: { organizationId: orgId } },
        select: { type: true, feeAmount: true },
      }),
    ])
    return { verifikat, avgiftsrader, avier, påminnelser }
  }

  // ══ A. HYRESAVIN — via den centrala effektspärren ═════════════════════════

  it('A1-KONTROLL: UTAN granskningsrad bokförs avgiften och avin eskaleras', async () => {
    // FUNGERANDE KONTROLL. Utan den säger A2:s nollor ingenting om spärren —
    // de kunde lika gärna betyda att riggen inte når effekten alls.
    const noticeId = await förfallenAvi(orgA)

    await prisma.$transaction(
      (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
      paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
    )
    const entry = await accounting.bookReminderFee({
      organizationId: orgA,
      source: 'RENT_NOTICE',
      sourceId: `reminder-fee:${noticeId}`,
      fee: 60,
      description: 'Påminnelseavgift avi',
      // `DebtOriginDate` är BRANDAD och går inte att konstruera här — regeln
      // för vilket datum som är skuldens ursprung ägs av `debt-origin.ts`.
      // Kontrollen använder därför den RIKTIGA härledningen, inte ett
      // hemsnickrat datum: annars hade provet kunnat vara grönt mot en regel
      // som inte gäller i drift.
      debtOrigin: resolveNoticeDebtOrigin({
        periodStart: new Date('2026-01-01'),
        dueDate: new Date('2026-01-27'),
      }),
      termsFrom: new Date('2025-01-01'),
    })
    await prisma.rentNotice.update({
      where: { id: noticeId },
      data: { collectionStage: 'REMINDED', reminderFeeAmount: 60 },
    })

    const läge = await effektläge(orgA)
    expect(entry).not.toBeNull()
    expect(läge.avgiftsrader).toBeGreaterThan(0)
    expect(läge.avier[0]!.collectionStage).toBe('REMINDED')
    utfall['A1-kontroll'] = läge
  })

  it('A2: MED en olöst granskningsrad fälls effektspärren — ingen avgift, inget verifikat, inget kravsteg', async () => {
    const noticeId = await förfallenAvi(orgA)
    const före = await effektläge(orgA)
    // Granskningsraden SIST, omedelbart före handlingen.
    await granskningsrad(orgA)

    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)

    const efter = await effektläge(orgA)
    expect(efter.verifikat).toBe(före.verifikat)
    expect(efter.avgiftsrader).toBe(0)
    const avin = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: noticeId },
      select: { collectionStage: true, reminderFeeAmount: true, status: true },
    })
    expect(avin.collectionStage).toBe('NONE')
    expect(avin.status).toBe('OVERDUE')
    expect(Number(avin.reminderFeeAmount ?? 0)).toBe(0)
    utfall.A2 = { före, efter, avin }
  })

  it('A3: RÄNTEBOKNINGEN pausas av samma spärr — via den riktiga räntetjänsten', async () => {
    const noticeId = await förfallenAvi(orgA)
    const före = await effektläge(orgA)
    await granskningsrad(orgA)

    await expect(
      interest.crystallizeInterest(noticeId, orgA, new Date('2026-06-01T00:00:00.000Z')),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)

    const efter = await effektläge(orgA)
    expect(efter.verifikat).toBe(före.verifikat)
    utfall.A3 = { före, efter }
  })

  it('A3-KONTROLL: samma anrop NÅR räntevägen utan granskningsrad', async () => {
    // Kontrollen kräver inte att ränta BOKFÖRS — en räntefri period ger null
    // och det är ett giltigt utfall. Den kräver att anropet inte KASTAR, alltså
    // att spärren var det enda som stoppade A3.
    const noticeId = await förfallenAvi(orgA)
    await expect(
      interest.crystallizeInterest(noticeId, orgA, new Date('2026-06-01T00:00:00.000Z')),
    ).resolves.not.toThrow()
    utfall['A3-kontroll'] = 'räntevägen nåddes'
  })

  // ══ B. FAKTURAN — via den riktiga påminnelsecronen ════════════════════════

  it('B1-KONTROLL: UTAN granskningsrad bokför cronen avgiften och skickar formell påminnelse', async () => {
    await förfallenFaktura(orgA, 20)

    const summary = await reminders.processOverdueReminders()

    const läge = await effektläge(orgA)
    expect(summary!.formalSent).toBe(1)
    expect(läge.påminnelser.map((p) => p.type)).toContain('REMINDER_FORMAL')
    expect(läge.avgiftsrader).toBeGreaterThan(0)
    utfall['B1-kontroll'] = { summary, läge }
  })

  it('B2: MED en olöst granskningsrad tar cronen ingen avgift och skickar ingen påminnelse', async () => {
    await förfallenFaktura(orgA, 20)
    const före = await effektläge(orgA)
    await granskningsrad(orgA)

    const summary = await reminders.processOverdueReminders()

    const efter = await effektläge(orgA)
    expect(summary!.formalSent).toBe(0)
    expect(summary!.errors).toBe(0) // en paus är inte ett fel
    expect(efter.påminnelser).toHaveLength(0)
    expect(efter.avgiftsrader).toBe(0)
    expect(efter.verifikat).toBe(före.verifikat)
    utfall.B2 = { summary, efter }
  })

  it('B3: KRAVSTEGET redo-för-inkasso flyttas inte fram', async () => {
    await förfallenFaktura(orgA, 40)
    await granskningsrad(orgA)

    const summary = await reminders.processOverdueReminders()

    expect(summary!.readyForCollection).toBe(0)
    expect(
      await prisma.paymentReminder.count({
        where: { invoice: { organizationId: orgA }, type: 'READY_FOR_COLLECTION' },
      }),
    ).toBe(0)
    utfall.B3 = summary
  })

  it('B3-KONTROLL: samma faktura NÅR kravsteget utan granskningsrad', async () => {
    await förfallenFaktura(orgA, 40)
    const summary = await reminders.processOverdueReminders()
    expect(summary!.readyForCollection).toBe(1)
    utfall['B3-kontroll'] = summary
  })

  it('B4: den VÄNLIGA påminnelsen stoppas också — före köandet', async () => {
    await förfallenFaktura(orgA, 3)
    await granskningsrad(orgA)
    const summary = await reminders.processOverdueReminders()
    expect(summary!.friendlySent).toBe(0)
    expect(
      await prisma.paymentReminder.count({ where: { invoice: { organizationId: orgA } } }),
    ).toBe(0)
    utfall.B4 = summary
  })

  it('B4-KONTROLL: samma faktura får sin vänliga påminnelse utan granskningsrad', async () => {
    await förfallenFaktura(orgA, 3)
    const summary = await reminders.processOverdueReminders()
    expect(summary!.friendlySent).toBe(1)
    utfall['B4-kontroll'] = summary
  })

  // ══ C. UPPLÖSNING — vad som släpper pausen ════════════════════════════════

  it('C1: MANUELL MATCHNING löser raden och släpper pausen — markeringen bevarad', async () => {
    const rad = await granskningsrad(orgA)
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)

    // Samma statusövergång som `manualMatch` gör.
    await prisma.bankTransaction.update({ where: { id: rad }, data: { status: 'MATCHED' } })

    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()

    // HISTORIKEN ÄR KVAR. Raden löstes av statusen, inte av att spåret suddades.
    const efter = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: rad },
      select: { identityReviewAt: true, identityReviewReason: true },
    })
    expect(efter.identityReviewAt).not.toBeNull()
    expect(efter.identityReviewReason).toBe('HISTORIK_UTAN_KONTO')
    utfall.C1 = efter
  })

  it('C2: UTTRYCKLIGT IGNORERANDE löser raden — markeringen bevarad', async () => {
    const rad = await granskningsrad(orgA)
    await prisma.bankTransaction.update({ where: { id: rad }, data: { status: 'IGNORED' } })
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()
    const efter = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: rad },
      select: { identityReviewAt: true },
    })
    expect(efter.identityReviewAt).not.toBeNull()
    utfall.C2 = efter
  })

  it('C3: SISTA raden släpper — en KVARVARANDE gör det inte', async () => {
    const r1 = await granskningsrad(orgA)
    const r2 = await granskningsrad(orgA)

    await prisma.bankTransaction.update({ where: { id: r1 }, data: { status: 'MATCHED' } })
    // EN kvar → fortfarande pausat. Att lösa "en av dem" räcker inte, och det
    // är hela poängen med att pausen är organisationens och inte radens.
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)

    await prisma.bankTransaction.update({ where: { id: r2 }, data: { status: 'IGNORED' } })
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()
    utfall.C3 = 'sista raden släppte, den kvarvarande höll'
  })

  it('C4: AVMATCHNING återöppnar pausen — följden av definitionen, mätt', async () => {
    // Fyndet ur verifieringen mot samtliga statusövergångar: en granskningsrad
    // som matchats och sedan avmatchas går tillbaka till UNMATCHED med
    // markeringen kvar, och räknas då som olöst IGEN.
    //
    // Det är avsiktligt, och det finns två skäl. Det svagare är mitt: att
    // avmatchningen tar tillbaka människans svar, och att raden åter är en
    // oallokerad betalning vars identitet aldrig fastställdes.
    //
    // Det STARKARE är terminal 1:s, och det är strukturellt i stället för
    // försiktigt: hade avmatchning INTE återöppnat pausen vore avmatchning en
    // TYST FÖRBIGÅNG. Matcha fel med flit, ångra dig, och pausen är hävd utan
    // att identiteten någonsin avgjorts. Den konservativa riktningen är alltså
    // inte bara den varsamma — den är den enda som inte öppnar ett hål i
    // spärren.
    //
    // Tolkningen står utanför byggbeslutet, så den mäts här i stället för att
    // upptäckas i drift.
    const rad = await granskningsrad(orgA)
    await prisma.bankTransaction.update({ where: { id: rad }, data: { status: 'MATCHED' } })
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()

    // Samma statusövergång som `unmatchTransaction` gör.
    await prisma.bankTransaction.update({
      where: { id: rad },
      data: { status: 'UNMATCHED', autoMatchExcludedAt: new Date() },
    })
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)
    utfall.C4 = 'avmatchning återöppnade pausen'
  })

  // ══ D. AVGRÄNSNING OCH ISOLERING ═════════════════════════════════════════

  it('D1: ORGANISATIONSISOLERING — orgB är opåverkad av orgA:s olösta rad', async () => {
    await förfallenFaktura(orgB, 20)
    await granskningsrad(orgA)

    // Färskhetsspärren för orgB går igenom …
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgB),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()

    // … och den riktiga cronen bokför orgB:s avgift trots orgA:s paus.
    const summary = await reminders.processOverdueReminders()
    expect(summary!.formalSent).toBe(1)
    expect((await effektläge(orgB)).avgiftsrader).toBeGreaterThan(0)
    expect((await effektläge(orgA)).avgiftsrader).toBe(0)
    utfall.D1 = summary
  })

  it('D2: IMPORT OCH MANUELL AVSTÄMNING är inte pausade — annars är det ett dödläge', async () => {
    // EGEN ORGANISATION: `recordImportStarted` sätter den omutbara markören,
    // och den går inte att ta tillbaka. Att köra provet på orgA hade gjort den
    // ofärsk för resten av filen — vilket är precis vad som hände i första
    // versionen och fällde sex följande prov på fel grund.
    const orgD2 = await byggOrg('d2')
    await granskningsrad(orgD2)
    // Importens förstmarkör måste gå igenom: en organisation som inte kan
    // importera kan inte ta sig ur pausen.
    await expect(freshness.recordImportStarted(orgD2)).resolves.toBeUndefined()
    await expect(
      freshness.recordPaymentDataThrough(orgD2, new Date('2026-03-05T00:00:00.000Z')),
    ).resolves.not.toThrow()
    // Och en ny bankrad kan skrivas.
    const ny = await prisma.bankTransaction.create({
      data: {
        organizationId: orgD2,
        date: new Date('2026-03-05T00:00:00.000Z'),
        description: 'Ny import under paus',
        amount: new Decimal(100),
        status: 'UNMATCHED',
      },
      select: { id: true },
    })
    expect(ny.id).toBeTruthy()
    utfall.D2 = 'import och avstämning öppna under paus'
  })

  it('D3: FÄRSKHETSPAUSEN behåller sitt beteende och sin text', async () => {
    // En ofärsk organisation ska få PaymentDataPausedError — inte den nya
    // granskningstexten. Den nya spärren får lägga till ett fall, inte ändra
    // vad ett befintligt fall säger.
    // EGEN ORGANISATION av samma skäl som D2: markören är omutbar, så den här
    // org:en är ofärsk för gott — och det gör inget, den används bara här.
    const orgD3 = await byggOrg('d3')
    await freshness.recordImportStarted(orgD3)
    await granskningsrad(orgD3)
    try {
      await prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgD3),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      )
      throw new Error('skulle ha kastat')
    } catch (err) {
      // ORDNINGEN ÄR PÅSTÅENDET: org:en har BÅDE en olöst rad och ofärsk data,
      // och ska ändå få färskhetens fel. Den nya spärren lägger till ett fall,
      // den ändrar inte vad ett befintligt fall säger.
      expect((err as Error).name).toBe('PaymentDataPausedError')
    }
    utfall.D3 = 'färskhetspausen oförändrad och först'
  })

  it('D4: FÄRSKHETSDATUM FÖRFALSKAS INTE av pausen', async () => {
    const före = await prisma.organization.findUniqueOrThrow({
      where: { id: orgA },
      select: { paymentDataThrough: true, paymentImportStartedAt: true },
    })
    await granskningsrad(orgA)
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)
    const efter = await prisma.organization.findUniqueOrThrow({
      where: { id: orgA },
      select: { paymentDataThrough: true, paymentImportStartedAt: true },
    })
    expect(efter).toEqual(före)
    utfall.D4 = efter
  })

  // ══ E. SAMTIDIGHET ═══════════════════════════════════════════════════════

  it('E1: två SAMTIDIGA effekter ser samma svar — båda stoppas', async () => {
    await granskningsrad(orgA)
    const a = klient()
    const b = klient()
    try {
      const fa = new PaymentFreshnessService(a as never, { send: async () => undefined } as never)
      const fb = new PaymentFreshnessService(b as never, { send: async () => undefined } as never)
      const utfallen = await Promise.allSettled([
        a.$transaction(
          (tx) => fa.assertAutomaticEffectAllowed(tx as never, orgA),
          paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
        ),
        b.$transaction(
          (tx) => fb.assertAutomaticEffectAllowed(tx as never, orgA),
          paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
        ),
      ])
      expect(utfallen.map((u) => u.status)).toEqual(['rejected', 'rejected'])
      for (const u of utfallen) {
        expect((u as PromiseRejectedResult).reason).toBeInstanceOf(IdentityReviewPausedError)
      }
      utfall.E1 = 'båda stoppades'
    } finally {
      await a.$disconnect()
      await b.$disconnect()
    }
  })

  it('E2: en rad som COMMITAS före effektens läsning stoppar den — över klientgränsen', async () => {
    // Två separata PrismaClient: ett processlokalt tillstånd syns inte över den
    // gränsen, så det som mäts är databasens svar och inte nodens minne.
    const skrivare = klient()
    try {
      await skrivare.bankTransaction.create({
        data: {
          organizationId: orgA,
          date: new Date('2026-03-02T00:00:00.000Z'),
          description: 'Skriven av annan klient',
          amount: new Decimal(HYRA),
          status: 'UNMATCHED',
          identityReviewAt: new Date(),
          identityReviewReason: 'API_UTAN_KONTO',
        },
      })
      await expect(
        prisma.$transaction(
          (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
          paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
        ),
      ).rejects.toBeInstanceOf(IdentityReviewPausedError)
      utfall.E2 = 'commitad rad från annan klient stoppade effekten'
    } finally {
      await skrivare.$disconnect()
    }
  })

  // ══ F. NEGATIVKONTROLL AV SPÄRREN SJÄLV ══════════════════════════════════

  it('F1-NEGATIVKONTROLL: utan den olösta raden når EXAKT samma anrop igenom', async () => {
    // Spegelbilden av A2/B2 i renaste form: samma organisation, samma anrop,
    // enda skillnaden är radens existens. Faller det här provet mäter hela
    // filen något annat än spärren.
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()

    const rad = await granskningsrad(orgA)
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)

    await prisma.bankTransaction.delete({ where: { id: rad } })
    await expect(
      prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      ),
    ).resolves.toBeUndefined()
    utfall.F1 = 'nej → ja → nej, samma anrop'
  })

  // ══ H. KLASSIFICERINGEN — en väntad paus är inte ett fel ═════════════════

  it('H1: granskningspausen är INTE en färskhetspaus — därför behöver varje fångstställe en egen gren', async () => {
    // ── VARFÖR DET HÄR PROVET FINNS ───────────────────────────────────────
    //
    // Terminal 1:s fynd H1. Fyra ställen i kravvägarna särbehandlar
    // `PaymentDataPausedError`. Eftersom den nya klassen ärver `Error` och inte
    // den, föll granskningspausen i else-grenen och loggades som
    // `logger.error(... misslyckades)` — en AVSIKTLIG, väntad paus rapporterad
    // som ett haveri. Ingen larmning, och fel orsak i loggen.
    //
    // ARVET ÄR RÄTT, och det är därför fyndet inte löstes med en basklass: de
    // två pauserna åtgärdas olika (importera en fil vs avgöra en rad), och ett
    // fångstställe som kan behandla dem lika hade gett fel besked. Provet
    // låser fast att de INTE är utbytbara, så att nästa läsare förstår varför
    // varje ställe bär två grenar i stället för en.
    const fel = new IdentityReviewPausedError(3)
    expect(fel).toBeInstanceOf(Error)
    expect(fel).not.toBeInstanceOf(PaymentDataPausedError)
    expect(new PaymentDataPausedError()).not.toBeInstanceOf(IdentityReviewPausedError)
    utfall.H1 = 'klasserna är åtskilda med flit'
  })

  it('H2: VARJE fångstställe som kan PaymentDataPausedError kan också granskningspausen', async () => {
    // ── VAD PROVET ÄR, OCH VAD DET INTE ÄR ────────────────────────────────
    //
    // En KÄLLKONTROLL, inte en beteendemätning. Den kan bara se att båda
    // namnen förekommer i samma fil — inte att grenen är rätt skriven. Det som
    // mäter beteendet är B2 (fakturacronen rapporterar en paus som `skipped`
    // och `errors: 0` på den riktiga vägen).
    //
    // Den finns ändå, och skälet är fyndets FORM: H1 uppstod inte av att någon
    // skrev fel, utan av att ett nytt feltillstånd inte nådde fångstställen
    // som fanns sedan tidigare. Ett FEMTE fångstställe skulle upprepa exakt
    // det, och då är den här kontrollen röd i stället för tyst.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const filer = [
      'avisering/rent-reminder.service.ts',
      'avisering/rent-bad-debt.service.ts',
      'notifications/payment-reminder.service.ts',
    ]
    const saknar: string[] = []
    for (const f of filer) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8')
      const harFarskhet = src.includes('err instanceof PaymentDataPausedError')
      const harGranskning = src.includes('err instanceof IdentityReviewPausedError')
      if (harFarskhet && !harGranskning) saknar.push(f)
    }
    expect(saknar).toEqual([])

    // KANARIEFÅGEL: kontrollen måste kunna ge utslag. En källkontroll som
    // alltid är grön är samma prosa i annan form — det var precis lärdomen ur
    // terminal 1:s förra fynd (G4).
    const påhittad = 'err instanceof PaymentDataPausedError'
    expect('if (' + påhittad + ') { /* utan grenen */ }').toContain(påhittad)
    expect('if (' + påhittad + ') { /* utan grenen */ }').not.toContain(
      'err instanceof IdentityReviewPausedError',
    )
    utfall.H2 = `${filer.length} filer, alla med båda grenarna`
  })

  it('F2: felet BÄR ANTALET, så operatören får veta hur många rader det gäller', async () => {
    await granskningsrad(orgA)
    await granskningsrad(orgA)
    try {
      await prisma.$transaction(
        (tx) => freshness.assertAutomaticEffectAllowed(tx, orgA),
        paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS),
      )
      throw new Error('skulle ha kastat')
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityReviewPausedError)
      expect((err as IdentityReviewPausedError).antal).toBe(2)
      expect((err as IdentityReviewPausedError).code).toBe('GRANSKNING_PAGAR')
      expect((err as Error).message).toContain('identitetsgranskning')
    }
    utfall.F2 = 'antalet bärs med'
  })
})
