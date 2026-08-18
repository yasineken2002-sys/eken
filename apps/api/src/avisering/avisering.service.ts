import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { MailService } from '../mail/mail.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { QUEUE_PDF } from '../pdf-jobs/pdf.types'
import { enqueueSafely } from '../common/queue/enqueue-safety'
import { AccountingService, vatRateForRent } from '../accounting/accounting.service'
import { ConsumptionService } from '../consumption/consumption.service'
import { MiscChargeService } from '../misc-charges/misc-charge.service'
import { DepositsService } from '../deposits/deposits.service'
import { computeRentDebt } from './rent-debt.service'
import { RentNoticeEventsService } from './rent-notice-events.service'

// Speglar REVERSAL_REASON_MIN_LENGTH i AccountingService: ett skäl som bara är
// "fel" hjälper ingen som granskar huvudboken ett år senare.
const REMINDER_FEE_REVERSAL_REASON_MIN_LENGTH = 10

/** Öresavrundning, samma form som rent-debt.service.ts använder. */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
import { rentNoticePayableTotal } from '../common/utils/rent-notice-total.util'
import { assertPaymentWithinDebt } from '../common/payments/payment-within-debt'
import { isP2002From } from '../common/prisma/p2002-constraint'
import { allocateRentNoticeNumber } from './rent-notice-number'
import {
  PaymentMethod,
  Prisma,
  RentCollectionStage,
  RentNoticeStatus,
  RentNoticeType,
  UserRole,
} from '@prisma/client'
import type { UnitType } from '@prisma/client'
import type { RentNotice } from '@prisma/client'
import {
  rentDueDateForMonth,
  rentDueDateForPeriodStart,
  calculateProratedRent,
  calculateFirstPaymentDueDate,
  DEFAULT_BRAND_COLOR,
} from '@eken/shared'
import { buildBrandedPdfHtml, escapeHtml } from '../common/branding'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
// getLogoDataUrl bor numera i common/branding (Steg 3, PR 2 — en sanning).
// Vi re-exporterar den här så att rent-reminder.service.ts (som importerar
// från denna modul) fortsätter fungera oförändrat, beteende-identiskt.
import { getLogoDataUrl } from '../common/branding/logo.util'
import { resolveActorType } from '../common/ai-origin/ai-origin.context'
export { getLogoDataUrl }

type NoticeWithRelations = Prisma.RentNoticeGetPayload<{
  include: {
    tenant: { select: typeof SAFE_TENANT_SELECT }
    lease: { include: { unit: { include: { property: true } } } }
    lines: true
  }
}>

/**
 * Den ENDA P2002 aviseringens aktiveringsväg får behandla som benign idempotens.
 *
 * `RentNotice` har två unika index:
 *   @@unique([leaseId, year, month, type])        ← periodnyckeln, benign
 *   @@unique([organizationId, noticeNumber])      ← avinumret, ALDRIG benign
 *
 * `leaseId` är särskiljande: avinummer-indexet är ["organizationId","noticeNumber"]
 * och saknar den, så ett nummer-race kan inte råka klassas som benignt.
 * Indexnamnet (sträng-grenen) är verifierat mot migrationen
 * 20260509200000_rent_notice_proration.
 */
const RENT_NOTICE_PERIOD_UNIQUE = {
  column: 'leaseId',
  indexName: 'RentNotice_leaseId_year_month_type_key',
} as const

@Injectable()
export class AviseringService {
  private readonly logger = new Logger(AviseringService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ocrService: OcrService,
    private readonly mailService: MailService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
    private readonly pdfQueue: PdfQueue,
    private readonly accounting: AccountingService,
    private readonly consumption: ConsumptionService,
    private readonly miscCharges: MiscChargeService,
    private readonly deposits: DepositsService,
    private readonly rentNoticeEvents: RentNoticeEventsService,
  ) {}

  // Beräknar moms på en hyra utifrån enhetens upplåtelsetyp och frivilliga
  // skattskyldighet (ML 2023:200). Bostad → 0 %, lokal → 25 % endast vid
  // frivillig skattskyldighet, parkering → 25 %. Öresavrundning på momsbeloppet.
  //
  // Netto-gate (JB 12 kap 19 § 3 st): moms läggs ENDAST på om hyran uttryckligen
  // är avtalad exkl. moms (lease.monthlyRentExcludingVat). Annars vet vi inte om
  // monthlyRent redan inkluderar moms, och att lägga på 25 % vore en oavtalad
  // hyreshöjning. Är enheten momspliktig men hyran inte markerad netto loggas en
  // varning så att felregistrerade kontrakt kan rättas.
  private rentVat(
    net: number,
    unit: { type: UnitType; voluntaryTaxLiability: boolean },
    lease: { monthlyRentExcludingVat: boolean },
    context?: string,
  ): { vatAmount: number; totalAmount: number } {
    const rate = vatRateForRent(unit.type, unit.voluntaryTaxLiability)
    if (rate === 0) return { vatAmount: 0, totalAmount: net }
    if (!lease.monthlyRentExcludingVat) {
      this.logger.warn(
        `[Moms] Enhet ${unit.type} är momspliktig men hyran är inte markerad som ` +
          `exkl. moms — moms läggs ej på${context ? ` (${context})` : ''}. ` +
          `Kontrollera kontraktsregistreringen.`,
      )
      return { vatAmount: 0, totalAmount: net }
    }
    const vatAmount = Math.round(net * rate) / 100
    return { vatAmount, totalAmount: net + vatAmount }
  }

