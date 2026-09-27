/**
 * G2-AVSLUT — LUCKAN MELLAN KONTROLL OCH EFFEKT. Mätt, inte resonerad.
 *
 * ── VAD BYGGLEDAREN LÄSTE UT UR KODEN ───────────────────────────────────────
 *
 * `assertIngenOlostIdentitetsgranskning` tar ett DELAT organisationslås och
 * räknar. Granskningsraden skapas av ett bart
 * `this.prisma.bankTransaction.create` — ingen transaktion, inget lås.
 * `unmatchTransaction` återöppnar i en egen transaktion, också utan
 * färskhetslåset.
 *
 * Kontrollerat av mig innan jag byggde riggen: inga `$extends`/`$use` i
 * `apps/api/src`, och ingen av de sju triggrarna i migrationerna rör
 * `BankTransaction`. Det finns alltså INGEN gemensam ordning mellan de två
 * sidorna — varken lås, trigger eller extension.
 *
 * ── MIN EGEN KOMMENTAR SOM VAR OBELAGD ──────────────────────────────────────
 *
 * Vid `payment-freshness.service.ts` stod att en rad som commitas efteråt inte
 * stoppar effekten, "och ska inte göra det — effekten inträffade före raden".
 *
 * Det följer inte av någonting. Räkningen sker vid T1, effektens commit vid
 * T2 > T1. En rad som commitas mellan dem är i väggklockstid FÖRE att effekten
 * fanns. Med delat lås på ena sidan och inget lås på den andra är ordningen
 * odefinierad, och då är slutsatsen en förhoppning.
 *
 * ── VARFÖR BARRIÄR OCH INTE TIMING ──────────────────────────────────────────
 *
 * `Promise.all` eller en `sleep` mäter schemaläggaren. Riggen TVINGAR fönstret:
 * effektens färskhetstjänst är instrumenterad så att spärren körs OFÖRÄNDRAD
 * och transaktionen sedan HÅLLS ÖPPEN vid en namngiven punkt tills importen
 * commitat. Produktkoden är orörd — bara klockan är vår.
 *
 * Barriären har egen tidsgräns och KASTAR om överlappet uteblir. Ett uteblivet
 * överlapp får aldrig se ut som ett grönt prov.
 *
 * ── VAD SOM MÄTS ────────────────────────────────────────────────────────────
 *
 * Bokförda avgifter, verifikat, kravsteg och FAKTISKA ANROP TILL KÖGRÄNSEN —
 * inte sammanfattningsräknare. En räknare kan stå still medan ett brev går.
 *
 * Vägarna är de verkliga: `importBankStatement` skapar granskningsraden,
 * `escalateNoticeToReminded` är kraveffekten, `processOverdueReminders` är
 * fakturacronen. Påhittade direkta writes bevisar inte hur produktvägarna
 * samordnas.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, RentNoticeType } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { RentReminderService } from '../avisering/rent-reminder.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { BankImportAttemptService } from '../reconciliation/bank-import-attempt.service'
import { PaymentReminderService } from '../notifications/payment-reminder.service'
import { IdentityReviewPausedError, PaymentFreshnessService } from './payment-freshness.service'

// Barriärproven håller en transaktion öppen med flit. Jests standardtak på 5 s
// dödar dem före grindens EGEN tidsgräns, och då rapporteras ett uteblivet
// överlapp som en jest-timeout i stället för som grindens tydliga kast.
jest.setTimeout(45_000)

const Decimal = Prisma.Decimal
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const POOL = 14
const HYRA = 9000
const FAKTURA = 5000

function klient(): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', String(POOL))
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

/**
 * Enpartsgrind: effekten stannar här tills provet släpper den, och provet får
 * veta när effekten NÅTT punkten. KASTAR om någondera uteblir — ett uteblivet
 * överlapp ska falla, inte tyst passera.
 */
class Grind {
  private nådd?: () => void
  private släpp?: () => void
  readonly anlände: Promise<void>
  private fortsätt: Promise<void>
  constructor(private readonly timeoutMs = 10_000) {
    this.anlände = new Promise<void>((r) => (this.nådd = r))
    this.fortsätt = new Promise<void>((r) => (this.släpp = r))
  }
  /** Anropas av effekten. Returnerar först när provet släppt. */
  async stanna(): Promise<void> {
    this.nådd?.()
    let klocka: NodeJS.Timeout | undefined
    const tidsgräns = new Promise<never>((_, rej) => {
      klocka = setTimeout(
        () => rej(new Error('GRINDEN SLÄPPTES ALDRIG — överlappet uteblev')),
        this.timeoutMs,
      )
    })
    try {
      await Promise.race([this.fortsätt, tidsgräns])
    } finally {
      if (klocka) clearTimeout(klocka)
    }
  }
  /** Anropas av provet. */
  öppna(): void {
    this.släpp?.()
  }
  /** Väntar på att effekten nått grinden; kastar om den aldrig kommer. */
  async väntaPåAnkomst(): Promise<void> {
    let klocka: NodeJS.Timeout | undefined
    const tidsgräns = new Promise<never>((_, rej) => {
      klocka = setTimeout(
        () => rej(new Error('EFFEKTEN NÅDDE ALDRIG GRINDEN — riggen mäter inget')),
        this.timeoutMs,
      )
    })
    try {
      await Promise.race([this.anlände, tidsgräns])
    } finally {
      if (klocka) clearTimeout(klocka)
    }
  }
}