  // Bokför hyresfordran (intäktsverifikation) för en skapad RENT-avi.
  // BFL kräver att intäkten verifieras när affärshändelsen inträffar — inte
  // först vid betalning. Idempotent i AccountingService; fel loggas men får
  // aldrig fälla avi-genereringen (avin är redan skapad i DB).
  private async bookRentNoticeRevenue(
    orgId: string,
    notice: {
      id: string
      noticeNumber: string
      leaseId: string
      type: RentNoticeType
      amount: Prisma.Decimal | number
      vatAmount: Prisma.Decimal | number
      totalAmount: Prisma.Decimal | number
      year: number
      month: number
    },
    // T1.4 PR0: valfri yttre transaktion. Trädd igenom till
    // createJournalEntryForRentNotice så avi + verifikat kan skapas atomiskt
    // (bakdaterad-debitering-backfillen, PR1). När tx anges får ett bokförings-
    // fel INTE sväljas här — det måste bubbla upp så den yttre transaktionen
    // rullar tillbaka avin (annars orphan-avi). Utan tx behålls det tidigare
    // best-effort-beteendet (avin är redan committad, felet loggas bara).
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (notice.type === RentNoticeType.DEPOSIT) return
    try {
      await this.accounting.createJournalEntryForRentNotice(notice, orgId, null, tx)
    } catch (err) {
      // Atomiskt läge (tx angiven): låt felet fälla den yttre transaktionen så
      // ingen avi lämnas utan verifikat.
      if (tx) throw err
      this.logger.error(
        `[Avisering] Bokföring av hyresavi ${notice.noticeNumber} misslyckades: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /**
   * Hämtar avin som en BENIGN periodkollision påstår redan finns.
   *
   * Premissen i den grenen är exakt: `@@unique(leaseId, year, month, type)` bröts,
   * alltså FINNS raden. Kommer `null` tillbaka är premissen falsk — och då är det
   * inte idempotens vi råkat ut för utan något vi inte förstår. Att returnera
   * `null` där vore att skriva tillbaka precis den tystnad den här ändringen
   * stänger: `{ firstRent: null, mailed: false }` som ser ut som en lyckad
   * aktivering.
   *
   * Därför en assertion, inte en `?? null`.
   */
  private async hämtaBefintligAvi(
    leaseId: string,
    year: number,
    month: number,
    type: RentNoticeType,
  ): Promise<RentNotice> {
    const befintlig = (await this.prisma.rentNotice.findFirst({
      where: { leaseId, year, month, type },
    })) as unknown as RentNotice | null

    if (!befintlig) {
      throw new InternalServerErrorException(
        `Avisering: unikhetsbrottet på (leaseId, år, månad, typ) sa att avin redan fanns för ` +
          `lease ${leaseId} ${year}-${month} (${type}), men ingen rad hittades. ` +
          'Aktiveringen avbryts hellre än att rapporteras som lyckad utan avi.',
      )
    }
    return befintlig
  }

  // Avinumret allokeras av `allocateRentNoticeNumber` (rent-notice-number.ts) —
  // en atomär increment-UPSERT mot RentNoticeNumberSequence, samma mönster som
  // verifikationsnumren. Den ersatte en max+1-läsning som två överlappande
  // genereringar kunde läsa samtidigt och få samma nummer ur.
  //
  // Anropet ligger med flit INUTI avi-transaktionen: radlåset på scope-raden är
  // det som serialiserar samtidig generering inom (org, år, månad). Se
  // kommentaren i rent-notice-number.ts innan du flyttar det.

  async generateMonthlyNotices(orgId: string, month: number, year: number) {
    const genMonthStart = new Date(year, month - 1, 1)
    const leases = await this.prisma.lease.findMany({
      where: {
        organizationId: orgId,
        OR: [
          { status: 'ACTIVE' },
          // T1.3: ett EXPIRED avtal som fortfarande täcker dagar i månaden
          // måste få sin sista (prorata-)avi. EXPIRED sätts ENBART av
          // succession (ACTIVE→EXPIRED, statusmaskinen #60) — flippas
          // förnyelsen FÖRE månadsgenereringen tappades annars dagarna
          // 1..gamla endDate tyst (ingen avi, ingen intäkt). Proration
          // klipper mot endDate; nya avtalets avi börjar endDate+1 →
          // glappfritt utan överlapp. TERMINATED ingår INTE: den statusen
          // rymmer även avbrutna utkast som aldrig varit i kraft.
          { status: 'EXPIRED', endDate: { gte: genMonthStart } },
        ],
      },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        unit: { include: { property: true } },
      },
    })

    if (leases.length === 0) {
      return { created: 0, skipped: 0, failed: 0, notices: [] }
    }

    // Idempotens på (lease, year, month, type=RENT) — generering kan köras
    // om utan att dubbla avier skapas (cron-retry, manuell knapptryckning).
    const existing = await this.prisma.rentNotice.findMany({
      where: { organizationId: orgId, month, year, type: RentNoticeType.RENT },
      select: { leaseId: true },
    })
    const existingLeaseIds = new Set(existing.map((n) => n.leaseId))

    let created = 0
    let skipped = 0
    // T5 A1 (#54): ett fel på EN lease får INTE avbryta resten av orgens avier.
    // Varje lease körs i egen try/catch; ett fel loggas, räknas och hoppas —
    // nästa lease fortsätter. (Tidigare kraschade ett enskilt lease-fel hela
    // orgens körning så efterföljande leases fick ingen avi den månaden.)
    let failed = 0
    const notices: RentNotice[] = []

    for (const lease of leases) {
      if (existingLeaseIds.has(lease.id)) {
        skipped++
        continue
      }

      // Kontrakt som inte täcker någon dag i månaden hoppas över. Proration
      // tar hand om delmånader (in-/utflyttning).
      const monthEnd = new Date(year, month, 0)
      const monthStart = new Date(year, month - 1, 1)
      if (lease.startDate > monthEnd) {
        skipped++
        continue
      }
      if (lease.endDate && lease.endDate < monthStart) {
        skipped++
        continue
      }

      const proration = calculateProratedRent({
        monthlyRent: Number(lease.monthlyRent),
        year,
        month,
        leaseStart: lease.startDate,
        leaseEnd: lease.endDate,
      })

      if (proration.daysCharged <= 0) {
        skipped++
        continue
      }

      let notice: RentNotice
      try {
        const ocrNumber = await this.ocrService.assignOcrToTenant(lease.tenantId, orgId)
        // Hyreslagen 12 kap. 20 § JB: hyran ska betalas senast sista
        // vardagen i månaden FÖRE den hyresperiod avin avser.
        const dueDate = rentDueDateForMonth(year, month)

        // Moms enligt upplåtelsetyp (ML 10 kap. 35 § / 9 kap). Bostad → 0.
        const { vatAmount, totalAmount } = this.rentVat(
          proration.amount,
          lease.unit,
          lease,
          `avi ${lease.id}`,
        )

        // T5 A1 (BFL 5:6): avi + intäktsverifikat i EN transaktion — antingen båda
        // eller ingendera. Kastar bokföringen (stängd period/DB-fel) rullas avin
        // tillbaka (ingen orphan).
        //
        // Avinumret allokeras INUTI tx:en — inte av bekvämlighet utan för att
        // sekvensradens lås ska serialisera samtidiga genereringar. En rollback
        // rullar tillbaka även ökningen, så inga nummer läcker (mätt mot riktig
        // Postgres — se rent-notice-number.ts).
        notice = await this.prisma.$transaction(async (tx) => {
          const noticeNumber = await allocateRentNoticeNumber(tx, orgId, year, month)
          const n = (await tx.rentNotice.create({
            data: {
              organizationId: orgId,
              tenantId: lease.tenantId,
              leaseId: lease.id,
              noticeNumber,
              ocrNumber,
              month,
              year,
              amount: proration.amount,
              vatAmount,
              totalAmount,
              dueDate,
              status: RentNoticeStatus.PENDING,
              type: RentNoticeType.RENT,
              periodStart: proration.periodStart,
              periodEnd: proration.periodEnd,
              daysCharged: proration.daysCharged,
              totalDays: proration.totalDays,
              isProrated: proration.isProrated,
            },
            include: {
              tenant: { select: SAFE_TENANT_SELECT },
              lease: { include: { unit: { include: { property: true } } } },
            },
          })) as unknown as RentNotice
          // Intäktsverifikation (BFL): 1510 D / 39xx K. Kastar → rullar tillbaka
          // avin. Returnerar null (org saknar kontoplan) → ingen bokföring, ingen
          // rollback (orgen bokför inte alls — utanför A1/audit-scope).
          await this.bookRentNoticeRevenue(orgId, n, tx)
          return n
        })
      } catch (err) {
        // Per-lease-isolering: logga + räkna + fortsätt. Ingen orphan (avin +
        // verifikat rullades tillbaka atomiskt). Avin fångas nästa körning
        // (idempotens) eller via T1.4-backfillen.
        failed++
        this.logger.error(
          `[Avisering] Avi för lease ${lease.id} (org ${orgId}) misslyckades — hoppar, ` +
            `övriga leases fortsätter: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }

      // IMD (PR 4): koppla lease:ens redan bokförda förbruknings-charges som
      // avi-rader (2-mån-lag). Sätter RentNotice.consumptionAmount; förbrukningen
      // ingår i betalbar total/OCR men har sitt EGNA verifikat (PR 3) — ingen
      // dubbelbokning här. Presentation, ej bokföring.
      try {
        const consumptionAmount = await this.consumption.attachRentNoticeLineCharges({
          organizationId: orgId,
          leaseId: lease.id,
          rentNoticeId: notice.id,
          aviMonth: month,
          aviYear: year,
        })
        if (consumptionAmount > 0) notice.consumptionAmount = new Prisma.Decimal(consumptionAmount)
      } catch (err) {
        // Misslyckad koppling får inte fälla avi-genereringen — avin (hyra) är
        // skapad och bokförd; charges förblir CONFIRMED och fångas nästa månad.
        this.logger.error(
          `[Avisering] Koppling av förbrukning till avi ${notice.noticeNumber} misslyckades: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }

      // Teknisk förvaltning (Spår A PR 4b): koppla lease:ens redan bokförda
      // CONFIRMED MiscCharges (skada/nyckel) som avi-rader. Sätter
      // RentNotice.miscChargeAmount; ingår i betalbar total/OCR/skuld men har sitt
      // EGNA verifikat (1510 D / 3990 K). Presentation, ej bokföring — samma
      // best-effort-isolering som förbrukningen ovan.
      try {
        const miscChargeAmount = await this.miscCharges.attachMiscChargesToRentNotice({
          organizationId: orgId,
          leaseId: lease.id,
          rentNoticeId: notice.id,
        })
        if (miscChargeAmount > 0) notice.miscChargeAmount = new Prisma.Decimal(miscChargeAmount)
      } catch (err) {
        this.logger.error(
          `[Avisering] Koppling av övriga debiteringar till avi ${notice.noticeNumber} misslyckades: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }

      notices.push(notice as unknown as RentNotice)
      created++
    }

    return { created, skipped, failed, notices }
  }

  /**
   * T1.4 / #44 — skapa EN efterdebiterad hyresavi för en bebodd men aldrig
   * aviserad månad, ATOMISKT (avi + intäktsverifikat i samma `tx`). Anropas
   * ENBART av RentBackfillService vid MÄNNISKO-BEKRÄFTAT skapande — aldrig av
   * cron eller aktivering. Skiljer sig från generateMonthlyNotices på tre sätt:
   *   1. `isBackfill: true` → avin exkluderas från kravtrappans auto-eskalering
   *      (RentReminderService gejtar på isBackfill=false).
   *   2. `dueDate` framåtklampad med 30-dagarsfrist (backfillRentDueDate) —
   *      ALDRIG historisk. Ränta löper först från den nya dagen (Räntelagen
   *      3–4 §, medveten eftergift; JB 12:20).
   *   3. notis + verifikat i SAMMA tx → ett bokföringsfel (stängd period, saknat
   *      konto) rullar tillbaka avin (ingen orphan-avi — PR0:s tx-kapacitet).
   * Idempotens: @@unique([leaseId,year,month,type]) → en dubbelkörning ger P2002
   * som anroparen tolkar som "månaden redan aviserad". Returnerar null om
   * månaden inte täcker några debiterbara dagar (daysCharged <= 0).
   *
   * OBS: skapar ENBART hyresavin (inte förbruknings-/skaderader) — efterdebite-
   * ring av IMD/MiscCharge har egna verifikat och ligger utanför T1.4-scope.
   */
  /**
   * T1.4 — ren beräkning (skapar/bokför INGET) av en hyresavis proration + moms
   * för en given månad. Enda källan för beloppen i BÅDE backfill-previewen
   * (RentBackfillService.detect) och det faktiska skapandet nedan → previewens
   * belopp kan aldrig divergera från det som faktiskt debiteras.
   */
  computeRentNoticeAmounts(
    lease: {
      monthlyRent: Prisma.Decimal | number
      monthlyRentExcludingVat: boolean
      startDate: Date
      endDate: Date | null
      unit: { type: UnitType; voluntaryTaxLiability: boolean }
    },
    year: number,
    month: number,
  ): {
    proration: ReturnType<typeof calculateProratedRent>
    vatAmount: number
    totalAmount: number
  } {
    const proration = calculateProratedRent({
      monthlyRent: Number(lease.monthlyRent),
      year,
      month,
      leaseStart: lease.startDate,
      leaseEnd: lease.endDate,
    })
    const { vatAmount, totalAmount } = this.rentVat(proration.amount, lease.unit, lease)
    return { proration, vatAmount, totalAmount }
  }

  async createBackfillRentNoticeInTx(
    tx: Prisma.TransactionClient,
    lease: {
      id: string
      organizationId: string
      tenantId: string
      monthlyRent: Prisma.Decimal | number
      monthlyRentExcludingVat: boolean
      startDate: Date
      endDate: Date | null
      unit: { type: UnitType; voluntaryTaxLiability: boolean }
    },
    params: {
      year: number
      month: number
      ocrNumber: string
      dueDate: Date
      // T1.4 PR2 — audit-spår (hyresjurist MÅSTE): bevisar VEM som godkände en
      // efterdebitering och att månaden var en medveten (ej tyst auto) handling.
      // Skrivs som RentNoticeEvent i SAMMA tx som avin/verifikatet — rullas
      // tillbaka tillsammans med dem om något i tx:en fallerar.
      audit?: {
        actorUserId?: string | null
        ageMonths: number
        beyondWarning: boolean // månaden låg i 12–36-grinden (BEYOND_WARNING)
        allowBeyondWarning: boolean // aktören godkände uttryckligen >12 mån
        hasVoluntaryTaxLiability?: boolean // momspliktig lokal (momsperiod-fråga)
        vatDeclarationAcknowledged?: boolean // aktören bekräftade momsdeklarationen
      }
    },
  ): Promise<RentNotice | null> {
    const { year, month, ocrNumber, dueDate, audit } = params
    const { proration, vatAmount, totalAmount } = this.computeRentNoticeAmounts(lease, year, month)
    if (proration.daysCharged <= 0) return null

    const noticeNumber = await allocateRentNoticeNumber(tx, lease.organizationId, year, month)

    const notice = (await tx.rentNotice.create({
      data: {
        organizationId: lease.organizationId,
        tenantId: lease.tenantId,
        leaseId: lease.id,
        noticeNumber,
        ocrNumber,
        month,
        year,
        amount: proration.amount,
        vatAmount,
        totalAmount,
        dueDate,
        status: RentNoticeStatus.PENDING,
        type: RentNoticeType.RENT,
        isBackfill: true,
        periodStart: proration.periodStart,
        periodEnd: proration.periodEnd,
        daysCharged: proration.daysCharged,
        totalDays: proration.totalDays,
        isProrated: proration.isProrated,
      },
    })) as unknown as RentNotice

    // Atomiskt: avi + verifikat i SAMMA tx (PR0). Kastar — och rullar tillbaka
    // avin — om perioden är stängd (VerifikationsnummerService) eller ett konto
    // saknas. Ingen orphan-avi kan uppstå på denna väg.
    await this.bookRentNoticeRevenue(lease.organizationId, notice, tx)

    // Audit-spår i SAMMA tx: människo-bekräftelsen är den juridiskt bindande
    // punkten (JB 12:21 + Preskriptionslagen 2 §). Rullar en verifikat-/
    // stängningskonflikt tillbaka avin så rullas beviset tillbaka med den —
    // ett CREATED-event finns ALDRIG utan en committad avi.
    if (audit) {
      const actorType = audit.actorUserId ? 'USER' : 'SYSTEM'
      await this.rentNoticeEvents.record(
        notice.id,
        'CREATED',
        actorType,
        audit.actorUserId ?? null,
        {
          isBackfill: true,
          year,
          month,
          periodStart: proration.periodStart.toISOString(),
          periodEnd: proration.periodEnd.toISOString(),
          ageMonths: audit.ageMonths,
          beyondWarning: audit.beyondWarning,
          allowBeyondWarning: audit.allowBeyondWarning,
          hasVoluntaryTaxLiability: audit.hasVoluntaryTaxLiability ?? false,
          vatDeclarationAcknowledged: audit.vatDeclarationAcknowledged ?? false,
          totalAmount,
        },
        { tx },
      )
    }

    return notice
  }

  // ── T5 C2b (#58) — MANUELL retrigger av aktiveringens avier ───────────────
  //
  // Aktiveringen köar `create-initial-notices`. Om KÖANDET fallerar (Redis nere/
  // frusen) blir avierna aldrig av och hyresgästen faktureras aldrig — C2a larmar
  // om det, men fram tills nu fanns ingen åtgärd: `createInitialNoticesForLease`
  // hade exakt en anropare (workern). Det här är den saknade åtgärden.
  //
  // SYNKRON, inte köad. En köad retrigger vore en attrapp: jobben har statiska
  // jobId (`initial-notices-<leaseId>`) och `removeOnFail: age 7d`, så ett
  // permanent misslyckat jobb BLOCKERAR sitt eget id i en vecka. Uppmätt mot
  // riktig bull: `add` med samma jobId efter ett permanent fail ger waiting=0 och
  // jobbet står kvar `failed` — anroparen får 200 utan att något händer. Motorn
  // är dessutom idempotent (P2002 → hämtar befintlig) och atomisk (A1: avi +
  // verifikat i samma tx), så den är säker att köra rakt av och ger ett SANT
  // svar direkt i stället för ett jobb-id att gissa om.
  //
  // 🔴 PENGASKYDD — flaggorna HÄRLEDS ur leasets tillstånd, aldrig från
  // anroparen. Ett förnyat avtal (succession) är ett NYTT lease-id vars
  // deposition re-pekats från föregångaren (T1.3, `Deposit.leaseId` @unique) och
  // vars `depositAmount` följt med i carry-fälten. Ett blint `skipDeposit:false`
  // träffar därför INGEN P2002 (nyckeln (leaseId, year, month, DEPOSIT) är ny)
  // → en ANDRA depositionsavi skapas och `ensureDepositForNotice` bokför en
  // ANDRA deposition (1510/2890) = hyresgästen krävs på deposition två gånger.
  // Tre oberoende signaler får därför spärra depositionen; vilken som helst
  // räcker (fail-safe åt "kräv inte pengar igen").
  async retriggerInitialNotices(
    leaseId: string,
    organizationId: string,
    opts: { actorRole?: UserRole } = {},
  ): Promise<{
    deposit: RentNotice | null
    firstRent: RentNotice | null
    mailed: boolean
    skippedDeposit: boolean
    skipDepositReason: 'succession' | 'deposit-finns' | 'depositionsavi-finns' | null
  }> {
    // Rollgrind på TJÄNSTEN (chokepunkten), inte bara i controllern — speglar
    // RentBackfillService (#194). Fail-closed: okänd/saknad roll nekas.
    const allowed: UserRole[] = [UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER]
    if (!opts.actorRole || !allowed.includes(opts.actorRole)) {
      throw new ForbiddenException('Du saknar behörighet att skapa avierna för kontraktet')
    }

    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId },
      select: { id: true, status: true, startDate: true, tenancyStartDate: true },
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (lease.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Avierna kan bara skapas för ett aktivt kontrakt. Aktivera kontraktet först.',
      )
    }

    // Signal 1 — kontinuitetsmarkören (T1.3b): en successor ärver föregångarens
    // tenancyStartDate medan startDate nollställs till oldEnd+1, så
    // tenancyStartDate < startDate ⇔ förnyelse. Styr BÅDE depositionsspärren och
    // gap-avins förfallodagsregel (JB 12 kap 20 § 2 st — hyresgästen bor redan
    // där, inflyttningsoffseten är fel klassificering).
    const succession = lease.tenancyStartDate.getTime() < lease.startDate.getTime()

    // Signal 2 — depositionen är redan uttagen (eller re-pekad hit vid förnyelse).
    const existingDeposit = await this.prisma.deposit.findFirst({
      where: { leaseId: lease.id, organizationId },
      select: { id: true },
    })

    // Signal 3 — en depositionsavi finns redan för kontraktet, oavsett period.
    // Motorns egen P2002-idempotens täcker bara (leaseId, year, month, DEPOSIT);
    // den här bredare kontrollen kostar en query och stänger resten.
    const existingDepositNotice = await this.prisma.rentNotice.findFirst({
      where: { leaseId: lease.id, organizationId, type: RentNoticeType.DEPOSIT },
      select: { id: true },
    })

    const skipDepositReason = succession
      ? ('succession' as const)
      : existingDeposit
        ? ('deposit-finns' as const)
        : existingDepositNotice
          ? ('depositionsavi-finns' as const)
          : null
    const skipDeposit = skipDepositReason !== null

    this.logger.log(
      `[Avisering] Manuell retrigger av initial-avier för lease ${lease.id} ` +
        `(succession=${succession}, skipDeposit=${skipDeposit}${
          skipDepositReason ? ` [${skipDepositReason}]` : ''
        })`,
    )

    const result = await this.createInitialNoticesForLease(lease.id, { skipDeposit, succession })
    return { ...result, skippedDeposit: skipDeposit, skipDepositReason }
  }

  // ── Auto-skapa avier vid lease-aktivering (DRAFT → ACTIVE) ────────────────
  // Skapar två avier vid behov: deposition (om depositAmount > 0) och första
  // hyresavi (proportionellt om tillträde mitt i månaden). Båda får samma
  // förfallodag = lease.startDate − daysBeforeMoveInForFirstPayment (org-
  // inställning, default 7), justerat till närmaste vardag bakåt.
  //
  // Idempotent via @@unique(leaseId, year, month, type) på RentNotice — om
  // metoden körs två gånger för samma lease tolkar vi P2002 som "redan
  // skapad" och hämtar befintlig istället.
  async createInitialNoticesForLease(
    leaseId: string,
    opts: { skipDeposit?: boolean; succession?: boolean } = {},
  ): Promise<{
    deposit: RentNotice | null
    firstRent: RentNotice | null
    mailed: boolean
  }> {
    const lease = await this.prisma.lease.findUnique({
      where: { id: leaseId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        unit: { include: { property: true } },
      },
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (lease.status !== 'ACTIVE') {
      return { deposit: null, firstRent: null, mailed: false }
    }

    const orgId = lease.organizationId
    // Lease-modellen saknar relation till Organization i schema — vi hämtar
    // separat. Settings-fältet (daysBeforeMoveInForFirstPayment) styr
    // förfallodagens offset från tillträdesdatum.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { daysBeforeMoveInForFirstPayment: true },
    })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const startDate = lease.startDate
    const year = startDate.getFullYear()
    const month = startDate.getMonth() + 1

    // T1.3: gap-avin vid succession är INTE en "första" period — hyresgästen
    // bor redan i lägenheten och inflyttningslogiken (daysBeforeMoveIn-offset)
    // är fel klassificering. JB 12 kap 20 § 2 st gäller rakt av: förfallodag
    // senast sista vardagen före den period hyran avser (delmånad eller hel),
    // framåtklampad om dagen redan passerat (auto-förnyelse körs dagen efter
    // gamla slutdatumet — avin får inte födas förfallen in i kravtrappan).
    const dueDate = opts.succession
      ? rentDueDateForPeriodStart(startDate)
      : calculateFirstPaymentDueDate(startDate, org.daysBeforeMoveInForFirstPayment)

    const ocrNumber = await this.ocrService.assignOcrToTenant(lease.tenantId, orgId)

    let depositNotice: RentNotice | null = null
    let firstRentNotice: RentNotice | null = null

    // ── 1. Deposition ────────────────────────────────────────────────────
    // Succession (skipDeposit): depositionen är redan uttagen/bokförd på
    // ursprungsavtalet och re-pekas (T1.3) — ingen ny deposition-avi vid förnyelse.
    const depositAmount = Number(lease.depositAmount ?? 0)
    if (depositAmount > 0 && !opts.skipDeposit) {
      try {
        const noticeNumber = await allocateRentNoticeNumber(this.prisma, orgId, year, month)
        depositNotice = (await this.prisma.rentNotice.create({
          data: {
            organizationId: orgId,
            tenantId: lease.tenantId,
            leaseId: lease.id,
            noticeNumber,
            ocrNumber,
            month,
            year,
            amount: depositAmount,
            vatAmount: 0,
            totalAmount: depositAmount,
            dueDate,
            status: RentNoticeStatus.PENDING,
            type: RentNoticeType.DEPOSIT,
          },
        })) as unknown as RentNotice
      } catch (err) {
        // Bara periodnyckeln är benign — se RENT_NOTICE_PERIOD_UNIQUE.
        if (isP2002From(err, RENT_NOTICE_PERIOD_UNIQUE)) {
          depositNotice = await this.hämtaBefintligAvi(
            lease.id,
            year,
            month,
            RentNoticeType.DEPOSIT,
          )
        } else {
          throw err
        }
      }

      // #41: skapa Deposit-raden + boka 1510 D/2890 K för deposition-avin.
      // Utan detta bokförs depositionen aldrig och kan aldrig återbetalas.
      // Idempotent + atomisk (Deposit finns ⇔ 1510/2890 bokförd). Best-effort:
      // ett fel här får inte fälla hela aktiverings-aviseringen (avin är skapad),
      // orphan-avin fångas då av backfillen och förblir omatchbar tills dess.
      if (depositNotice) {
        try {
          await this.deposits.ensureDepositForNotice({
            organizationId: orgId,
            leaseId: lease.id,
            tenantId: lease.tenantId,
            rentNoticeId: depositNotice.id,
            noticeNumber: depositNotice.noticeNumber,
            amount: depositAmount,
            date: depositNotice.createdAt ?? new Date(),
          })
        } catch (err) {
          this.logger.error(
            `[Avisering] Deposit-rad för avi ${depositNotice.noticeNumber} kunde inte skapas: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    }

    // ── 2. Första hyresavi (delmånad eller hel) ──────────────────────────
    const proration = calculateProratedRent({
      monthlyRent: Number(lease.monthlyRent),
      year,
      month,
      leaseStart: lease.startDate,
      leaseEnd: lease.endDate,
    })

    if (proration.daysCharged > 0) {
      try {
        // T5 A1 (BFL 5:6): första hyresavin + intäktsverifikatet i EN transaktion.
        // Kastar bokföringen (stängd period/DB-fel) rullas avin tillbaka → ingen
        // orphan (tidigare bokfördes den utanför tx och sväljdes/loggades).
        firstRentNotice = await this.prisma.$transaction(async (tx) => {
          const noticeNumber = await allocateRentNoticeNumber(tx, orgId, year, month)
          // Moms enligt upplåtelsetyp (ML 10 kap. 35 § / 9 kap). Bostad → 0.
          const { vatAmount, totalAmount } = this.rentVat(
            proration.amount,
            lease.unit,
            lease,
            `avi ${noticeNumber}`,
          )
          const n = (await tx.rentNotice.create({
            data: {
              organizationId: orgId,
              tenantId: lease.tenantId,
              leaseId: lease.id,
              noticeNumber,
              ocrNumber,
              month,
              year,
              amount: proration.amount,
              vatAmount,
              totalAmount,
              dueDate,
              status: RentNoticeStatus.PENDING,
              type: RentNoticeType.RENT,
              periodStart: proration.periodStart,
              periodEnd: proration.periodEnd,
              daysCharged: proration.daysCharged,
              totalDays: proration.totalDays,
              isProrated: proration.isProrated,
            },
          })) as unknown as RentNotice
          // Intäktsverifikation i SAMMA tx (skuld-avin, DEPOSIT, bokförs ej här —
          // den går via deposits-modulen ovan). Kastar → rullar tillbaka avin.
          await this.bookRentNoticeRevenue(orgId, n, tx)
          return n
        })
      } catch (err) {
        // Idempotens: en samtidig aktivering/retry hann skapa avin (P2002 på
        // @@unique(leaseId, year, month, type)). Den befintliga avin är redan
        // atomiskt bokförd av sitt ursprungliga anrop → hämta, boka inte om.
        //
        // Villkoret var tidigare bara `err.code === 'P2002'` — ALLA unikhetsbrott.
        // En kollision på @@unique(organizationId, noticeNumber) klassades därmed
        // som benign, `findFirst` hittade ingenting, och aktiveringen returnerade
        // `{ firstRent: null, mailed: false }` som om allt gått bra. Hyresgästen
        // fick aldrig sin första avi, och ingenting larmade.
        if (isP2002From(err, RENT_NOTICE_PERIOD_UNIQUE)) {
          firstRentNotice = await this.hämtaBefintligAvi(lease.id, year, month, RentNoticeType.RENT)
        } else {
          throw err
        }
      }
    }

    // ── 3. Mejla hyresgästen med båda avier som bilagor ─────────────────
    let mailed = false
    if (lease.tenant.email && (depositNotice || firstRentNotice)) {
      try {
        const idsToSend = [depositNotice?.id, firstRentNotice?.id].filter((id): id is string =>
          Boolean(id),
        )
        const result = await this.sendNotices(orgId, idsToSend)
        mailed = result.queued > 0
      } catch (err) {
        // Mejlfel ska inte krascha lease-aktiveringen — avier är skapade,
        // admin kan trigga "Skicka" manuellt om mejlet failar.
        this.logger.warn(
          `[Avisering] Initial mail failed for lease ${lease.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    return { deposit: depositNotice, firstRent: firstRentNotice, mailed }
  }

  /**
   * Köar utskick av hyresavier. Varje avi blir ett eget Bull-jobb — granulär
   * retry, idempotens och inget HTTP-blockerande PDF-rendering. Returnerar
   * direkt med jobb-id:n; workern (processNoticeSendJob) gör renderingen.
   */
  async sendNotices(
    orgId: string,
    noticeIds: string[],
  ): Promise<{ queued: number; failed: number; jobIds: string[] }> {
    const jobIds: string[] = []
    let failed = 0
    for (const noticeId of noticeIds) {
      // T5 C2b: samma klass som #58 och oadresserad av C2a. Anropas den här
      // metoden från createInitialNoticesForLease ligger den i en try/catch som
      // sväljer till logger.warn → avierna skapas men mejlet köas aldrig, avierna
      // står kvar PENDING och ingen larmas. enqueueSafely larmar (Sentry) och
      // golvar väntetiden. Per avi, så en trasig avi inte tystar de övriga.
      const outcome = await enqueueSafely(
        () =>
          this.pdfQueue.enqueue({
            kind: 'avisering-send',
            organizationId: orgId,
            noticeId,
          }),
        {
          queue: QUEUE_PDF,
          jobType: 'avisering-send',
          organizationId: orgId,
          logger: this.logger,
        },
      )
      if (outcome.status === 'ok') jobIds.push(outcome.jobId)
      else failed++
    }
    return { queued: jobIds.length, failed, jobIds }
  }

  /**
   * Behandlar EN avi — anropas av PdfWorker. Renderar PDF, köar mejlet och
   * sätter status SENT. Idempotent: redan skickade avier hoppas över så en
   * Bull-retry aldrig ger ett dubbelmejl. Vid fel markeras avin FAILED och
   * felet kastas vidare så Bull kan schemalägga retry.
   */
  async processNoticeSendJob(orgId: string, noticeId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
        lines: true,
      },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    // Idempotens: hoppa över avier som redan skickats.
    if (notice.sentAt || notice.status === RentNoticeStatus.SENT) return

    // Saknad e-post är ett permanent fel — markera FAILED utan att kasta,
    // annars gör Bull fem meningslösa retries.
    if (!notice.tenant.email) {
      await this.prisma.rentNotice
        .update({
          where: { id: noticeId },
          data: { status: RentNoticeStatus.FAILED, sendError: 'Hyresgästen saknar e-postadress' },
        })
        .catch(() => undefined)
      return
    }

    try {
      const pdfHtml = await this.buildNoticePdfHtml(notice, org)
      const pdfBuffer = await this.pdfService.generateFromHtml(pdfHtml)

      const tenantName =
        notice.tenant.type === 'INDIVIDUAL'
          ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
          : (notice.tenant.companyName ?? notice.tenant.email)

      // Mejlet köas med idempotencyKey så att en Bull-retry (om DB-uppdateringen
      // nedan misslyckas efter att mejlet redan köats) inte ger dubbelmejl.
      await this.mailService.sendRentNotice({
        to: notice.tenant.email,
        tenantName,
        ocrNumber: notice.ocrNumber,
        // Betalbar total = hyra + förbrukning (IMD) + övriga debiterbara poster
        // (skada/nyckel). Vad hyresgästen faktiskt betalar med avins OCR.
        amount: rentNoticePayableTotal(notice),
        dueDate: notice.dueDate,
        pdfBuffer,
        organizationName: org.name,
        noticeNumber: notice.noticeNumber,
        accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
        idempotencyKey: `rent-notice-${notice.id}`,
      })

      await this.prisma.rentNotice.update({
        where: { id: noticeId },
        data: {
          status: RentNoticeStatus.SENT,
          sentAt: new Date(),
          sentTo: notice.tenant.email,
          sendError: null,
        },
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await this.prisma.rentNotice
        .update({
          where: { id: noticeId },
          data: { status: RentNoticeStatus.FAILED, sendError: errorMessage },
        })
        .catch(() => undefined)
      throw err
    }
  }

  async getNoticePdfBuffer(noticeId: string, orgId: string): Promise<Buffer> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
        lines: true,
      },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const html = await this.buildNoticePdfHtml(notice, org)
    return this.pdfService.generateFromHtml(html)
  }

  private async buildNoticePdfHtml(
    notice: NoticeWithRelations,
    org: {
      name: string
      street?: string | null
      postalCode?: string | null
      city?: string | null
      email?: string | null
      bankgiro?: string | null
      invoiceColor?: string | null
      brandSecondaryColor?: string | null
      brandFont?: string | null
      logoStorageKey?: string | null
    },
  ): Promise<string> {
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)
    // Steg 3, PR 3b/3c: hårdkodad #1a6b3c → delad DEFAULT_BRAND_COLOR (= '#1a6b3c',
    // alltså pixel-identiskt för orgs utan egen invoiceColor). Avbockad i kartan.
    const primaryColor = org.invoiceColor ?? DEFAULT_BRAND_COLOR
    const bankgiro = org.bankgiro ?? '0000-0000'

    // Konsekvent beloppsformat med hyresfakturan: alltid två decimaler (ören).
    // Tidigare visade avin ören bara när de fanns medan fakturan rundade till
    // hela kronor — nu använder båda dokumenten samma 2-decimalsformat.
    const fmt = (n: number): string =>
      Number(n).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    // Betalbar total = hyra + förbrukning (IMD-rader) + övriga debiterbara poster
    // (skada/nyckel). Hyresgästen betalar EN summa med ETT OCR. notice.totalAmount
    // avser bara hyran (hyresverifikatet).
    const payable = rentNoticePayableTotal(notice)
    const consumptionLines = notice.lines ?? []
    // HTML för förbrukningsrader (visas mellan hyra och totalsumma).
    const consumptionRowsHtml = consumptionLines
      .map(
        (l) => `
      <tr>
        <td>${escapeHtml(l.description)}</td>
        <td>${fmt(Number(l.total))} kr</td>
      </tr>`,
      )
      .join('')

    const tenantName =
      notice.tenant.type === 'INDIVIDUAL'
        ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
        : (notice.tenant.companyName ?? '')

    const tenant = notice.tenant
    const unit = notice.lease?.unit
    const property = notice.lease?.unit?.property

    function formatBankgiroLine(ocrNumber: string, totalAmount: number, bg: string): string {
      const kronor = Math.floor(totalAmount).toString()
      const oren = Math.round((totalAmount % 1) * 100)
        .toString()
        .padStart(2, '0')
      const digits = (kronor + oren).split('').map(Number)
      let sum = 0
      let isEven = false
      for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits[i]!
        if (isEven) {
          d *= 2
          if (d > 9) d -= 9
        }
        sum += d
        isEven = !isEven
      }
      const checkDigit = (10 - (sum % 10)) % 10
      const bgFormatted = bg.replace('-', '')
      return `# ${ocrNumber} # ${kronor} ${oren} ${checkDigit} > ${bgFormatted}#41#`
    }

    const ocrLine = formatBankgiroLine(notice.ocrNumber, payable, bankgiro)

    const monthLabel = new Date(notice.year, notice.month - 1, 1).toLocaleDateString('sv-SE', {
      month: 'long',
      year: 'numeric',
    })

    const isDeposit = notice.type === RentNoticeType.DEPOSIT
    const isProrated = notice.isProrated

    // T1.4 PR2 — efterdebiterings-text (hyresjurist MÅSTE, JB 12:21). En backfill-
    // avi måste förklara VAD den avser oavsett om månaden är delmånad eller hel,
    // annars kan hyresgästen inte bedöma sin bestridanderätt. Visas i BÅDA
    // rent-grenarna (delmånad + hel månad).
    const fmtDay = (d: Date | string): string =>
      new Date(d).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' })
    const backfillNoteHtml =
      notice.isBackfill && notice.periodStart && notice.periodEnd
        ? `<div style="font-size:10px;color:#8a5a00;background:#fff8e6;border-radius:4px;padding:6px 8px;margin-top:6px;line-height:1.5">
            Efterfakturerad hyra för perioden ${fmtDay(notice.periodStart)}–${fmtDay(notice.periodEnd)} (sen registrering).
            Avser en tidigare bebodd men ännu ej aviserad period.
            Har du frågor om denna efterdebitering, kontakta oss innan förfallodagen.
          </div>`
        : ''

    const monthlyRent = Number(notice.lease?.monthlyRent ?? 0)
    const dailyRate =
      notice.totalDays && notice.totalDays > 0
        ? Math.round((monthlyRent / notice.totalDays) * 100) / 100
        : 0

    // Fri text escapas (latent XSS-skydd). OBS: belopp (fmt) och OCR-/datumfält
    // är systemgenererade och lämnas ORÖRDA i värde — bara namn/beteckningar
    // escapas. objektCell-fallbacken (OCR-slice) är rena siffror → escapeHtml
    // ändrar inte värdet.
    const objektCell = escapeHtml(unit?.unitNumber ?? notice.ocrNumber.slice(-6))
    const unitNamePart = unit ? ` — ${escapeHtml(unit.name as string)}` : ''
    const propertyPart = property
      ? `, ${escapeHtml((property.street as string | null | undefined) ?? (property.name as string))}`
      : ''

    const specRowsHtml = isDeposit
      ? `
      <tr>
        <td>${objektCell}</td>
        <td>
          <strong>Deposition</strong>
          ${unitNamePart}
          ${propertyPart}
          <div style="font-size:10px;color:#666;margin-top:4px">
            Säkerhet enligt 12 kap. 21 § JB. Återbetalas vid avflyttning efter slutbesiktning.
          </div>
        </td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>`
      : isProrated
        ? `
      <tr>
        <td>${objektCell}</td>
        <td>
          <strong>Hyra ${monthLabel} (delmånad)</strong>
          ${unitNamePart}
          ${propertyPart}
          <div style="font-size:10px;color:#666;margin-top:4px;line-height:1.5">
            Period: ${notice.periodStart ? new Date(notice.periodStart).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' }) : ''}
            – ${notice.periodEnd ? new Date(notice.periodEnd).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' }) : ''}
            (${notice.daysCharged} av ${notice.totalDays} dagar)<br>
            Dagshyra: ${fmt(monthlyRent)} / ${notice.totalDays} =
            ${fmt(dailyRate)} kr
          </div>
          ${backfillNoteHtml}
        </td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>`
        : `
      <tr>
        <td>${objektCell}</td>
        <td>
          Hyra ${monthLabel}
          ${unitNamePart}
          ${propertyPart}
          ${backfillNoteHtml}
        </td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>`

    const aviTitle = isDeposit ? 'Depositionsavi' : 'Hyresavi'

    // Steg 3, PR 3c: avin renderas genom den gemensamma brandade shellen.
    // Avins egna outer-wrapper (html/head/body) och egen logga/titel är borttagna
    // — shellen ger logga, primär-/sekundärfärg, typsnitt och dokumenttitel.
    // hideFooter:true så att bankgiro-/avrivningsslipen förblir sidans botten
    // (org-kontakt behålls i övre delen). body-font borttagen så shellens typsnitt
    // styr; bas-fontstorleken (11px) återställs på .bp-content. Allt
    // betalningsbärande (OCR, belopp, bankgiro, förfallodatum, mottagare, OCR-rad)
    // är BYTE-FÖR-BYTE oförändrat.
    const contentCss = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .bp-content { font-size: 11px; color: #333; }

  /* ── UPPER SECTION ── */
  .upper { padding: 30px 40px 20px 40px; }

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }
  .org-name {
    font-size: 20px;
    font-weight: bold;
    color: ${primaryColor};
    margin-bottom: 4px;
  }
  .org-details { font-size: 10px; color: #555; line-height: 1.6; }

  .avi-header { text-align: right; }
  .avi-title {
    font-size: 18px;
    font-weight: bold;
    color: ${primaryColor};
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .avi-meta {
    font-size: 10px;
    color: #666;
    margin-top: 6px;
    line-height: 1.8;
  }
  .avi-meta span { font-weight: bold; color: #333; }

  .recipient-box {
    border-left: 3px solid ${primaryColor};
    padding: 10px 16px;
    margin: 20px 0;
    background: #fafafa;
  }
  .recipient-name { font-size: 13px; font-weight: bold; }
  .recipient-detail { font-size: 10px; color: #666; margin-top: 2px; }

  .spec-table {
    width: 100%;
    border-collapse: collapse;
    margin: 20px 0;
  }
  .spec-table th {
    background: ${primaryColor};
    color: white;
    padding: 8px 12px;
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .spec-table th:last-child { text-align: right; }
  .spec-table td {
    padding: 8px 12px;
    border-bottom: 1px solid #eee;
    font-size: 11px;
  }
  .spec-table td:last-child { text-align: right; font-weight: 500; }
  .spec-table tr:nth-child(even) td { background: #f9f9f9; }

  .totals-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
    padding-right: 12px;
  }
  .totals-table { font-size: 11px; }
  .totals-table td { padding: 3px 12px; }
  .totals-table td:last-child { text-align: right; font-weight: 500; }
  .total-final td {
    font-size: 14px;
    font-weight: bold;
    color: ${primaryColor};
    border-top: 2px solid ${primaryColor};
    padding-top: 6px;
  }

  .due-notice {
    background: #fff3cd;
    border: 1px solid #ffc107;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 16px 0;
    font-size: 10px;
    color: #856404;
  }

  /* ── TEAR OFF LINE ── */
  .tearoff {
    border-top: 2px dashed #999;
    margin: 10px 40px;
    position: relative;
    text-align: center;
  }
  .tearoff-label {
    position: absolute;
    top: -8px;
    left: 50%;
    transform: translateX(-50%);
    background: white;
    padding: 0 10px;
    font-size: 9px;
    color: #999;
    white-space: nowrap;
  }

  /* ── PAYMENT SLIP ── */
  .payment-slip {
    padding: 16px 40px 20px 40px;
    background: white;
  }

  .slip-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .bankgiro-logo {
    font-size: 16px;
    font-weight: bold;
    color: #003087;
    border: 2px solid #003087;
    padding: 4px 10px;
    border-radius: 3px;
    letter-spacing: 1px;
  }
  .slip-title {
    font-size: 12px;
    font-weight: bold;
    color: #333;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 2px;
  }

  .slip-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    margin: 12px 0;
  }
  .slip-field .label {
    font-size: 9px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 3px;
  }
  .slip-field .value {
    font-size: 13px;
    font-weight: bold;
    color: #333;
  }

  .ocr-section {
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 12px 16px;
    margin: 12px 0;
    text-align: center;
  }
  .ocr-label {
    font-size: 9px;
    color: #666;
    text-transform: uppercase;
    margin-bottom: 6px;
    letter-spacing: 1px;
  }
  .ocr-number {
    font-size: 28px;
    font-weight: bold;
    font-family: 'Courier New', monospace;
    letter-spacing: 4px;
    color: ${primaryColor};
  }
  .ocr-instruction {
    font-size: 9px;
    color: #888;
    margin-top: 4px;
  }

  .bankgiro-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 10px 0;
    padding: 8px 0;
    border-top: 1px solid #eee;
  }
  .bankgiro-number {
    font-size: 16px;
    font-weight: bold;
    color: #003087;
  }
  .amount-box { text-align: right; }
  .amount-label { font-size: 9px; color: #666; }
  .amount-value {
    font-size: 22px;
    font-weight: bold;
    color: #c0392b;
  }

  .ocr-machine-line {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #ccc;
    font-family: 'OCR-B', 'Courier New', monospace;
    font-size: 14px;
    letter-spacing: 3px;
    color: #000;
    text-align: center;
  }
  .ocr-warning {
    font-size: 8px;
    color: #999;
    text-align: center;
    margin-top: 4px;
    font-family: Arial, sans-serif;
    letter-spacing: normal;
  }

  @page { margin: 10mm; size: A4; }`

    const contentHtml = `<style>${contentCss}</style>

<!-- ═══ UPPER SECTION ═══ -->
<div class="upper">
  <div class="header-row">
    <div>
      <div class="org-name">${escapeHtml(org.name)}</div>
      <div class="org-details">
        ${org.street ? `${escapeHtml(org.street)}, ${escapeHtml(org.postalCode ?? '')} ${escapeHtml(org.city ?? '')}<br>` : ''}
        ${org.bankgiro ? `Bankgiro: ${bankgiro}<br>` : ''}
        ${org.email ? `E-post: ${escapeHtml(org.email)}` : ''}
      </div>
    </div>
    <div class="avi-header">
      <div class="avi-meta">
        Datum: <span>${new Date().toLocaleDateString('sv-SE')}</span><br>
        Avinummer: <span>${notice.noticeNumber}</span><br>
        ${isDeposit ? '' : `Period: <span>${monthLabel}</span><br>`}
        Kundnr: <span>${notice.ocrNumber.slice(-6)}</span>
      </div>
    </div>
  </div>

  <div class="recipient-box">
    <div class="recipient-name">${escapeHtml(tenantName)}</div>
    <div class="recipient-detail">${escapeHtml(tenant.email)}</div>
    ${tenant.phone ? `<div class="recipient-detail">${escapeHtml(tenant.phone as string)}</div>` : ''}
  </div>

  <table class="spec-table">
    <thead>
      <tr>
        <th>Objekt</th>
        <th>Specifikation</th>
        <th>Summa</th>
      </tr>
    </thead>
    <tbody>
      ${specRowsHtml}
      ${
        Number(notice.vatAmount) > 0
          ? `
      <tr>
        <td></td>
        <td>Moms ${((Number(notice.vatAmount) / Number(notice.amount)) * 100).toFixed(0)}%</td>
        <td>${fmt(Number(notice.vatAmount))} kr</td>
      </tr>`
          : ''
      }
    </tbody>
  </table>

  <div class="totals-row">
    <table class="totals-table">
      ${
        Number(notice.vatAmount) > 0
          ? `
      <tr>
        <td>Delsumma:</td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>
      <tr>
        <td>Moms:</td>
        <td>${fmt(Number(notice.vatAmount))} kr</td>
      </tr>`
          : ''
      }
      ${
        consumptionLines.length > 0
          ? `
      <tr>
        <td>Hyra:</td>
        <td>${fmt(Number(notice.totalAmount))} kr</td>
      </tr>
      ${consumptionRowsHtml}`
          : ''
      }
      <tr class="total-final">
        <td>Att betala:</td>
        <td>${fmt(payable)} kr</td>
      </tr>
    </table>
  </div>

  <div class="due-notice">
    &#9888; Dröjsmål debiteras med referensränta + 8% —
    Förfallodatum: <strong>${notice.dueDate.toLocaleDateString('sv-SE')}</strong>
  </div>
</div>

<!-- ═══ TEAR OFF LINE ═══ -->
<div class="tearoff">
  <span class="tearoff-label">&#9986; Avrivningskupong — skicka in vid betalning</span>
</div>

<!-- ═══ PAYMENT SLIP ═══ -->
<div class="payment-slip">
  <div class="slip-header">
    <div class="bankgiro-logo">bankgirot</div>
    <div class="slip-title">Inbetalning / Girering AVI</div>
    <div style="width:80px"></div>
  </div>

  <div class="slip-grid">
    <div class="slip-field">
      <div class="label">Betalningsmottagare</div>
      <div class="value" style="font-size:12px">${org.name}</div>
    </div>
    <div class="slip-field">
      <div class="label">Förfallodatum</div>
      <div class="value" style="color:#c0392b">
        ${notice.dueDate.toLocaleDateString('sv-SE')}
      </div>
    </div>
    <div class="slip-field">
      <div class="label">${isDeposit ? 'Avser' : 'Period'}</div>
      <div class="value" style="font-size:12px">${isDeposit ? 'Deposition' : monthLabel}</div>
    </div>
  </div>

  <div class="ocr-section">
    <div class="ocr-label">OCR-nummer — ange alltid vid betalning</div>
    <div class="ocr-number">${notice.ocrNumber}</div>
    <div class="ocr-instruction">
      Detta nummer identifierar din betalning automatiskt
    </div>
  </div>

  <div class="bankgiro-row">
    <div>
      <div style="font-size:9px; color:#666; margin-bottom:3px">TILL BANKGIRO</div>
      <div class="bankgiro-number">${bankgiro}</div>
    </div>
    <div class="amount-box">
      <div class="amount-label">ATT BETALA</div>
      <div class="amount-value">
        ${fmt(payable)} kr
      </div>
    </div>
  </div>

  <!-- Machine-readable OCR line -->
  <div class="ocr-machine-line">
    ${ocrLine}
  </div>
  <div class="ocr-warning">
    VAR GOD GÖR INGA ÄNDRINGAR — DEN AVLÄSES MASKINELLT
  </div>
</div>`

    return buildBrandedPdfHtml({
      // Footern är dold (hideFooter) → org-kontakt ligger i övre delen ovan.
      // Shellen behöver bara namnet (logga/titel/font/färg).
      org: { name: org.name },
      logoDataUrl,
      primaryColor: org.invoiceColor ?? null,
      secondaryColor: org.brandSecondaryColor ?? null,
      brandFont: org.brandFont ?? null,
      title: aviTitle,
      contentHtml,
      hideFooter: true,
    })
  }

  // Registrerar en hyresavi som betald OCH bokför betalningen (FIX 9 · PR 6).
  // Sluter intäktscykeln: utan denna bokning skulle kundfordran 1510 växa
  // obegränsat eftersom PR 2 endast bokade fordran vid avisering.
  //
  // Flödet är race-säkert och har invarianten "ingen PAID-avi utan verifikat":
  //   1. Atomisk statusövergång (updateMany med status-guard) tar avin från
  //      obetald → PAID. Exakt en process kan vinna — samma mönster som
  //      bankavstämningen (applyMatchToRentNotice) — så en manuell markering och
  //      en parallell bankavstämning av samma avi utesluter varandra och kan
  //      aldrig skapa två betalningsverifikat mot 1510.
  //   2. Bokför betalningen (likvidkonto D / 1510 K) EFTER övergången. Kan
  //      verifikatet inte skapas (saknat konto eller DB-fel) ångras
  //      statusövergången och felet propageras — avin kan då regleras på nytt
  //      när orsaken är åtgärdad (BFL 5 kap 6 §).
  async markAsPaid(
    noticeId: string,
    orgId: string,
    paidAmount: number,
    paymentMethod: PaymentMethod,
    paidAt?: string,
    createdById?: string | null,
  ) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    if (notice.status === RentNoticeStatus.CANCELLED) {
      throw new BadRequestException('Kan inte markera avbruten avi som betald')
    }
    if (notice.status === RentNoticeStatus.PAID) {
      throw new BadRequestException('Avin är redan betald')
    }
    // #41/T2.2: en DEPOSITIONS-avi betalas via depositionen (bankmatchning eller
    // deposits.markPaid) — den EGNA kanoniska vägen som bokför 1930 D/1510 K och
    // flippar Deposit→PAID. Att markera den betald här skulle flippa avin utan att
    // röra Deposit/bokföringen (divergens). Blockera → en kanonisk betalväg.
    if (notice.type === RentNoticeType.DEPOSIT) {
      throw new BadRequestException(
        'En depositionsavi betalas via depositionen (bankmatchning eller "markera betald" i ' +
          'depositionsvyn), inte som en vanlig hyresavi.',
      )
    }

    const paymentDate = paidAt ? new Date(paidAt) : new Date()

    // ── ATOMICITET (#108) ───────────────────────────────────────────────────
    //
    // Hela registreringen — låsning, omvalidering, claim, allokering och verifikat
    // — ligger i EN transaktion med radlås, samma mönster som bankvägens
    // `applyMatchToRentNotice` redan bevisar i produktion.
    //
    // Tidigare låg här ett KOMPENSERANDE mönster: skriv först, ångra i ett catch
    // om bokföringen sa nej. Det fungerar bara om processen lever tillräckligt
    // länge för att köra sitt catch — och det är precis vad en SIGKILL, en
    // OOM-dödad container eller en deploy-omstart bryter. Två halvtillstånd kunde
    // överleva en sådan krasch:
    //
    //   • allokering utan verifikat  → en verklig inbetalning saknar post i
    //     huvudboken. Permanent, ingen självläkning. Farligast vid KONTANT
    //     betalning: bankavstämningen kan aldrig upptäcka glappet i efterhand.
    //   • PAID utan allokering       → avin ser reglerad ut medan fordran
    //     kvarstår. collectionStage nollställs med claimen, så fordran lämnar
    //     kravtrappan tyst: ingen påminnelse, ingen ränta, ingen inkasso, ingen
    //     nedskrivning. I praktiken en oredovisad avskrivning.
    //
    // En databastransaktion ger atomicitet oavsett vad som händer med processen.
    // Ett try/catch gör det aldrig — skillnaden mellan en garanti och en
    // förhoppning.
    //
    // RADLÅSET LÖSER OCKSÅ TOCTOU:t. `priorAllocs` lästes förut innan claimen, så
    // en samtidig bankmatchning kunde skriva en allokering emellan och göra
    // `completesNotice` beräknad på inaktuell grund. Läsningen ligger nu INNANFÖR
    // låset, och bankvägen tar samma lås — de två vägarna serialiseras mot
    // varandra. Ingen separat TOCTOU-mekanism behövs.
    const utfall = await this.prisma.$transaction(
      async (tx) => {
        // Rad-lås FÖRST — serialiserar mot bankvägen och mot andra manuella
        // registreringar på samma avi.
        await tx.$queryRaw`SELECT id FROM "RentNotice" WHERE id = ${noticeId} AND "organizationId" = ${orgId} FOR UPDATE`

        // Omläsning INNANFÖR låset. Preflight-kontrollerna ovan ger tydliga
        // felmeddelanden, men det är den här läsningen som är sanningen: mellan
        // preflight och lås kan en annan process ha hunnit reglera eller avbryta.
        const låst = await tx.rentNotice.findFirst({
          where: { id: noticeId, organizationId: orgId },
          select: {
            id: true,
            noticeNumber: true,
            status: true,
            collectionStage: true,
            type: true,
            totalAmount: true,
            consumptionAmount: true,
            miscChargeAmount: true,
            reminderFeeAmount: true,
            interestAccruedAmount: true,
          },
        })
        if (!låst) throw new NotFoundException('Avi hittades inte')
        if (låst.status === RentNoticeStatus.CANCELLED) {
          throw new BadRequestException('Kan inte markera avbruten avi som betald')
        }
        if (låst.status === RentNoticeStatus.PAID) {
          throw new BadRequestException('Avin är redan betald')
        }

        // DEPOSIT omprövas MEDVETET inte här, till skillnad från status ovan.
        // Status är föränderlig — en annan process kan reglera eller avbryta avin
        // mellan preflight och lås, och därför måste den läsas om. `type` sätts vid
        // skapandet och ändras aldrig av någon skrivväg, så preflight-kontrollen
        // kan inte bli inaktuell på det sätt status kan.
        //
        // Och skulle den ändå kringgås finns ett andra, oberoende skydd:
        // createJournalEntryForRentNoticeManualPayment har en egen DEPOSIT-spärr
        // och returnerar null, vilket kastar och rullar tillbaka hela
        // transaktionen. Två skydd som inte delar förutsättning — luckan är alltså
        // inte nåbar, varken i dag eller om preflighten skulle flyttas.
        // (Verifierat i säkerhetsgranskningen av #108; skrivet här så nästa läsare
        // inte behöver härleda det på nytt.)

        // ── D5 (bank-härdning PR 3b): delbetalning lämnar avin OBETALD ──────────
        // Avgör om DENNA betalning reglerar avins OCR-skuld (ocrOutstanding ≤ 0,
        // EXKL. ränta — samma waterfall-grind som bankvägen och kravtrappan). Bara
        // full reglering → PAID; ett delbelopp registrerar allokering + delverifikat
        // men behåller status och kravsteg.
        const priorAllocs = await tx.rentNoticePayment.findMany({
          where: { rentNoticeId: noticeId },
          select: { amount: true },
        })
        const debtGrund = {
          type: låst.type,
          totalAmount: låst.totalAmount,
          consumptionAmount: låst.consumptionAmount,
          miscChargeAmount: låst.miscChargeAmount,
          reminderFeeAmount: låst.reminderFeeAmount,
          interestAccruedAmount: låst.interestAccruedAmount,
        }

        // ── H4: ÖVERBETALNING AVVISAS ───────────────────────────────────────
        //
        // Saknades här. En operatör kunde registrera 20 000 kr på en
        // 10 000-kronorsavi: hela beloppet allokerades, avin flippade PAID, och
        // verifikatet krediterade 1510 med 20 000 mot en fordran på 10 000 →
        // kundfordran MINUS 10 000. Fakturans manuella väg har haft spärren hela
        // tiden; den här vägen fick den aldrig.
        //
        // Samma assertion som fakturan anropar — inte en kopia. Regeln får finnas
        // på ETT ställe, annars divergerar de två formuleringarna med tiden.
        //
        // Prövas mot restskulden FÖRE den här betalningen, och INNANFÖR radlåset:
        // låg läsningen utanför kunde en samtidig bankmatchning skriva en
        // allokering emellan och göra kontrollen beräknad på inaktuell grund
        // (samma skäl som #288 på fakturasidan).
        //
        // `ocrOutstanding` (EXKL. ränta) är rätt nämnare: det är den skuld ett
        // OCR-betalningsflöde faktiskt reglerar, samma grind som bankvägen och
        // kravtrappan använder.
        const debtBefore = computeRentDebt({
          ...debtGrund,
          allocations: priorAllocs.map((a) => a.amount),
        })
        assertPaymentWithinDebt(
          new Prisma.Decimal(paidAmount),
          new Prisma.Decimal(debtBefore.ocrOutstanding),
        )

        const debtAfter = computeRentDebt({
          ...debtGrund,
          allocations: [...priorAllocs.map((a) => a.amount), paidAmount],
        })
        const completesNotice = debtAfter.ocrOutstanding <= 0

        // Status-guarden står kvar trots radlåset. Låset serialiserar, men guarden
        // uttrycker VILKA statusar som får ta emot en betalning — den skulle fånga
        // ett framtida anrop som når hit utan att ha passerat omläsningen ovan.
        const claim = await tx.rentNotice.updateMany({
          where: {
            id: noticeId,
            organizationId: orgId,
            status: {
              in: [
                RentNoticeStatus.PENDING,
                RentNoticeStatus.SENT,
                RentNoticeStatus.OVERDUE,
                RentNoticeStatus.FAILED,
              ],
            },
          },
          data: completesNotice
            ? {
                status: RentNoticeStatus.PAID,
                paidAt: paymentDate,
                paidAmount: debtAfter.paid,
                paymentMethod,
                // Betald avi lämnar kravtrappan. Nollställs i samma transaktion som
                // statusen — ingen kvarvarande INKASSO_READY på en betald avi.
                collectionStage: RentCollectionStage.NONE,
              }
            : {
                // D5 — delbetalning: behåll status och kravsteg, uppdatera bara
                // paidAmount-spegeln (Σ allokeringar) + senast använt betalsätt.
                paidAmount: debtAfter.paid,
                paymentMethod,
              },
        })
        if (claim.count === 0) {
          throw new ConflictException(
            'Avin är redan reglerad eller avbruten — uppdatera sidan och försök igen',
          )
        }

        // Allokeringen är den härledda spegeln av paidAmount; den rör inte huvudboken.
        const allocation = await tx.rentNoticePayment.create({
          data: {
            rentNoticeId: noticeId,
            bankTransactionId: null,
            amount: paidAmount,
            paidAt: paymentDate,
            source: 'MANUAL',
          },
        })

        // PR 3b (KRITISK): nyckla verifikatets idempotens på ALLOKERINGEN, inte avin —
        // annars bokförs en ANDRA manuell delbetalning aldrig (sourceId-kollision) och
        // 1510 understiger Σ allokeringar. Se createJournalEntryForRentNoticeManualPayment.
        const entry = await this.accounting.createJournalEntryForRentNoticeManualPayment(
          { id: låst.id, noticeNumber: låst.noticeNumber, type: låst.type },
          paidAmount,
          paymentDate,
          paymentMethod,
          orgId,
          createdById ?? null,
          allocation.id,
          tx,
        )
        // null = saknat likvidkonto/1510 → bokföringsfel, inte ett giltigt no-op.
        // Kastet rullar tillbaka HELA transaktionen: ingen allokering, ingen
        // statusflip. (DEPOSIT-avier når aldrig hit — de blockeras överst.)
        if (entry === null) {
          throw new InternalServerErrorException(
            `Betalningsverifikat kunde inte skapas för avi ${låst.noticeNumber} — ` +
              'kontrollera att kontoplanen innehåller konto 1510 och rätt likvidkonto.',
          )
        }

        return {
          completesNotice,
          noticeNumber: låst.noticeNumber,
          priorCollectionStage: låst.collectionStage,
        }
      },
      {
        // ── Varför explicita gränser på transaktionen (#108) ──────────────────
        //
        // Atomiciteten kostar låstid: radlåset hålls nu över ett tiotal tur-och-
        // retur mot databasen i stället för ett par. En annan betalning i samma
        // org väntar därför något längre på verifikationsnummer-sekvensen. Ingen
        // deadlock — låsordningen (avi → sekvens) är identisk i alla betalvägar —
        // men en svälten transaktion ska FAILA TYDLIGT (P2028) i stället för att
        // hänga. Samma fail-fast-princip som timeouterna mot R2-lagringen.
        //
        // Värdena är MÄTTA, inte gissade. 12 betalningar mot eken_dev MED SKARP
        // AccountingService: median 20,1 ms, långsammaste 35,6 ms. I produktion går
        // varje tur-och-retur över nätet i stället för loopback — räkna med en
        // storleksordning mer, alltså några hundra millisekunder i värsta fall.
        //
        // (Siffran som stod här när #289 mergades — median 8,8 ms — var mätt med
        // bokföringsanropet STUBBAT och utelämnade alltså dess rundor. Rättad i
        // #288, där samma mätfel upptäcktes på faktura-vägen. Valet av 8 s ändras
        // inte: det är fortfarande drygt hundrafalt över det uppmätta.)
        //
        //   timeout 8 s — drygt tjugofalt över det projicerade värsta fallet, och
        //     långt under den punkt där ett anrop läser som hängt. Något
        //     generösare än Prismas 5 s-default med flit: att avbryta en betalning
        //     som nästan är klar kostar mer än att vänta en stund till.
        //   maxWait 3 s — tid att få en anslutning ur poolen. Är poolen slut så
        //     länge är det ett systemfel som ska synas, inte köas.
        //
        // Höjs de här: höj för att en MÄTNING säger det, inte för att något
        // tajmade ut. Ett timeout som växer varje gång det slår är inget skydd.
        timeout: 8_000,
        maxWait: 3_000,
      },
    )

    // Bankavstämnings-härdning PR 2 — append-only trail för kravstegs-nollställningen
    // (endast om avin faktiskt var i kravtrappan OCH betalningen reglerade avin —
    // en delbetalning nollställer INTE kravsteget, så ingen trail då). Skrivs efter
    // lyckad bokning så noteringen aldrig avser en revertad betalning. Ingen bokföring rörs.
    //
    // Skrivs EFTER commit, med flit: en trail som skrivs innan transaktionen
    // committat kan överleva en rollback och beskriva något som aldrig hände.
    if (utfall.completesNotice && utfall.priorCollectionStage !== RentCollectionStage.NONE) {
      await this.prisma.rentNoticeEvent
        .create({
          data: {
            rentNoticeId: noticeId,
            type: 'NOTE_ADDED',
            actorType: createdById ? 'USER' : 'SYSTEM',
            ...(createdById ? { actorId: createdById } : { actorLabel: 'System' }),
            payload: {
              action: 'collection-stage-reset',
              from: utfall.priorCollectionStage,
              reason: 'paid',
            },
          },
        })
        .catch((trailErr) => {
          this.logger.error(
            `[Avisering] Kunde inte skriva kravstegs-trail för avi ${utfall.noticeNumber}: ` +
              `${trailErr instanceof Error ? trailErr.message : String(trailErr)}`,
          )
        })
    }

    return this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
  }

  async cancelNotice(noticeId: string, orgId: string, actorId?: string | null) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    if (notice.status === RentNoticeStatus.PAID) {
      throw new BadRequestException('Kan inte avbryta en betald avi')
    }
    // #367: CANCELLED → CANCELLED är ingen giltig övergång. Utan den här raden
    // — och utan `notIn` i claimen nedan — träffade claimen sin egen redan
    // annullerade rad, skrev om samma statusvärde och returnerade count 1, så
    // anroparen fick ett normalt svar på en händelse som inte inträffade.
    //
    // Att det inte kostade pengar berodde på att alla fyra reverseringsvägar är
    // idempotenta på sina `sourceId` — skyddet låg i BOKFÖRINGSLAGRET, inte i
    // statusmaskinen. En spärr som råkar hålla är ingen spärr; nästa väg som
    // läggs här behöver inte vara idempotent.
    //
    // FAILED utesluts INTE: en avi vars utskick misslyckats är precis en som
    // behöver kunna avbrytas.
    if (notice.status === RentNoticeStatus.CANCELLED) {
      throw new BadRequestException(
        `Avi ${notice.noticeNumber} är redan annullerad — ingen ytterligare åtgärd behövs.`,
      )
    }
    // En DELVIS betald avi får inte annulleras rakt av: motverifikatet reverserar
    // fordran, men den redan mottagna delbetalningen (RentNoticePayment + eget
    // likvidverifikat) skulle lämna en oadresserad kundkredit på 1510. Kräv att
    // betalningen hanteras först (avmatcha/återbetala) — människan bekräftar det
    // bindande (jfr [[project-bank-hardening-series]]).
    if (notice.paidAmount != null && Number(notice.paidAmount) > 0) {
      throw new BadRequestException(
        'Kan inte annullera en delvis betald avi — avmatcha eller återbetala den ' +
          'mottagna betalningen först.',
      )
    }

    // ── EN NEDSKRIVEN FORDRAN KAN INTE ANNULLERAS UNDER SIG SJÄLV ────────────
    //
    // DET HÄR ÄR EN SPÄRR MOT ETT PENNINGFEL, inte mot ett tillståndsfel.
    //
    // `reverseJournalEntryForRentNotice` speglar originalposten OVILLKORLIGT:
    // den slår upp `rent-notice:<id>`, byter debet↔kredit och krediterar 1510
    // med HELA kapitalbeloppet. Den frågar aldrig om fordran hunnit skrivas ned.
    //
    // Har `reclassifyToProbableLoss` körts först är 1510 redan tömd för den här
    // tråden: nedskrivningen bokför 1515 D / 1510 K på `debt.outstanding`, alltså
    // HELA kravet — kapital + förbrukning + övrig debitering + påminnelseavgift +
    // ränta, inte bara kapitalet (rent-bad-debt.service.ts, `amount = debt.outstanding`).
    // En annullering därefter krediterar 1510 en ANDRA gång:
    //
    //   1510 D <total>                    (avins accrual)
    //   1515 D <outstanding> / 1510 K     (nedskrivningen tömmer 1510)
    //   39xx D <total> / 1510 K           (annulleringens motverifikat)
    //   → 1510 NEGATIVT med exakt kapitalbeloppet, 1515 kvar med hela kravet
    //
    // Ett negativt kundfordringssaldo är inget en revisor kan stämma av mot
    // kundreskontran, och 1515 blir en öppen nedskrivning av en fordran som
    // formellt inte längre finns. Varje enskilt verifikat balanserar — felet
    // uppstår först i sekvensen, vilket är precis varför ingen enskild
    // verifikat-kontroll fångar det.
    //
    // GRINDEN LIGGER PÅ `probableLossAt`, ALDRIG PÅ STATUS. `WRITTEN_OFF` är ett
    // värde i `RentCollectionStage`, inte i `RentNoticeStatus` — en avskriven avi
    // står kvar med status OVERDUE och glider rakt genom PAID-kontrollen ovan.
    // `writtenOffAt` kontrolleras också: `confirmLoss` förutsätter en föregående
    // nedskrivning, men grinden ska vara fail-closed även om den ordningen
    // någon gång luckras upp.
    //
    // FAKTURASIDAN BERÖRS INTE — och det är MÄTT, inte antaget: `Invoice` saknar
    // `probableLossAt`, `writtenOffAt` och `collectionStage` helt, och
    // `RentBadDebtService` rör bara `rentNotice`/`journalEntry`/`user`. Hela
    // bad-debt-ytan är två avi-scopade endpoints. Får `Invoice` någon gång en
    // nedskrivningsväg MÅSTE samma grind in i `invoices.service.ts` i SAMMA PR —
    // invoices.bad-debt-drift.spec.ts faller den dagen fältet dyker upp.
    //
    // INGEN VÄG UT ÄNNU (#365): en avi som var felaktig redan från början och
    // sedan skrevs ned kan efter den här spärren varken annulleras eller rättas
    // via produktvägarna. Att lämna hålet öppet var inte ett alternativ — det
    // kostar pengar i huvudboken — men utvägen är ett eget ärende och kräver
    // FAR:s svar på om en befarad förlust över huvud taget får reverseras.
    if (notice.probableLossAt != null || notice.writtenOffAt != null) {
      throw new BadRequestException(
        `Avi ${notice.noticeNumber} kan inte annulleras — fordran är bokförd som ` +
          'kundförlust (1515/6352). En annullering skulle kreditera kundfordringar ' +
          'en andra gång. Hantera fordran via kundförlust-flödet i stället.',
      )
    }

    // Statusflip + motverifikat körs ATOMISKT. Intäkten bokades vid avi-genereringen
    // (1510 D / 39xx K / ev. 26xx K); en annullering MÅSTE reversera den, annars
    // kvarstår fantomintäkt + utgående moms (BFL 5 kap 5 §/9 §). Faller reverseringen
    // rullas hela annulleringen tillbaka — ingen CANCELLED-avi utan motverifikat.
    await this.prisma.$transaction(async (tx) => {
      // ── LÅSORDNING: DEPOSITION FÖRST (#296, #298, #299, #301) ───────────────
      //
      // Sedan #301 reverserar annulleringen även depositionens accrual, och då
      // måste vi serialisera mot en samtidig DepositsService.markPaid som kan
      // bokföra 1930 D / 1510 K mitt i vår transaktion. Utan låset läser markPaid
      // vår avi INNAN vi committat, ser den fortfarande öppen, och bokför:
      //
      //   T1 (cancelNotice) reverserar accrualen  →  avin CANCELLED
      //   T2 (markPaid)     läste avin som ÖPPEN  →  bokför 1930 D / 1510 K
      //   → 1510 krediterad två gånger mot en debet
      //
      // DET HÄR LÅSET ÄR LOAD-BEARING, till skillnad från syskonlåset i
      // invoices.service.ts. MÄTT (#301:s bevisrigg, S7): utan låset gav 22 av 30
      // parallella körningar dubbelkrediterad 1510 — TROTS att CANCELLED-grinden i
      // markPaid satt på plats. Grinden ensam räcker inte, eftersom den läser en
      // avi som hinner bli inaktuell. Med låset: 0 av 30. Och omvänt, med låset men
      // UTAN grinden: 28 av 30 fel. Båda behövs.
      //
      // ⚠️ RIKTNINGEN ÄR VALD MED FLIT, OCH DEN ÄR INTE DEN "SYMMETRISKA".
      //
      //   denna väg:  Deposit (lås här)     →  ...  →  RentNotice (updateMany)
      //   markPaid:   Deposit (claim)       →  ...  →  RentNotice (updateMany)
      //   bankvägen:  RentNotice (FOR UPDATE) →  ...  →  Deposit (updateMany)
      //
      // Vi ansluter till markPaid-sidan. Det är markPaid som HOTAR reverseringen,
      // och Deposit-först serialiserar direkt mot hotet. Lade vi låset efter
      // rentNotice-uppdateringen nedan (ordning RentNotice → Deposit, alltså
      // banksidan) skulle vi i stället få en ABBA mot markPaid — deadlock utan att
      // racet stängs. Det ser symmetriskt ut och är sämre.
      //
      // MOT BANKVÄGEN blir vi därmed motsatta, precis som markPaid redan är. Det
      // är samma konstruktion #299 skrev ned: krockar de sluts cirkeln och Postgres
      // dödar en av dem innan någon hunnit bokföra dubbelt. En bankmatchning och en
      // annullering av SAMMA depositionsavi ska inte båda gå igenom.
      //
      // #296:S SKYDD ÄR ORÖRT: det vilar på att bankvägen och markPaid går åt olika
      // håll. #301 vänder ingen av dem — den lägger bara till en väg på den sida
      // som redan finns. Vänder du ordningen här tänder du ett penningfel i en
      // annan kodväg än den du ändrar; läs #296/#298 först.
      const depositForNotice = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Deposit"
        WHERE "rentNoticeId" = ${noticeId} AND "organizationId" = ${orgId}
        FOR UPDATE`

      // Bankavstämnings-härdning PR 2 — en avbruten avi lämnar kravtrappan: nollställ
      // collectionStage till NONE ATOMISKT. updateMany med organizationId i WHERE
      // org-scopar uppdateringen (defense-in-depth mot ett läckt noticeId).
      const cancelled = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId: orgId,
          // #367: CANCELLED måste stå med. `{ not: PAID }` släppte igenom en
          // redan annullerad rad — förläsningen ovan sker utanför transaktionen
          // och kan hinna bli inaktuell, precis som för nedskrivningen nedan.
          status: { notIn: [RentNoticeStatus.PAID, RentNoticeStatus.CANCELLED] },
          // Nedskrivningsgrinden ligger ÄVEN här, inte bara i förläsningen ovan.
          // Den läsningen sker utanför transaktionen och kan hinna bli inaktuell:
          //
          //   T1 (cancelNotice) läser avin — probableLossAt är null, släpps igenom
          //   T2 (reclassifyToProbableLoss) låser, bokför 1515 D / 1510 K, commit
          //   T1 annullerar ändå → 1510 krediteras en andra gång
          //
          // Samma TOCTOU som #302 stängde på fakturasidan. Villkoret i claimen gör
          // fönstret verkningslöst: hann nedskrivningen före oss matchar inga rader.
          probableLossAt: null,
          writtenOffAt: null,
        },
        data: { status: RentNoticeStatus.CANCELLED, collectionStage: RentCollectionStage.NONE },
      })
      if (cancelled.count === 0) {
        // Claimen har tre skäl att missa. Läs om raden och säg vilket det var —
        // "redan reglerad" om nedskrivningen vann kapplöpningen vore ett felaktigt
        // besked om vad som hänt med fordran, och operatören skulle leta på fel
        // ställe. Läsningen sker i samma tx, efter claimen, så den ser sanningen.
        const aktuell = await tx.rentNotice.findFirst({
          where: { id: noticeId, organizationId: orgId },
          select: {
            probableLossAt: true,
            writtenOffAt: true,
            noticeNumber: true,
            // #367: statusen behövs för att skilja "annullerad av någon annan"
            // från "reglerad". Utan den föll båda ihop i ett besked som var fel
            // i det ena fallet.
            status: true,
          },
        })
        if (aktuell && (aktuell.probableLossAt != null || aktuell.writtenOffAt != null)) {
          throw new ConflictException(
            `Avi ${aktuell.noticeNumber} skrevs ned som kundförlust under annulleringen — ` +
              'annulleringen avbröts. Hantera fordran via kundförlust-flödet.',
          )
        }
        // #367: en parallell annullering hann före. Det är inte ett fel som
        // kräver åtgärd — resultatet operatören ville ha finns redan — men det
        // ska sägas rätt, inte som "redan reglerad" (vilket antyder betalning).
        if (aktuell?.status === RentNoticeStatus.CANCELLED) {
          throw new ConflictException(
            `Avi ${aktuell.noticeNumber} annullerades av någon annan under tiden — ` +
              'ingen ytterligare åtgärd behövs.',
          )
        }
        // En parallell process hann reglera avin mellan läsning och uppdatering.
        throw new ConflictException('Avin är redan reglerad — uppdatera sidan och försök igen')
      }

      // Motverifikat för avins INTÄKT (1510 D / 39xx K / ev. 26xx K). No-op för en
      // DEPOSIT-avi — den intäktsbokförs aldrig. Dess accrual hanteras nedan.
      await this.accounting.reverseJournalEntryForRentNotice(noticeId, orgId, actorId ?? null, tx)

      // ── A + B: AVGIFTEN OCH RÄNTAN BOR I EGNA NAMNRYMDER ────────────────────
      //
      // Raden ovan letar på `rent-notice:<id>` och vänder KAPITALET. Avins krav är
      // fem komponenter (computeRentDebt: kapital + förbrukning + övrig debitering
      // + avgift + ränta) fördelade på fem nyckelrymder i huvudboken. Utan de här
      // två anropen reverserade annulleringen en av dem, medan reskontran släppte
      // hela avin — avin lämnar `OverdueDebtService` (som bara läser OVERDUE) och
      // står som CANCELLED, samtidigt som 3593 och 8131 behåller sina intäkter med
      // bärande fordran kvar på 1510.
      //
      // Avgiften har SAMMA form på båda dokumenttyperna men olika `source`
      // (RENT_NOTICE här, INVOICE på fakturasidan) — därför skickas den in.
      // Räntan finns BARA här; fakturavägen kristalliserar aldrig ränta.
      //
      // Ordningen kapital → avgift → ränta är verifikationslistans läsordning och
      // speglar den ordning posterna uppstod. Bokföringsmässigt är den likgiltig
      // (alla tre är oberoende motverifikat i samma transaktion), men en granskare
      // som läser uppifrån och ner ska se kravet vändas i den ordning det byggdes.
      await this.accounting.reverseJournalEntryForReminderFee(
        'RENT_NOTICE',
        noticeId,
        orgId,
        'Annullerad hyresavi',
        actorId ?? null,
        tx,
      )
      await this.accounting.reverseJournalEntryForInterest(
        noticeId,
        orgId,
        'Annullerad hyresavi',
        actorId ?? null,
        tx,
      )

      // ── F + E: DEBITERINGARNA LOSSAS — BOKFÖRINGEN RÖRS ALDRIG ──────────────
      //
      // HÄR VÄNDER PRINCIPEN, OCH DET ÄR AVSIKTLIGT.
      //
      // Allt ovanför reverserar. Det här gör tvärtom, för att affärshändelsen är
      // av ett annat slag: elen levererades faktiskt, skadan skedde faktiskt.
      // Förbruknings- och övrigdebiteringen är bokförd på EGEN grund vid
      // debiteringstillfället (`consumption-charge:<id>` resp. `misc-charge:<id>`,
      // 1510 D / 3xxx|3990 K), oberoende av vilket dokument som senare presenterar
      // den för hyresgästen. Att reversera den vore att bokföringsmässigt påstå
      // att leveransen aldrig ägde rum. FAR:s ställningstagande i kartläggningen:
      // makulering betyder "detta dokument gäller inte", inte "affärshändelsen
      // ägde aldrig rum".
      //
      // MÄTT ATT DET ÄR SÄKERT: bokföringen utlöses vid CONFIRM (DRAFT→CONFIRMED),
      // aldrig vid påläggning. Ingen av de tre attach-vägarna
      // (attachRentNoticeLineCharges, attachMiscChargesToRentNotice,
      // invoiceSeparateCharges) rör AccountingService — noll träffar. En omlagd
      // charge bokförs därför inte en andra gång. Skulle någon ändå anropa
      // confirm igen är både `createJournalEntryForMiscCharge` och
      // `createJournalEntryForConsumptionCharge` idempotenta på sina sourceId.
      //
      // ⚠️ RADEN MÅSTE BORT, INTE BARA STATUSEN BYTAS.
      //
      // `RentNoticeLine.consumptionChargeId` och `.miscChargeId` är båda `@unique`.
      // Lämnas raden kvar kan chargen ALDRIG läggas på en ny avi — nästa
      // attach-körning gör `rentNoticeLine.create` med samma charge-id och far in
      // i unikhetsindexet. Statusen hade sagt CONFIRMED medan posten i praktiken
      // var lika inlåst som förut: samma limbo, bara ett annat ord i kolumnen.
      //
      // Att i stället nolla FK:n och behålla raden VALDES BORT: en rad utan vare
      // sig consumptionChargeId eller miscChargeId bryter XOR-invarianten
      // (`assertRentNoticeLineChargeXor`) och blir en föräldralös rad som inget
      // flöde vet vad den ska göra med.
      //
      // Beloppsfälten nollas i samma veva — annars påstår den annullerade avin
      // förbrukning och skadedebitering vars rader inte längre finns, och
      // `computeRentDebt` skulle räkna komponenter utan underlag.
      const chargeLines = await tx.rentNoticeLine.findMany({
        where: {
          rentNoticeId: noticeId,
          OR: [{ consumptionChargeId: { not: null } }, { miscChargeId: { not: null } }],
        },
        select: { id: true, consumptionChargeId: true, miscChargeId: true },
      })

      if (chargeLines.length > 0) {
        const consumptionIds = chargeLines
          .map((l) => l.consumptionChargeId)
          .filter((v): v is string => v != null)
        const miscIds = chargeLines.map((l) => l.miscChargeId).filter((v): v is string => v != null)

        // Villkorat på ATTACHED: en charge som hunnit bli CANCELLED av sin egen
        // annulleringsväg ska inte återuppstå som CONFIRMED här.
        if (consumptionIds.length > 0) {
          await tx.consumptionCharge.updateMany({
            where: { id: { in: consumptionIds }, organizationId: orgId, status: 'ATTACHED' },
            data: { status: 'CONFIRMED' },
          })
        }
        if (miscIds.length > 0) {
          await tx.miscCharge.updateMany({
            where: { id: { in: miscIds }, organizationId: orgId, status: 'ATTACHED' },
            data: { status: 'CONFIRMED' },
          })
        }

        await tx.rentNoticeLine.deleteMany({ where: { id: { in: chargeLines.map((l) => l.id) } } })
        await tx.rentNotice.updateMany({
          where: { id: noticeId, organizationId: orgId },
          data: { consumptionAmount: 0, miscChargeAmount: 0 },
        })
      }

      // ── #301: DEPOSITIONSAVINS ACCRUAL LIGGER I EN ANNAN NAMNRYMD ───────────
      //
      // En DEPOSIT-avi bokförs sedan #41 ALLTID: ensureDepositForNotice skapar
      // Deposit-raden och 1510 D / 2890 K i samma transaktion, under
      // `deposit-invoice:<depositId>`. Raden ovan letar på `rent-notice:<id>` och
      // kan därför aldrig träffa den — inte för att posten är fel-nycklad, utan
      // för att den bor i en annan namnrymd, nycklad på DEPOSITIONENS id.
      //
      // Utan det här anropet stod fordran och skulden kvar öppna efter en
      // annullering (BFL 5 kap 6 §). Kommentaren på den gamla raden ovan påstod
      // att no-op:en var korrekt "DEPOSIT-avi som aldrig intäktsbokfördes" — sant
      // före #41, fel sedan dess. Se accounting.service.ts för samma rättelse.
      //
      // Depositionen är redan låst högst upp i transaktionen; statusen läses här,
      // innanför låset, av samma skäl som markPaid läser restskulden innanför sitt.
      if (depositForNotice.length > 0) {
        const deposit = await tx.deposit.findFirst({
          where: { rentNoticeId: noticeId, organizationId: orgId },
          select: { id: true, status: true },
        })

        // SPÄRR: reversera BARA en oreglerad deposition.
        //
        // Avins status === PAID stoppas redan ovan, men den spegeln räcker inte.
        // markPaids avi-gren claimar depositionen FÖRST och flippar sedan avin med
        // `status in (SENT, PENDING, OVERDUE)`. RentNoticeStatus har sex värden —
        // FAILED ingår inte. En depositionsavi som fastnat i FAILED (misslyckat
        // utskick) kan alltså stå kvar medan depositionen är PAID, och släpps då
        // igenom PAID-grinden ovan. Utan den här kontrollen skulle vi reversera en
        // accrual vars 1930 D / 1510 K redan är bokförd → 1510 krediterad två
        // gånger. Vi grindar därför på depositionens EGEN status, inte på avins.
        if (deposit && deposit.status === 'PENDING') {
          await this.accounting.reverseJournalEntryForDepositAccrual(
            deposit.id,
            orgId,
            'Annullerad hyresavi',
            actorId ?? null,
            tx,
          )
        }
      }
    })

    // Append-only trail för kravstegs-nollställningen (endast om avin var i trappan).
    // Efter commit — best effort, påverkar inte den bokförda annulleringen.
    if (notice.collectionStage !== RentCollectionStage.NONE) {
      await this.prisma.rentNoticeEvent
        .create({
          data: {
            rentNoticeId: noticeId,
            type: 'NOTE_ADDED',
            actorType: resolveActorType('SYSTEM'),
            actorLabel: 'System',
            payload: {
              action: 'collection-stage-reset',
              from: notice.collectionStage,
              reason: 'cancelled',
            },
          },
        })
        .catch((trailErr) => {
          this.logger.error(
            `[Avisering] Kunde inte skriva kravstegs-trail (avbruten) för avi ${notice.noticeNumber}: ` +
              `${trailErr instanceof Error ? trailErr.message : String(trailErr)}`,
          )
        })
    }

    return this.prisma.rentNotice.findFirst({ where: { id: noticeId, organizationId: orgId } })
  }

  /**
   * G4a — STRYK EN FELAKTIGT DEBITERAD PÅMINNELSEAVGIFT, utan att röra avin i
   * övrigt.
   *
   * ── VARFÖR FUNKTIONEN BEHÖVS ────────────────────────────────────────────
   *
   * Fram till nu fanns ingen väg att ta bort en avgift utan att ANNULLERA HELA
   * AVIN — vilket också reverserar hyresintäkten och räntan och tar bort ett
   * dokument som i övrigt är korrekt. Det vanligaste fallet uppstår av sig
   * självt: hyresgästen betalade i tid, men överföringen var inte matchad när
   * cronen körde (avgiftsvägen grindar på `debt.ocrOutstanding`, alltså på
   * REGISTRERAD betalning). Avgiften tas, och när betalningen sedan matchas
   * täcker den bara kapitalet — avin stannar i OVERDUE för 60 kr hyresgästen
   * aldrig skulle ha krävts på.
   *
   * ── RÄTTELSE, INTE EFTERGIFT ────────────────────────────────────────────
   *
   * FAR:s prövning är EN fråga, inte fyra fall: var avgiften en giltig fordran
   * givet de FAKTISKA förhållandena vid debiteringstillfället — oavsett vad
   * systemet trodde då? Nej → rättelse av fel, och motverifikatet speglar
   * originalet (3593 D / 1510 K).
   *
   * Ja → EFTERGIFT av en giltig fordran, vilket är en annan affärshändelse med
   * annan kontering: att reversera 3593 skulle påstå att intäkten aldrig
   * funnits, vilket är osant, och snedvrider en annan periods
   * intäktsredovisning om eftergiften sker senare. Den vägen (G4b) är INTE
   * byggd — FAR:s kontoförslag (6352) är uttryckligen en bedömning som ska
   * verifieras av människa först. Den här funktionen är rättelsen, och bara den.
   *
   * ── DEN ARITMETISKA GRÄNSEN ─────────────────────────────────────────────
   *
   * Strykningen minskar kravet. Är kravet redan täckt av betalning uppstår en
   * ÖVERBETALNING — och `computeRentDebt` klampar med `Math.max(0, …)`, så
   * mellanskillnaden blir noll på varje yta och pengarna hos hyresvärden blir
   * osynliga (#378).
   *
   * Gränsen är därför aritmetisk, inte beskrivande: strykningen tillåts bara när
   * den INTE KAN skapa en överbetalning, alltså `paid <= ocrGross - avgiften`.
   * Att i stället vägra på `paid > 0` hade varit meningslöst — huvudfallet ovan
   * har ALLTID en registrerad betalning; det är just den som avslöjar att
   * avgiften var felaktig.
   *
   * ── VAD SOM SKER ATOMISKT ───────────────────────────────────────────────
   *
   * Motverifikat, nollad reskontramarkering och händelse i EN transaktion. En
   * reversering i huvudboken utan att nolla `reminderFeeAmount` ger exakt den
   * divergens #357 stängde, med omvänt tecken: avin fortsätter kräva 60 kr som
   * huvudboken inte längre bär.
   *
   * SAMMA REVERSAL-NYCKEL som `cancelNotice` använder
   * (`reminder-fee-reversal:<id>`). Annulleras avin senare hittar dess
   * reversering den befintliga posten via idempotensen och skriver ingen
   * dubblett — hade G4a valt en egen nyckel skulle 3593 debiterats två gånger.
   */
  async reverseReminderFee(
    noticeId: string,
    orgId: string,
    reason: string,
    actorId: string | null,
    // Den faktiska människan när handlingen sker via impersonation. Sparas i
    // händelsen — INTE i verifikatets createdById, som fortfarande namnger
    // org-användaren. Se `impersonatorOf` och ärende #379.
    impersonatedById: string | null = null,
  ) {
    const trimmedReason = reason?.trim() ?? ''
    if (trimmedReason.length < REMINDER_FEE_REVERSAL_REASON_MIN_LENGTH) {
      throw new BadRequestException(
        `Ange varför avgiften stryks (minst ${REMINDER_FEE_REVERSAL_REASON_MIN_LENGTH} tecken). ` +
          'Skälet blir motverifikatets beskrivning i huvudboken och går inte att ändra efteråt.',
      )
    }

    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: { payments: { select: { amount: true } } },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    const fee = Number(notice.reminderFeeAmount)
    if (!(fee > 0)) {
      throw new BadRequestException('Avin bär ingen påminnelseavgift att stryka')
    }

    // Samma spärr som cancelNotice, av samma skäl: `reclassifyToProbableLoss`
    // har flyttat HELA kravet — inklusive avgiften — till 1515. Att kreditera
    // 1510 för avgiften här skulle kreditera en post som redan flyttats.
    if (notice.probableLossAt != null || notice.writtenOffAt != null) {
      throw new BadRequestException(
        `Avi ${notice.noticeNumber} är bokförd som kundförlust — avgiften ingår i ` +
          'nedskrivningen och kan inte strykas separat. Hantera fordran via ' +
          'kundförlust-flödet.',
      )
    }

    // ── DEN ARITMETISKA GRÄNSEN, räknad ur allokeringarna ────────────────
    const ocrGross =
      Number(notice.totalAmount) +
      Number(notice.consumptionAmount) +
      Number(notice.miscChargeAmount) +
      fee
    const paid = notice.payments.reduce((sum, p) => sum + Number(p.amount), 0)
    const takWithoutFee = round2(ocrGross - fee)
    if (paid > takWithoutFee) {
      throw new BadRequestException(
        `Avgiften kan inte strykas: betalt belopp (${paid} kr) överstiger kravet utan ` +
          `avgiften (${takWithoutFee} kr), så strykningen skulle skapa en överbetalning ` +
          `på ${round2(paid - takWithoutFee)} kr. Överbetalning kan i dag inte visas ` +
          '(se ärende #378) — avmatcha eller återbetala betalningen först.',
      )
    }

    await this.prisma.$transaction(async (tx) => {
      // Villkorat anspråk: nollställningen får bara ske från det belopp vi läste,
      // annars kan en samtidig eskalering ha ändrat avgiften under oss.
      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId: orgId,
          probableLossAt: null,
          writtenOffAt: null,
          reminderFeeAmount: notice.reminderFeeAmount,
        },
        // Literal 0 — matchar `isZeroing` i CI-vakten från #375, som släpper
        // igenom nollställning utan predikat eftersom den aldrig kan
        // överdebitera. Ett beräknat värde hade fällt vakten, och rätteligen så.
        data: { reminderFeeAmount: 0 },
      })
      if (claim.count === 0) {
        throw new ConflictException(
          'Avgiften ändrades under strykningen — uppdatera sidan och försök igen',
        )
      }

      await this.accounting.reverseJournalEntryForReminderFee(
        'RENT_NOTICE',
        noticeId,
        orgId,
        `Struken påminnelseavgift (${trimmedReason})`,
        actorId,
        tx,
      )

      // Utan händelsen är åtgärden osynlig: till skillnad från VOID ändras ingen
      // status på dokumentet som förklarar varför beloppet försvann.
      await this.rentNoticeEvents.record(
        noticeId,
        'REMINDER_FEE_REVERSED',
        actorId ? 'USER' : 'SYSTEM',
        actorId,
        {
          amount: fee,
          reason: trimmedReason,
          ...(impersonatedById ? { impersonatedBy: impersonatedById } : {}),
        },
        { tx },
      )
    })

    return this.prisma.rentNotice.findFirst({ where: { id: noticeId, organizationId: orgId } })
  }

  async checkAndMarkOverdue(orgId: string) {
    const now = new Date()
    const overdue = await this.prisma.rentNotice.findMany({
      where: {
        organizationId: orgId,
        status: { in: [RentNoticeStatus.PENDING, RentNoticeStatus.SENT] },
        dueDate: { lt: now },
      },
    })

    if (overdue.length > 0) {
      await this.prisma.rentNotice.updateMany({
        where: { id: { in: overdue.map((n) => n.id) } },
        data: { status: RentNoticeStatus.OVERDUE },
      })
    }

    return overdue
  }

  async findAll(
    orgId: string,
    filters?: {
      month?: number
      year?: number
      status?: RentNoticeStatus
      search?: string
      tenantId?: string
    },
  ) {
    await this.checkAndMarkOverdue(orgId)

    // Fritext-sök på hyresgäst (för-/efter-/företagsnamn) + OCR/avinummer.
    // Speglar tenants.service.findAll. När sök används utelämnar frontend
    // månad/år så hela hyresgästens historik visas över alla perioder.
    const search = filters?.search?.trim()

    return this.prisma.rentNotice.findMany({
      where: {
        organizationId: orgId,
        ...(filters?.month ? { month: filters.month } : {}),
        ...(filters?.year ? { year: filters.year } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(search
          ? {
              OR: [
                { tenant: { firstName: { contains: search, mode: 'insensitive' } } },
                { tenant: { lastName: { contains: search, mode: 'insensitive' } } },
                { tenant: { companyName: { contains: search, mode: 'insensitive' } } },
                { ocrNumber: { contains: search, mode: 'insensitive' } },
                { noticeNumber: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
      },
      // Interna infrastrukturfält ska aldrig nå klienten (security-auditor MEDIUM):
      // R2-lagringsnyckeln och Resends message-id är inte presigned URL:er och har
      // ingen frontend-användning — exponera dem inte för VIEWER m.fl.
      omit: { reminderPdfStorageKey: true, reminderMessageId: true },
      orderBy: { dueDate: 'desc' },
    })
  }

  async findOne(noticeId: string, orgId: string) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
      },
      // Interna fält döljs för klienten (se findMany ovan).
      omit: { reminderPdfStorageKey: true, reminderMessageId: true },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    return notice
  }

  async getStats(orgId: string, month: number, year: number) {
    await this.checkAndMarkOverdue(orgId)

    const [grouped, aggregate] = await Promise.all([
      this.prisma.rentNotice.groupBy({
        by: ['status'],
        where: { organizationId: orgId, month, year },
        _count: true,
      }),
      this.prisma.rentNotice.aggregate({
        where: { organizationId: orgId, month, year },
        _sum: { totalAmount: true, paidAmount: true },
        _count: true,
      }),
    ])

    const byStatus: Record<string, number> = {}
    for (const g of grouped) {
      byStatus[g.status] = g._count
    }

    const totalAmount = Number(aggregate._sum.totalAmount ?? 0)
    const paidAmount = Number(aggregate._sum.paidAmount ?? 0)

    return {
      total: aggregate._count,
      pending: byStatus['PENDING'] ?? 0,
      sent: byStatus['SENT'] ?? 0,
      paid: byStatus['PAID'] ?? 0,
      overdue: byStatus['OVERDUE'] ?? 0,
      cancelled: byStatus['CANCELLED'] ?? 0,
      totalAmount,
      paidAmount,
      outstandingAmount: totalAmount - paidAmount,
    }
  }
}