const HUVUD = 'Datum,Text,Belopp,Referens'
const DATUM = '2026-03-02'
const TEXT = 'Insattning utan avgjord identitet'
function csv(ocr: string): Buffer {
  return Buffer.from([HUVUD, `${DATUM},${TEXT},${HYRA}.00,${ocr}`].join('\n'), 'utf8')
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('G2-AVSLUT — ny paus mellan kontroll och effekt', () => {
  let a: PrismaClient // effektsidan
  let b: PrismaClient // importsidan — egen klient = egen appinstans
  let orgId: string
  let tenantId: string
  let unitId: string
  let leaseId: string
  let kontoId: string
  let userId: string
  let räknare = 0
  const utfall: Record<string, unknown> = {}

  // Mätpunkt: FAKTISKA anrop till kögränsen, inte räknare.
  let köade: Array<{ mall: string; till: string }> = []

  beforeAll(async () => {
    a = klient()
    b = klient()
    const sfx = randomUUID().slice(0, 8)
    const org = await a.organization.create({
      data: {
        name: `g2s-${sfx}`,
        email: `g2s-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5564${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
        remindersEnabled: true,
        // F8 — en påminnelse kräver ett giltigt betalningsmål (t2-fakturakontrakt).
        bankgiro: '5050-1055',
        // ── FÄRSKHETSPAUSEN SKA ALDRIG VARA DET SOM FÄLLER ──────────────
        //
        // `importBankStatement` sätter den OMUTBARA `paymentImportStartedAt`
        // och registrerar därefter filens datum (2026-03-02) som täckning.
        // Mot dagens datum är det urgammalt, så organisationen blev OFÄRSK av
        // riggens egen import — och varje följande prov fick
        // `PaymentDataPausedError` i stället för granskningspausen. Uppmätt
        // innan den här raden fanns: S4 föll med fel felklass.
        //
        // Ett högt tröskelvärde gör organisationen färskhetsimmun, så varje
        // paus filen mäter bevisligen kommer från granskningen. Att i stället
        // nollställa markören går inte — den är omutbar i databasen, och
        // riggen ska ge vika för driftspärren.
        paymentDataStaleDays: 36500,
      },
      select: { id: true },
    })
    orgId = org.id
    await a.account.createMany({
      data: [
        { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkter', type: 'REVENUE' },
        { organizationId: orgId, number: 3593, name: 'Påminnelseavgifter', type: 'REVENUE' },
        { organizationId: orgId, number: 8131, name: 'Dröjsmålsränta', type: 'REVENUE' },
      ],
    })
    const prop = await a.property.create({
      data: {
        organizationId: orgId,
        name: `p-${sfx}`,
        propertyDesignation: `G2S ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await a.unit.create({
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
    unitId = unit.id
    const tenant = await a.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'S',
        lastName: 'Ett',
        email: `t-${sfx}@example.se`,
      },
      select: { id: true },
    })
    tenantId = tenant.id
    const lease = await a.lease.create({
      data: {
        organizationId: orgId,
        unitId,
        tenantId,
        contractNumber: `HK-${sfx}`,
        monthlyRent: HYRA,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
        reminderFeeTermsFrom: new Date('2025-01-01'),
      },
      select: { id: true },
    })
    leaseId = lease.id
    // `manualMatch`/`unmatchTransaction` skriver `matchedBy` mot User (FK).
    userId = (
      await a.user.create({
        data: {
          organizationId: orgId,
          email: `u-${sfx}@example.se`,
          passwordHash: 'x',
          firstName: 'S',
          lastName: 'Rigg',
          role: 'OWNER',
        },
        select: { id: true },
      })
    ).id
    kontoId = (
      await a.bankAccount.create({
        data: { organizationId: orgId, name: 'Foretagskonto' },
        select: { id: true },
      })
    ).id
  })

  afterEach(async () => {
    köade = []
    for (const p of [a]) {
      await p.paymentReminder.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await p.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
      await p.invoice.deleteMany({ where: { organizationId: orgId } })
      await p.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
      await p.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: orgId } } })
      await p.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: orgId } } })
      await p.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await p.notification.deleteMany({ where: { organizationId: orgId } })
      await p.bankIdentityReviewPause.deleteMany({ where: { organizationId: orgId } })
      await p.bankImportAttempt.deleteMany({ where: { organizationId: orgId } })
      await p.bankTransaction.deleteMany({ where: { organizationId: orgId } })
      await p.rentNotice.deleteMany({ where: { organizationId: orgId } })
    }
  })

  afterAll(async () => {
    await a.bankAccount.deleteMany({ where: { organizationId: orgId } })
    await a.user.deleteMany({ where: { organizationId: orgId } })
    await a.lease.deleteMany({ where: { organizationId: orgId } })
    await a.tenant.deleteMany({ where: { organizationId: orgId } })
    await a.unit.deleteMany({ where: { property: { organizationId: orgId } } })
    await a.property.deleteMany({ where: { organizationId: orgId } })
    await a.account.deleteMany({ where: { organizationId: orgId } })
    await a.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await a.rentNoticeNumberSequence.deleteMany({ where: { organizationId: orgId } })
    await a.tenantOcrSequence.deleteMany({ where: { organizationId: orgId } })
    await a.organization.deleteMany({ where: { id: orgId } })
    console.warn(`[G2-samtidighet] utfall: ${JSON.stringify(utfall, null, 1)}`)
    await a.$disconnect()
    await b.$disconnect()
  })

  // ── Tjänsterna. Effektsidan på klient A, importsidan på klient B. ─────────

  function färskhet(p: PrismaClient): PaymentFreshnessService {
    return new PaymentFreshnessService(p as never, { send: async () => undefined } as never)
  }

  function avstämning(p: PrismaClient, f: PaymentFreshnessService): ReconciliationService {
    const acc = new AccountingService(p as never, new VerifikationsnummerService(p as never))
    const s = Object.create(ReconciliationService.prototype) as ReconciliationService
    Object.assign(s, {
      prisma: p,
      accounting: acc,
      rentNoticeEvents: new RentNoticeEventsService(p as never),
      invoices: {},
      events: {},
      freshness: f,
      betalningsSkugga: { enqueue: async () => 'jobb' },
      betalningsFacit: {
        skrivFacitMatchad: async () => undefined,
        skrivFacitIngen: async () => undefined,
        nollstallFacit: async () => undefined,
      },
      attempts: new BankImportAttemptService(p as never),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    return s
  }

  function hyresPåminnelse(p: PrismaClient, f: PaymentFreshnessService): RentReminderService {
    const acc = new AccountingService(p as never, new VerifikationsnummerService(p as never))
    const s = Object.create(RentReminderService.prototype) as RentReminderService
    Object.assign(s, {
      prisma: p,
      accounting: acc,
      rentNoticeEvents: new RentNoticeEventsService(p as never),
      rentInterest: {},
      pdfQueue: {},
      mailService: {},
      pdfService: {},
      storage: {},
      rentDebt: {},
      freshness: f,
      cronErrors: { record: async () => undefined },
      notifications: { createForAllOrgUsers: async () => undefined },
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    return s
  }

  function fakturaPåminnelse(p: PrismaClient, f: PaymentFreshnessService): PaymentReminderService {
    const acc = new AccountingService(p as never, new VerifikationsnummerService(p as never))
    const s = Object.create(PaymentReminderService.prototype) as PaymentReminderService
    Object.assign(s, {
      prisma: p,
      // KÖGRÄNSEN. Varje anrop registreras — det är den mätpunkt som avgör om
      // ett brev faktiskt lämnade tjänsten, till skillnad från en räknare.
      mail: {
        sendReminderFriendly: async (o: { to: string }) => {
          köade.push({ mall: 'friendly', till: o.to })
          return 'job-friendly'
        },
        sendReminderFormal: async (o: { to: string }) => {
          köade.push({ mall: 'formal', till: o.to })
          return 'job-formal'
        },
      },
      notifications: { createForAllOrgUsers: async () => undefined, create: async () => undefined },
      accounting: acc,
      cronErrors: { record: async () => undefined },
      freshness: f,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
    return s
  }

  /**
   * Instrumenterar IMPORTEN: stannar precis innan raden skrivs.
   *
   * ── VARFÖR DEN HÄR GRINDEN BEHÖVS, OCH VAD DEN AVSLÖJADE ──────────────
   *
   * Första riggen stannade bara effekten och lät importen starta under tiden.
   * Den mätte då ingen kapplöpning utan en LÅSKÖ: `recordImportStarted` tar det
   * EXKLUSIVA `payment-freshness`-låset, och effekten satt på det delade, så
   * importen blockerade på sitt allra första steg tills transaktionen timade ut
   * efter 5 s.
   *
   * Det är i sig ett fynd värt att skriva ut: medan en effekt kör kan en import
   * inte ens BÖRJA. Men det är inte skyddet — `recordImportStarted` släpper
   * låset i sin egen tidigare transaktion, och RADEN skrivs långt senare utan
   * något lås alls. Fönstret ligger där, och för att nå det måste importen
   * hållas mellan startmarkören och skrivningen.
   */
  function medGrindFöreRadskrivning(s: ReconciliationService, grind: Grind): ReconciliationService {
    const äkta = s.ingestFromFile.bind(s)
    ;(s as unknown as Record<string, unknown>).ingestFromFile = async (
      org: string,
      input: never,
    ) => {
      await grind.stanna()
      return äkta(org, input)
    }
    return s
  }

  /**
   * Instrumenterar färskhetstjänsten: spärren körs OFÖRÄNDRAD, och därefter
   * hålls effektens transaktion öppen vid grinden. Det är enda sättet att göra
   * fönstret deterministiskt utan att röra produktkoden.
   */
  function medGrind(f: PaymentFreshnessService, grind: Grind): PaymentFreshnessService {
    const äkta = f.assertAutomaticEffectAllowed.bind(f)
    ;(f as unknown as Record<string, unknown>).assertAutomaticEffectAllowed = async (
      tx: unknown,
      org: string,
      now?: Date,
    ) => {
      await äkta(tx as never, org, now)
      await grind.stanna()
    }
    return f
  }

  function medGrindEfterGranskningsspärr(
    f: PaymentFreshnessService,
    grind: Grind,
  ): PaymentFreshnessService {
    const äkta = f.assertIngenOlostIdentitetsgranskning.bind(f)
    ;(f as unknown as Record<string, unknown>).assertIngenOlostIdentitetsgranskning = async (
      tx: unknown,
      org: string,
    ) => {
      await äkta(tx as never, org)
      await grind.stanna()
    }
    return f
  }

  // ── Fixturer ──────────────────────────────────────────────────────────────

  function nyttOcr(): string {
    const bas = `9${String(++räknare).padStart(8, '0')}`
    let summa = 0
    let dubbla = true
    for (let i = bas.length - 1; i >= 0; i--) {
      let d = Number(bas[i])
      if (dubbla) {
        d *= 2
        if (d > 9) d -= 9
      }
      summa += d
      dubbla = !dubbla
    }
    return `${bas}${(10 - (summa % 10)) % 10}`
  }

  async function förfallenAvi(): Promise<string> {
    const nr = ++räknare
    const månad = ((nr - 1) % 12) + 1
    const n = await a.rentNotice.create({
      data: {
        organizationId: orgId,
        tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 8)}`,
        ocrNumber: `${Date.now()}${nr}`.slice(-12),
        month: månad,
        year: 2026,
        amount: HYRA,
        totalAmount: HYRA,
        // Periodräknaren garanterar unik avi, inte att dess månad redan passerat.
        // Kraveffekten måste prövas med en faktiskt förfallen avi (även i S3).
        dueDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        status: 'OVERDUE',
        collectionStage: 'NONE',
        periodStart: new Date(Date.UTC(2026, månad - 1, 1)),
        type: RentNoticeType.RENT,
      },
      select: { id: true, noticeNumber: true },
    })
    const acc = new AccountingService(a as never, new VerifikationsnummerService(a as never))
    await acc.createJournalEntryForRentNotice(
      {
        id: n.id,
        noticeNumber: n.noticeNumber,
        amount: HYRA,
        vatAmount: 0,
        totalAmount: HYRA,
        year: 2026,
        month: månad,
        unitId,
      } as never,
      orgId,
      null,
    )
    return n.id
  }

  async function förfallenFaktura(dagar: number): Promise<string> {
    const due = new Date(Date.now() - dagar * 24 * 60 * 60 * 1000)
    return (
      await a.invoice.create({
        data: {
          organizationId: orgId,
          invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
          type: 'RENT',
          status: 'OVERDUE',
          tenantId,
          leaseId,
          subtotal: FAKTURA,
          vatTotal: 0,
          total: FAKTURA,
          issueDate: due,
          dueDate: due,
          remindersPaused: false,
        },
        select: { id: true },
      })
    ).id
  }

  /** Kontolös historik, så att importen av `csv(ocr)` ger en GRANSKNINGSRAD. */
  async function kontolösHistorik(ocr: string): Promise<void> {
    await a.bankTransaction.create({
      data: {
        organizationId: orgId,
        bankAccountId: null,
        date: new Date(`${DATUM}T00:00:00.000Z`),
        description: TEXT,
        amount: new Decimal(HYRA),
        reference: ocr,
        rawOcr: ocr,
        status: 'IGNORED',
      },
    })
  }

  async function effektläge() {
    const [verifikat, avgiftsrader, avier] = await Promise.all([
      a.journalEntry.count({ where: { organizationId: orgId } }),
      a.journalEntryLine.count({
        where: { journalEntry: { organizationId: orgId }, account: { number: 3593 } },
      }),
      a.rentNotice.findMany({
        where: { organizationId: orgId },
        select: { collectionStage: true, reminderFeeAmount: true },
      }),
    ])
    return { verifikat, avgiftsrader, avier }
  }

  const olösta = () =>
    a.bankTransaction.count({
      where: { organizationId: orgId, identityReviewAt: { not: null }, status: 'UNMATCHED' },
    })

  /**
   * UPPVÄRMNING — och ett SKYDD som är värt att skriva ut.
   *
   * Första körningen av S1 föll med `PaymentDataPausedError`, inte med den
   * lucka jag letade efter. Orsaken är produktens egen regel, inte riggens:
   * `recordImportStarted` sätter markören redan när importen BÖRJAR, medan
   * `paymentDataThrough` skrivs först när den är KLAR. Mellan dem gäller
   * `stale = paymentImportStartedAt !== null`, alltså fail-closed.
   *
   * Under en organisations ALLRA FÖRSTA import är hyresavins kravväg därför
   * redan stoppad, och samtidighetsluckan kan inte nås. Det är ett riktigt
   * skydd och det ska redovisas som ett.
   *
   * Men det skyddar bara den första gången. Så fort en täckning finns är
   * organisationen färsk igen. Uppvärmningen flyttar riggen till det normala
   * driftläget.
   */
  async function uppvärmdImport(): Promise<void> {
    const ocr = nyttOcr()
    const r = await avstämning(b, färskhet(b)).importBankStatement(
      csv(ocr),
      'uppvarmning.csv',
      orgId,
      kontoId,
    )
    expect(r.behoverGranskas).toBe(0) // ingen kontolös historik → vanlig rad
    await a.bankTransaction.deleteMany({ where: { organizationId: orgId } })
    await a.bankImportAttempt.deleteMany({ where: { organizationId: orgId } })
    const org = await a.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { paymentDataThrough: true },
    })
    expect(org.paymentDataThrough).not.toBeNull() // organisationen är nu FÄRSK
  }

  // ══ S1: HYRESAVIN — skrivaren BLOCKERAR på effekten ══════════════════════

  it('S1: en import kan inte commita en granskningsrad medan en effekt är öppen', async () => {
    // ── VAD PROVET MÄTTE FÖRE RÄTTELSEN, OCH VAD DET MÄTER NU ────────────
    //
    // Före: importen commitade sin granskningsrad MELLAN spärren och effektens
    // commit, och avgiften bokfördes ändå. Domen blev 'LUCKA'.
    //
    // Efter: det scenariot är OMÖJLIGT ATT KONSTRUERA. Skrivsidan tar det
    // exklusiva låset, effekten håller det delade, så importen kan inte
    // commita förrän effektens transaktion är slut. Det är hela rättelsen —
    // och därför bytte provet fråga, från "vad blev utfallet?" till "vem
    // väntar på vem?".
    //
    // Att mäta det gamla scenariot igen hade bara gett en transaktions-timeout,
    // vilket är en mätning av Prismas klocka och inte av skyddet.
    await uppvärmdImport()
    const noticeId = await förfallenAvi()
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)

    const grindImport = new Grind()
    const grindEffekt = new Grind()
    const kravet = hyresPåminnelse(a, medGrind(färskhet(a), grindEffekt))
    const importen = medGrindFöreRadskrivning(avstämning(b, färskhet(b)), grindImport)

    const imp = importen.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoId)
    await grindImport.väntaPåAnkomst()

    const effekt = kravet.escalateNoticeToReminded(noticeId, orgId, 20, 60)
    await grindEffekt.väntaPåAnkomst()
    expect(await olösta()).toBe(0)

    // Importen släpps. Den NÅR sin radskrivning men kan inte ta låset.
    grindImport.öppna()
    let importKlar = false
    void imp.then(() => (importKlar = true))
    await new Promise((r) => setTimeout(r, 400))

    // DEN BÄRANDE MÄTNINGEN: raden finns inte, och importen väntar. Före
    // rättelsen hade raden varit commitad här.
    expect(await olösta()).toBe(0)
    expect(importKlar).toBe(false)

    // Effekten släpps och fullbordar — kravet var taget i anspråk FÖRE pausen,
    // och då ska det få gå igenom. Det är kontraktets andra halva.
    grindEffekt.öppna()
    const flippad = await effekt
    expect(flippad).toBe(true)
    const läge = await effektläge()
    expect(läge.avgiftsrader).toBeGreaterThan(0)

    // Först NU kan importen commita sin rad.
    const r = await imp
    expect(r.behoverGranskas).toBe(1)
    expect(await olösta()).toBe(1)

    // Och nästa effekt är pausad. Ordningen är total: inget hamnade emellan.
    const nästaAvi = await förfallenAvi()
    await expect(
      hyresPåminnelse(a, färskhet(a)).escalateNoticeToReminded(nästaAvi, orgId, 20, 60),
    ).rejects.toBeInstanceOf(IdentityReviewPausedError)

    utfall.S1 = { importVäntade: true, kravetVann: true, nästaPausad: true }
  })

  // ══ S2: FAKTURANS VÄNLIGA PÅMINNELSE — BÅDA ORDNINGARNA ══════════════════

  it('S2a: PAUSEN FÖRST — inget brev når kögränsen, och inget anspråk blir kvar', async () => {
    // Deterministiskt utan barriär: granskningsraden är commitad INNAN cronen
    // startar. Den ena av de två ordningarna, mätt vid KÖGRÄNSEN och inte på
    // en räknare.
    await uppvärmdImport()
    await förfallenFaktura(3)
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)
    await avstämning(b, färskhet(b)).importBankStatement(csv(ocr), 'ett.csv', orgId, kontoId)
    expect(await olösta()).toBe(1)

    const summary = await fakturaPåminnelse(a, färskhet(a)).processOverdueReminders()

    expect(köade).toEqual([])
    expect(summary?.friendlySent).toBe(0)
    expect(summary?.errors).toBe(0) // en paus är inte ett fel
    // INGET ANSPRÅK LIGGER KVAR. Hade markören skrivits före spärren vore
    // fakturan "redan påmind" utan att något brev gått, och en senare giltig
    // påminnelse hade uteblivit för alltid.
    expect(await a.paymentReminder.count({ where: { invoice: { organizationId: orgId } } })).toBe(0)
    utfall.S2a = { köade: köade.length, summary }
  })

  it('S2b: PÅMINNELSEN FÖRST — importen väntar, brevet går, anspråket är varaktigt', async () => {
    // ── VARFÖR PROVET BYTTE FORM ─────────────────────────────────────────
    //
    // Förut höll det cronen vid grinden och lät importen commita emellan. Det
    // går inte längre: anspråket tas i spärrens transaktion, som håller det
    // delade låset, och importens radskrivning tar det exklusiva. Den gamla
    // riggen mätte därför Prismas transaktionsklocka (5 s) och inte skyddet —
    // provet var grönt för att transaktionen DOG, inte för att pausen vann.
    //
    // Nu mäts ordningen: vem väntar på vem, och vad blev varaktigt.
    await uppvärmdImport()
    await förfallenFaktura(3)
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)

    const grindImport = new Grind()
    const grindCron = new Grind()
    const cron = fakturaPåminnelse(a, medGrindEfterGranskningsspärr(färskhet(a), grindCron))
    const importen = medGrindFöreRadskrivning(avstämning(b, färskhet(b)), grindImport)

    const imp = importen.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoId)
    await grindImport.väntaPåAnkomst()

    const körning = cron.processOverdueReminders()
    await grindCron.väntaPåAnkomst()
    expect(await olösta()).toBe(0)

    // Importen släpps men kan inte ta låset så länge anspråkets transaktion lever.
    grindImport.öppna()
    let importKlar = false
    void imp.then(() => (importKlar = true))
    await new Promise((r) => setTimeout(r, 400))
    expect(await olösta()).toBe(0)
    expect(importKlar).toBe(false)

    // Cronen släpps: anspråket commitar och brevet KÖAS efter commit.
    grindCron.öppna()
    const summary = await körning
    expect(summary?.friendlySent).toBe(1)
    expect(köade).toHaveLength(1)
    // ANSPRÅKET ÄR VARAKTIGT — det är det som gör brevet legitimt.
    expect(
      await a.paymentReminder.count({
        where: { invoice: { organizationId: orgId }, type: 'REMINDER_FRIENDLY' },
      }),
    ).toBe(1)

    // Och först nu blir raden olöst.
    expect((await imp).behoverGranskas).toBe(1)
    expect(await olösta()).toBe(1)
    utfall.S2b = { köade: köade.length, importVäntade: true }
  })

  // ══ S3: AVMATCHNING — samma ordning, andra ingången ══════════════════════

  it('S3: en avmatchning kan inte återöppna granskning medan en effekt är öppen', async () => {
    // Den ANDRA vägen som gör en rad olöst. Hade den glömts vore rättelsen
    // halv — definitionen gör `unmatchTransaction` till en återöppning.
    await uppvärmdImport()
    const noticeId = await förfallenAvi()
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)
    const importen = avstämning(b, färskhet(b))
    await importen.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoId)
    const rad = await a.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, bankAccountId: kontoId },
      select: { id: true },
    })
    await avstämning(a, färskhet(a)).manualMatch(rad.id, { rentNoticeId: noticeId }, orgId, userId)
    expect(await olösta()).toBe(0)

    const kravavi = await förfallenAvi()
    const grind = new Grind()
    const kravet = hyresPåminnelse(a, medGrind(färskhet(a), grind))
    const effekt = kravet.escalateNoticeToReminded(kravavi, orgId, 20, 60)
    await grind.väntaPåAnkomst()

    // `unmatchTransaction` tar numera det exklusiva låset FÖRST, före sina
    // `FOR UPDATE`, så den blockerar på effektens delade lås.
    let avmatchad = false
    const avmatchning = avstämning(b, färskhet(b))
      .unmatchTransaction(rad.id, orgId, userId, 'prov')
      .then(() => {
        avmatchad = true
      })
    await new Promise((r) => setTimeout(r, 400))

    expect(await olösta()).toBe(0)
    expect(avmatchad).toBe(false)

    grind.öppna()
    expect(await effekt).toBe(true)
    expect((await effektläge()).avgiftsrader).toBeGreaterThan(0)

    await avmatchning
    expect(await olösta()).toBe(1)
    utfall.S3 = { avmatchningVäntade: true, kravetVann: true }
  })

  it('S2-ANKARE: utan granskningsrad NÅR brevet kögränsen — mätpunkten lever', async () => {
    // ── VARFÖR DET HÄR PROVET FINNS ───────────────────────────────────────
    //
    // `köade` prövades bara med `toEqual([])`. Ingenstans visades att listan
    // KAN bli icke-tom. Stubben är hopsatt med `Object.assign` på en prototyp,
    // så byter `PaymentReminderService` namn på `sendReminderFriendly` — eller
    // går via en annan väg — fylls den aldrig, och S2 blir grön för att
    // MÄTPUNKTEN ÄR DÖD. (Terminal 1:s fynd G2.)
    //
    // S5-KONTROLL duger inte som ankare: den går via hyresavins väg och mäter
    // avgiftsrader, inte fakturavägens kögräns. Två olika mätpunkter.
    await uppvärmdImport()
    await förfallenFaktura(3)
    const cron = fakturaPåminnelse(a, färskhet(a))

    const summary = await cron.processOverdueReminders()

    expect(summary?.friendlySent).toBe(1)
    expect(köade).toHaveLength(1)
    expect(köade[0]!.mall).toBe('friendly')
    utfall['S2-ankare'] = { köade: köade.length }
  })

  // ══ S4: OMVÄND ORDNING — pausen finns FÖRE kontrollen ═════════════════════

  it('S4: finns pausen redan när spärren körs stoppas effekten — oförändrat', async () => {
    const noticeId = await förfallenAvi()
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)
    const importen = avstämning(b, färskhet(b))
    await importen.importBankStatement(csv(ocr), 'utdrag.csv', orgId, kontoId)
    expect(await olösta()).toBe(1)

    const kravet = hyresPåminnelse(a, färskhet(a))
    await expect(kravet.escalateNoticeToReminded(noticeId, orgId, 20, 60)).rejects.toBeInstanceOf(
      IdentityReviewPausedError,
    )
    const läge = await effektläge()
    expect(läge.avgiftsrader).toBe(0)
    utfall.S4 = läge
  })

  // ══ P: PAUSPERIODEN OCH AVISERINGEN ══════════════════════════════════════

  /** Alla kögränsanrop för granskningspausen, med sina idempotensnycklar. */
  function medMejlfångst(f: PaymentFreshnessService, brev: Array<Record<string, string>>) {
    Object.assign(f as unknown as Record<string, unknown>, {
      mail: {
        sendCustomEmail: async (o: Record<string, string>) => {
          brev.push(o)
          return `job-${brev.length}`
        },
      },
    })
    return f
  }

  it('P1: första olösta raden öppnar EN period, skapar notis och köar e-post', async () => {
    await uppvärmdImport()
    const brev: Array<Record<string, string>> = []
    const f = medMejlfångst(färskhet(a), brev)
    const importen = avstämning(a, f)
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)

    await importen.importBankStatement(csv(ocr), 'ett.csv', orgId, kontoId)

    const perioder = await a.bankIdentityReviewPause.findMany({ where: { organizationId: orgId } })
    expect(perioder).toHaveLength(1)
    expect(perioder[0]!.endedAt).toBeNull()
    expect(perioder[0]!.notifiedAt).not.toBeNull()
    expect(perioder[0]!.mailQueuedAt).not.toBeNull()
    expect(perioder[0]!.mailAttempts).toBe(1)

    // Notisen finns och pekar på avstämningen.
    const notiser = await a.notification.findMany({ where: { organizationId: orgId } })
    expect(notiser.length).toBeGreaterThan(0)
    expect(notiser[0]!.link).toBe('/reconciliation')
    expect(notiser[0]!.message).toContain('identitetsgranskning')

    // E-posten köades med PERIODENS id som idempotensnyckel.
    expect(brev).toHaveLength(1)
    expect(brev[0]!.idempotencyKey).toBe(`bank-review-pause:${perioder[0]!.id}:${brev[0]!.to}`)
    // DATAMINIMERING: inga radbelopp, inga OCR, inga hyresgästuppgifter.
    expect(brev[0]!.bodyHtml).not.toContain(ocr)
    expect(brev[0]!.bodyHtml).not.toContain(String(HYRA))
    utfall.P1 = { perioder: perioder.length, brev: brev.length }
  })

  it('P2: FLER rader i samma paus ger INGEN ny period och INGEN andra storm', async () => {
    await uppvärmdImport()
    const brev: Array<Record<string, string>> = []
    const importen = avstämning(a, medMejlfångst(färskhet(a), brev))
    const o1 = nyttOcr()
    const o2 = nyttOcr()
    await kontolösHistorik(o1)
    await kontolösHistorik(o2)

    const r1 = await importen.importBankStatement(csv(o1), 'ett.csv', orgId, kontoId)
    const r2 = await importen.importBankStatement(csv(o2), 'tva.csv', orgId, kontoId)
    utfall['P2-import'] = { r1, r2 }

    expect(await olösta()).toBe(2)
    expect(await a.bankIdentityReviewPause.count({ where: { organizationId: orgId } })).toBe(1)
    // ETT brev, inte två. Det är hela skillnaden mot en nattlig storm.
    expect(brev).toHaveLength(1)
    expect(await a.notification.count({ where: { organizationId: orgId } })).toBe(1)
    utfall.P2 = { brev: brev.length }
  })

  it('P3: sista lösta raden AVSLUTAR perioden — en ny olöst rad startar en NY', async () => {
    await uppvärmdImport()
    const brev: Array<Record<string, string>> = []
    const f = medMejlfångst(färskhet(a), brev)
    const importen = avstämning(a, f)
    const o1 = nyttOcr()
    await kontolösHistorik(o1)
    await importen.importBankStatement(csv(o1), 'ett.csv', orgId, kontoId)
    const rad = await a.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, identityReviewAt: { not: null } },
      select: { id: true },
    })

    await importen.ignoreTransaction(rad.id, orgId)
    expect(await olösta()).toBe(0)
    const efterLöst = await a.bankIdentityReviewPause.findFirstOrThrow({
      where: { organizationId: orgId },
    })
    expect(efterLöst.endedAt).not.toBeNull()
    // HISTORIKMARKERINGEN ÄR KVAR — perioden avslutas, spåret raderas aldrig.
    const radEfter = await a.bankTransaction.findUniqueOrThrow({ where: { id: rad.id } })
    expect(radEfter.identityReviewAt).not.toBeNull()

    // NY olöst rad → NY period och ett NYTT aviseringstillfälle.
    const o2 = nyttOcr()
    await kontolösHistorik(o2)
    await importen.importBankStatement(csv(o2), 'tva.csv', orgId, kontoId)
    expect(await a.bankIdentityReviewPause.count({ where: { organizationId: orgId } })).toBe(2)
    expect(brev).toHaveLength(2)
    utfall.P3 = { perioder: 2, brev: brev.length }
  })

  it('P4: ett KÖFEL ger ingen evig markör — återförsöket lyckas', async () => {
    await uppvärmdImport()
    const brev: Array<Record<string, string>> = []
    const f = färskhet(a)
    // Kön går sönder vid första försöket.
    let trasig = true
    Object.assign(f as unknown as Record<string, unknown>, {
      mail: {
        sendCustomEmail: async (o: Record<string, string>) => {
          if (trasig) throw new Error('kön nere')
          brev.push(o)
          return 'job-1'
        },
      },
    })
    const importen = avstämning(a, f)
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)
    await importen.importBankStatement(csv(ocr), 'ett.csv', orgId, kontoId)

    const efterFel = await a.bankIdentityReviewPause.findFirstOrThrow({
      where: { organizationId: orgId },
    })
    // NOTISEN gick igenom — den är ren databas och beror inte på kön.
    expect(efterFel.notifiedAt).not.toBeNull()
    // MEJLMARKÖREN är kvar null. Det är det som gör återförsöket möjligt.
    expect(efterFel.mailQueuedAt).toBeNull()
    expect(efterFel.mailAttempts).toBe(1)

    // Sveparen tar igen tillfället.
    trasig = false
    const svep = await f.sveparGranskningspauser()
    expect(svep.behandlade).toBeGreaterThan(0)
    const efterSvep = await a.bankIdentityReviewPause.findFirstOrThrow({
      where: { organizationId: orgId },
    })
    expect(efterSvep.mailQueuedAt).not.toBeNull()
    expect(efterSvep.mailAttempts).toBe(2)
    expect(brev).toHaveLength(1)
    // Och notisen skapades INTE en andra gång.
    expect(await a.notification.count({ where: { organizationId: orgId } })).toBe(1)
    utfall.P4 = { attempts: efterSvep.mailAttempts, brev: brev.length }
  })

  it('P5: SAMTIDIGA öppnanden ger ETT aviseringstillfälle, inte två', async () => {
    await uppvärmdImport()
    // Två klienter öppnar perioden samtidigt. Det partiella unika indexet är
    // skiljedomare — en vinner, den andra får P2002 och tolkas som "redan öppen".
    const fa = färskhet(a)
    const fb = färskhet(b)
    const utfallen = await Promise.allSettled([
      a.$transaction((tx) => fa.oppnaGranskningsperiod(tx as never, orgId)),
      b.$transaction((tx) => fb.oppnaGranskningsperiod(tx as never, orgId)),
    ])
    const idn = utfallen
      .filter((u): u is PromiseFulfilledResult<string | null> => u.status === 'fulfilled')
      .map((u) => u.value)
    expect(idn.filter((x) => x !== null)).toHaveLength(1) // exakt EN ny period
    expect(await a.bankIdentityReviewPause.count({ where: { organizationId: orgId } })).toBe(1)
    utfall.P5 = { nya: idn.filter((x) => x !== null).length }
  })

  it('P6: en LÄSNING skapar inget utskick', async () => {
    await uppvärmdImport()
    const brev: Array<Record<string, string>> = []
    const f = medMejlfångst(färskhet(a), brev)
    const importen = avstämning(a, f)
    const ocr = nyttOcr()
    await kontolösHistorik(ocr)
    await importen.importBankStatement(csv(ocr), 'ett.csv', orgId, kontoId)
    expect(brev).toHaveLength(1)

    // Operatörsvyn läses tre gånger. Inget nytt brev, ingen ny notis.
    await importen.identitetsgranskning(orgId)
    await importen.identitetsgranskning(orgId)
    await f.raknaOlostIdentitetsgranskning(orgId)
    expect(brev).toHaveLength(1)
    expect(await a.notification.count({ where: { organizationId: orgId } })).toBe(1)
    utfall.P6 = 'läsningar är sidoeffektfria'
  })

  // ══ S5: FUNGERANDE KONTROLL — utan paus når effekten hela vägen ═══════════

  it('S5-KONTROLL: utan granskningsrad bokförs avgiften och avin eskaleras', async () => {
    const noticeId = await förfallenAvi()
    const kravet = hyresPåminnelse(a, färskhet(a))
    const flippad = await kravet.escalateNoticeToReminded(noticeId, orgId, 20, 60)
    const läge = await effektläge()
    expect(flippad).toBe(true)
    expect(läge.avgiftsrader).toBeGreaterThan(0)
    expect(läge.avier[0]!.collectionStage).toBe('REMINDED')
    utfall.S5 = läge
  })
})
