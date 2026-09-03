import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import {
  Prisma,
  RentNoticeType,
  UserRole,
  type RentNotice,
  type RentNoticeEventType,
} from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { runCronSafely } from '../common/cron/cron-safety'
import { MailService } from '../mail/mail.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { QUEUE_PDF } from '../pdf-jobs/pdf.types'
import { enqueueSafely, isEnqueueProblem } from '../common/queue/enqueue-safety'
import { AccountingService } from '../accounting/accounting.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { rentNoticeOutstanding } from './rent-debt.service'
import { getLogoDataUrl } from './avisering.service'
import { buildBrandedPdfHtml, escapeHtml } from '../common/branding'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentInterestService } from './rent-interest.service'
import { RentDebtService } from './rent-debt.service'
import { resolveNoticeDebtOrigin } from '../accounting/debt-origin'
import { resolveReminderFee, reminderFeeCapMessage } from '../accounting/reminder-fee'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { bedömOmsändning, hashaAdress } from './resend-verdict'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { NotificationsService } from '../notifications/notifications.service'

interface ReminderSummary {
  reminded: number
  skipped: number
  errors: number
  /** PR 4 (B) — avier vars eskalering pausats pga inaktuell betalningsdata. */
  pausedStale: number
}

interface InkassoReadySummary {
  ready: number
  blocked: number
  skipped: number
  errors: number
  pausedStale: number
  /** #648 — avier som passerat larmtröskeln och fått sitt ENDA larm denna period. */
  alerted: number
}

// Avin med precis de relationer INV-B-grinden behöver för att avgöra om
// dokumentationen är komplett (gäldenär + fordringsägare). Org redan verifierad
// av anroparen (findFirst på organizationId) innan grinden körs.
/**
 * VARFÖR EN AVI STÅR STILL — cronets tre vägar vidare, som ETT värde.
 *
 * `escalateOverdueToInkassoReady` går vidare på tre sätt och bara ett av dem
 * lämnar ett spår i avins logg. Utan den här uppräkningen är "väntar",
 * "pausad" och "fastnat" samma tystnad för den som tittar.
 */
export type RentCollectionState =
  /** Kravtrappan är inte i det steg där eskaleringen prövas. */
  | 'NOT_APPLICABLE'
  /** Organisationen har stängt av påminnelser helt. */
  | 'REMINDERS_OFF'
  /** Betalningsdatan är inaktuell — kravtrappan är PAUSAD (INV-B). */
  | 'PAUSED_STALE'
  /** Under tröskeln. Väntar legitimt, och det finns ett datum. */
  | 'WAITING'
  /** Tröskeln passerad, men INV-B saknar något. Står stilla. */
  | 'BLOCKED'
  /** Inget saknas — nästa körning flyttar fram den. */
  | 'READY'

export interface RentCollectionStatus {
  state: RentCollectionState
  collectionStage: RentNotice['collectionStage']
  /** INV-B:s saknade krav. FYLLS ALLTID, oavsett `state`. */
  missing: string[]
  daysOverdue: number
  thresholdDays: number
  daysUntilEvaluation: number
  freshness: {
    stale: boolean
    through: Date | null
    /** null när organisationen aldrig matat in betalningsdata. */
    ageDays: number | null
    thresholdDays: number
  }
  /** AVINS och PÅMINNELSENS leverans är SKILDA fält. Se #651. */
  delivery: {
    noticeSentAt: Date | null
    noticeDeliveredAt: Date | null
    noticeBouncedAt: Date | null
    reminderSentAt: Date | null
    reminderDeliveredAt: Date | null
    reminderBouncedAt: Date | null
    sendFailedAt: Date | null
  }
  lastBlockedAt: Date | null
  blockedDays: number | null
  /**
   * Omsändningen av påminnelsen (#656). Beräknad HÄR och inte i gränssnittet:
   * grindarna bär pengar och får inte finnas i två uppsättningar.
   */
  resend: {
    allowed: boolean
    /** Varför inte. Null när den är tillåten. Visas som knappens förklaring. */
    blockedReason: string | null
    senasteUtskickId: string | null
    /**
     * Har adressen ändrats sedan utskicket studsade?
     *
     * `null` = VET EJ, och det är ett eget svar: utskicket skrevs innan
     * fingeravtrycket fanns, eller hyresgästen saknar adress. Gränssnittet
     * säger "vet ej" i stället för att gissa — ett falskt lugn här skickar ett
     * brev till samma trasiga adress.
     */
    addressChangedSinceBounce: boolean | null
  }
}

/**
 * HUR LÄNGE FÅR EN AVI STÅ BLOCKERAD INNAN NÅGON FÅR VETA? — #648
 *
 * PRODUKTBESLUT, ÄNDRAS HÄR. Sju dygn är valt mot fristen: en avi prövas först
 * `rentReminderDay + rentInkassoDaysAfterReminder` dygn efter förfall (default
 * 7 + 14 = 21), och blockeras därefter varje dygn utan att något syns.
 * En vecka är kort nog att adressen hinner rättas innan kravet fastnar på
 * riktigt, och långt nog att en leveranskvittens som dröjer ett dygn eller två
 * inte larmar i onödan.
 *
 * Talet står HÄR och inte i en `Organization`-kolumn med flit: det är ett
 * produktbeslut om när VI säger till, inte en avtalsfrist per hyresvärd. Blir
 * det senare en inställning hör den hemma bredvid `rentInkassoDaysAfterReminder`
 * i schemat — och då ska den här konstanten bli dess default, inte leva vid
 * sidan av den.
 */
export const BLOCKERAD_AVI_LARMTROSKEL_DAGAR = 7

const INKASSO_READY_INCLUDE = {
  // personalNumberHash, inte personnumret: grinden ska bara veta OM gäldenären
  // har ett registrerat personnummer. Blind-indexet svarar på det utan att en
  // enda rad dekrypteras.
  tenant: { select: { ...SAFE_TENANT_SELECT, personalNumberHash: true } },
  organization: true,
} satisfies Prisma.RentNoticeInclude

type InkassoReadyNotice = Prisma.RentNoticeGetPayload<{ include: typeof INKASSO_READY_INCLUDE }>

const REMINDER_NOTICE_INCLUDE = {
  tenant: { select: SAFE_TENANT_SELECT },
  lease: { include: { unit: { include: { property: true } } } },
  lines: true,
  // ── #344: RESTSKULDEN GÅR INTE ATT RÄKNA UTAN ALLOKERINGARNA ──────────────
  //
  // Brevet krävde `rentNoticePayableTotal` — bruttot. Betalade hyresgästen
  // 4 000 av 9 000 kom nästa morgon ett formellt krav på 9 000.
  //
  // Systemet VISSTE redan vad som återstod: eskaleringsgrinden läser
  // `ocrOutstanding` några rader tidigare, just för att avgöra om påminnelsen
  // ska skickas alls — och skickade sedan bruttot ändå.
  payments: { select: { amount: true } },
  // ── #518: OCH INTE HELLER UTAN KREDITERINGARNA ───────────────────────────
  //
  // Exakt samma defekt en nivå till: krediterades 3 000 av 9 000 hade brevet
  // krävt 9 000 för en fordran hyresgästen bevisligen inte har. Krediteringen
  // redovisas som en EGEN avdragsrad i brevet, skild från betalningen — en
  // nedsättning och en inbetalning säger olika saker till mottagaren.
  credits: { select: { amount: true } },
} satisfies Prisma.RentNoticeInclude

type ReminderNotice = Prisma.RentNoticeGetPayload<{ include: typeof REMINDER_NOTICE_INCLUDE }>

/**
 * Inkasso PR 2 — hyrespåminnelse. En förfallen (OVERDUE) hyresavi eskaleras på
 * dag `rentReminderDay` (default 7, konfigurerbar per org) till kravsteget
 * REMINDED: en konfigurerbar, MOMSFRI påminnelseavgift bokförs ATOMISKT
 * (1510 D / 3593 K) och en påminnelse-PDF köas för utskick.
 *
 * Ingen ränta, ingen inkasso — de hör till PR 3 resp. PR 4.
 */
@Injectable()
export class RentReminderService {
  private readonly logger = new Logger(RentReminderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly rentNoticeEvents: RentNoticeEventsService,
    private readonly rentInterest: RentInterestService,
    private readonly pdfQueue: PdfQueue,
    private readonly mailService: MailService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
    // Bankavstämnings-härdning PR 3a — INV-A: kravstegsövergångar gatar på FAKTISK
    // skuld (allokeringsderiverad), inte på status/paidAmount-cache.
    private readonly rentDebt: RentDebtService,
    // Bankavstämnings-härdning PR 4 (B) — pausa pengamodifierande/inkasso-
    // framflyttande eskalering + larma när orgens betalningsdata är inaktuell.
    private readonly freshness: PaymentFreshnessService,
    // #605 — varaktig felsänka. SIST i listan: nya beroenden läggs till på
    // slutet så befintliga positionsanrop inte tyst byter betydelse.
    private readonly cronErrors: CronErrorSink,
    // #648 — larmet om en avi som fastnat. SIST, av samma skäl som raden ovan.
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Daglig cron (kl 10:00 — efter att markOverdueRentNotices kl 09:00 hunnit
   * flippa förfallna avier till OVERDUE). Eskalerar varje OVERDUE-hyresavi som
   * passerat sin organisations rentReminderDay och ännu inte påmints.
   *
   * Idempotent: kravsteget filtreras på collectionStage=NONE, och själva
   * eskaleringen är race-säker (se escalateNoticeToReminded). En betalning före
   * dag 7 gör avin PAID (inte OVERDUE) → faller ur urvalet, ärendet dör.
   */
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // RentNotice updateMany-claim på (status=OVERDUE, collectionStage=NONE);
  // count=0 → escalateNoticeToReminded returnerar false utan att boka
  // påminnelseavgift eller skicka.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('0 10 * * *')
  async escalateOverdueRentNotices(): Promise<ReminderSummary> {
    const summary: ReminderSummary = { reminded: 0, skipped: 0, errors: 0, pausedStale: 0 }

    // T5 B1b — linda hela cron-kroppen: en DB-blipp på findMany/freshness larmar
    // nu via Sentry istället för tyst död. Per-avi-isoleringen (try/catch nedan),
    // pausStale-grinden och summeringen är OFÖRÄNDRADE — summary muteras in-place
    // och returneras nedan.
    await runCronSafely(
      'rent-reminder-escalate-overdue',
      async () => {
        const candidates = await this.prisma.rentNotice.findMany({
          where: {
            status: 'OVERDUE',
            type: RentNoticeType.RENT,
            collectionStage: 'NONE',
            // T1.4 / #44: efterdebiterade avier EXKLUDERAS från kravtrappans
            // auto-eskalering (JB 12 kap 42 §, oskälighet). En hyresgäst får aldrig
            // påminnelse/ränta/inkasso automatiskt för hyresvärdens sena
            // registrering — dessa släpps in i normalflödet först vid manuell
            // granskning (framtida PR). Enda auto-ingången till trappan är detta
            // urval → en filter här isolerar hela trappan (ränta kristalliseras bara
            // härifrån).
            isBackfill: false,
            organization: { remindersEnabled: true },
          },
          include: {
            organization: true,
            tenant: { select: SAFE_TENANT_SELECT },
            // G2: avtalsgrunden för påminnelseavgiften bor på avtalet.
            lease: { select: { reminderFeeTermsFrom: true } },
          },
        })

        // PR 4 (B) — pausa (och larma) eskaleringen för org vars betalningsdata är
        // inaktuell: påminnelseavgiften FLYTTAR FRAM kravet och tar betalt, så den får
        // inte rulla mot en hyresgäst som kan ha betalat utan att avstämningen vet det.
        const staleOrgs = await this.freshness.evaluateAndAlert(
          candidates.map((n) => n.organizationId),
        )

        for (const notice of candidates) {
          try {
            if (staleOrgs.has(notice.organizationId)) {
              summary.pausedStale++
              continue
            }
            const daysOverdue = this.daysSince(notice.dueDate, new Date())
            if (daysOverdue < notice.organization.rentReminderDay) {
              summary.skipped++
              continue
            }
            // INV-A (PR 3a): eskalera bara om det finns en OCR-reglerbar restskuld
            // (hyra/förbrukning) att påminna om. ocrOutstanding EXKLUDERAR ränta — ren
            // restränta driver aldrig kravtrappans framdrift (D1). En fullt reglerad
            // avi (ocrOutstanding ≤ 0) eskalerar ALDRIG. Läses från den allokerings-
            // derivade sanningskällan, inte status/paidAmount-cache. Ren läsning.
            const debt = await this.rentDebt.outstanding(notice.id, notice.organizationId)
            if (debt.ocrOutstanding <= 0) {
              summary.skipped++
              continue
            }
            // Ingen leveransbar adress → ta ALDRIG ut avgiften (en påminnelseavgift
            // förutsätter att en påminnelse kan skickas). Avin förblir NONE och
            // omprövas nästa dygn.
            if (!notice.tenant.email) {
              summary.skipped++
              continue
            }

            const fee = Number(notice.organization.reminderFeeSek)
            const escalated = await this.escalateNoticeToReminded(
              notice.id,
              notice.organizationId,
              daysOverdue,
              fee,
            )
            if (!escalated) {
              summary.skipped++
              continue
            }

            // Kristallisera upplupen dröjsmålsränta t.o.m. påminnelsedagen (PR 3).
            // Egen atomisk transaktion; ett räntefel ska INTE fälla påminnelsen —
            // avgiften är redan tagen och räntan fångas vid nästa kristalliserings-
            // punkt (inkasso-ready, PR 4) via delta-beräkningen.
            try {
              await this.rentInterest.crystallizeInterest(
                notice.id,
                notice.organizationId,
                new Date(),
              )
            } catch (err) {
              this.logger.error(
                `Räntekristallisering misslyckades för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
              )
            }

            // Avgift + kravsteg är nu bokförda atomiskt. Köa påminnelse-PDF:en — om
            // utskicket fallerar är avgiften ändå korrekt tagen (samma mönster som
            // faktura-/avi-flödet); leveransstatus loggas av jobbet.
            //
            // T5 C2a (#58): pengaställe — avgiften ÄR bokförd, så om köandet
            // fallerar tyst debiteras hyresgästen en påminnelseavgift utan att
            // någon påminnelse går ut. enqueueSafely larmar (Sentry) och golvar
            // väntetiden; utfallet räknas som fel, precis som ett kast gjorde
            // förut (enqueueSafely kastar inte).
            const outcome = await enqueueSafely(
              () =>
                this.pdfQueue.enqueue({
                  kind: 'avisering-reminder',
                  organizationId: notice.organizationId,
                  noticeId: notice.id,
                }),
              {
                queue: QUEUE_PDF,
                jobType: 'avisering-reminder',
                organizationId: notice.organizationId,
                logger: this.logger,
                // #605 — CRON-ONLY väg: kontexten lämnas av anroparen, hjälparen
                // gissar aldrig. enqueueSafely kastar inte, så det yttre
                // runCronSafely ser aldrig felet — raden skrivs här, exakt en.
                cron: { name: 'rent-reminder-escalate-overdue', sink: this.cronErrors },
              },
            )
            if (isEnqueueProblem(outcome)) {
              summary.errors++
              continue
            }
            summary.reminded++
          } catch (err) {
            this.logger.error(
              `Påminnelse misslyckades för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
            )
            summary.errors++
          }
        }

        this.logger.log(
          `Hyrespåminnelser: ${summary.reminded} skickade, ${summary.skipped} hoppades över, ` +
            `${summary.pausedStale} pausade (inaktuell betalningsdata), ${summary.errors} fel`,
        )
      },
      { logger: this.logger, sink: this.cronErrors },
    )
    return summary
  }

  /**
   * Atomisk eskalering NONE → REMINDED med påminnelseavgift.
   *
   * INV-A: avgiftens markering (reminderFeeAmount, kravsteg) och dess verifikat
   * (1510 D / 3593 K) skapas i SAMMA transaktion. Faller bokföringen kastas felet
   * och hela transaktionen — inklusive kravstegsövergången — rullas tillbaka, så
   * en avgift aldrig kan tas ut utan verifikat.
   *
   * Idempotent + race-säker via en updateMany-claim på (OVERDUE, stage=NONE):
   * bara EN körning kan flippa avin, en dubbel cron-fire eller retry ger claim
   * count=0 och returnerar false utan att boka en andra avgift.
   *
   * fee=0 (org har konfigurerat bort avgiften) → ingen bokföring, men avin
   * eskaleras och påminnelsen skickas ändå.
   */
  async escalateNoticeToReminded(
    noticeId: string,
    organizationId: string,
    daysOverdue: number,
    fee: number,
  ): Promise<boolean> {
    const now = new Date()

    return this.prisma.$transaction(async (tx) => {
      // ── G2: AVGIFTENS BELOPP AVGÖRS FÖRE ANSPRÅKET ──────────────────────
      //
      // Måste ske före `updateMany` nedan, inte efter: anspråket skriver
      // `reminderFeeAmount` i reskontran, och vägrade grinden först i
      // bokföringen skulle avin kräva 60 kr som huvudboken inte bär — samma
      // divergens som #357 stängde, med omvänt tecken.
      //
      // Datumet konstrueras ALDRIG här. `resolveNoticeDebtOrigin` äger regeln
      // (tidigaste av periodStart och dueDate, null om periodStart saknas),
      // och dess brandade returtyp är det enda `bookReminderFee` accepterar.
      const grund = await tx.rentNotice.findFirstOrThrow({
        where: { id: noticeId, organizationId },
        select: {
          periodStart: true,
          dueDate: true,
          lease: { select: { reminderFeeTermsFrom: true } },
        },
      })
      const debtOrigin = resolveNoticeDebtOrigin(grund)
      const termsFrom = grund.lease?.reminderFeeTermsFrom ?? null

      // BÅDA reglerna besvaras här: avtalsgrunden OCH det lagstadgade taket.
      // Saknas avtalsgrund blir avgiften 0 — påminnelsen går ut ändå, för
      // hyresgästen ska påminnas om sin obetalda hyra; hen ska bara inte
      // debiteras för det utan att ha godkänt villkoret. Ligger ett för högt
      // belopp i `Organization.reminderFeeSek` klampas det till taket, så att
      // reskontran nedan och verifikatet längre ner bär SAMMA tal.
      const feeDecision = resolveReminderFee(fee, debtOrigin, termsFrom)
      const safeFee = feeDecision.amount
      if (feeDecision.cappedByLaw) {
        this.logger.warn(reminderFeeCapMessage(organizationId, feeDecision, `avi ${noticeId}`))
      }

      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId,
          status: 'OVERDUE',
          collectionStage: 'NONE',
          // T1.4 / #44: försvar-i-djupet — även ett direkt anrop får aldrig
          // eskalera en efterdebiterad avi (samma isolering som cron-urvalet).
          isBackfill: false,
        },
        data: {
          collectionStage: 'REMINDED',
          remindedAt: now,
          reminderFeeAmount: new Prisma.Decimal(safeFee.toFixed(2)),
          // #648 — NY BLOCKERINGSPERIOD BÖRJAR HÄR, inte där den förra slutade.
          //
          // Nollställningen ligger på INGÅNGEN med flit. En avi kan lämna
          // REMINDED på fyra sätt (flip, betalning, kreditering, annullering),
          // och en nollställning per utgång hade varit fyra ställen att glömma
          // — utgången via betalning sker dessutom i en annan modul. Ingången
          // är EN, och den passeras av varje ny period.
          blockedSince: null,
          blockedAlertedAt: null,
        },
      })
      if (claim.count === 0) return false

      let journalEntryId: string | null = null
      if (safeFee > 0) {
        const entry = await this.accounting.bookReminderFee({
          organizationId,
          source: 'RENT_NOTICE',
          sourceId: `reminder-fee:${noticeId}`,
          fee: safeFee,
          description: `Påminnelseavgift hyresavi ${noticeId}`,
          debtOrigin,
          termsFrom,
          tx,
        })
        // null = saknat 1510/3593 → bokföring omöjlig. INV-A: avbryt eskaleringen
        // genom att kasta så hela transaktionen rullas tillbaka.
        if (!entry) {
          throw new InternalServerErrorException(
            `Påminnelseavgift kunde inte bokföras för avi ${noticeId} — ` +
              'kontrollera att kontoplanen innehåller konto 1510 och 3593.',
          )
        }
        journalEntryId = entry.id
      }

      await this.rentNoticeEvents.record(
        noticeId,
        'REMINDER_SENT',
        'SYSTEM',
        null,
        {
          daysOverdue,
          fee: safeFee,
          vatFree: true,
          ...(journalEntryId ? { journalEntryId } : {}),
        },
        { tx },
      )
      return true
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * Inkasso PR 4b — steg 2. Daglig cron (kl 11:00 — efter påminnelse-cronen kl
   * 10:00) som eskalerar varje REMINDED-hyresavi som passerat
   * `rentReminderDay + rentInkassoDaysAfterReminder` (default 7+14=21 dagar efter
   * förfall) till INKASSO_READY — FÖRUTSATT att INV-B-grinden godkänner att
   * dokumentationen är komplett.
   *
   * En grind-blockerad avi (ConflictException) är INTE ett fel: den loggas som
   * "blocked", får sin avvikelse skriven till loggen, och omprövas nästa dygn
   * (när t.ex. en sen leveranskvittens hunnit komma). En betalning gör avin PAID
   * → faller ur urvalet, ärendet dör.
   */
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // RentNotice updateMany-claim på collectionStage=REMINDED → INKASSO_READY;
  // count=0 betyder att en annan körning redan eskalerat och grenen blir en
  // no-op.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('0 11 * * *')
  async escalateRemindedToInkassoReady(): Promise<InkassoReadySummary> {
    const summary: InkassoReadySummary = {
      ready: 0,
      blocked: 0,
      skipped: 0,
      errors: 0,
      pausedStale: 0,
      alerted: 0,
    }

    // T5 B1b — linda hela cron-kroppen: en DB-blipp på findMany/freshness larmar
    // nu via Sentry istället för tyst död. Per-avi-isoleringen (try/catch nedan,
    // inkl. ConflictException=blocked-grinden) och summeringen är OFÖRÄNDRADE —
    // summary muteras in-place och returneras nedan.
    await runCronSafely(
      'rent-reminder-escalate-inkasso-ready',
      async () => {
        const candidates = await this.prisma.rentNotice.findMany({
          where: {
            status: 'OVERDUE',
            type: RentNoticeType.RENT,
            collectionStage: 'REMINDED',
            organization: { remindersEnabled: true },
          },
          include: {
            organization: {
              select: { rentReminderDay: true, rentInkassoDaysAfterReminder: true },
            },
          },
        })

        // PR 4 (B) — inkasso-redo FLYTTAR FRAM inkassoärendet (och slutkristalliserar
        // ränta). Pausa + larma för org med inaktuell betalningsdata.
        const staleOrgs = await this.freshness.evaluateAndAlert(
          candidates.map((n) => n.organizationId),
        )

        // EN klocka för hela körningen. Två avier i samma körning ska mätas mot
        // samma nu — annars kan larmtröskeln passeras mitt i loopen.
        const nu = new Date()

        for (const notice of candidates) {
          try {
            if (staleOrgs.has(notice.organizationId)) {
              // PAUSAD, INTE BLOCKERAD. Markörerna rörs inte: orgen larmas redan av
              // freshness-larmet (ETT mejl per org och stale-period), och ett larm PER
              // AVI ovanpå det hade varit samma besked en gång per obetald avi.
              summary.pausedStale++
              continue
            }
            // NU EN GÅNG PER KÖRNING, SYNLIGT NEDÅT. Cronen läser klockan; metoden
            // får den. Samma form som #694 drev igenom för `daysSince`: en halvdragen
            // injektion, där ett `now` skickas in men något i kedjan ändå läser
            // `Date.now()`, är svårare att se än ingen injektion alls.
            //
            // DAGSGRINDEN LIGGER INTE LÄNGRE HÄR. Loopen äger URVALET (findMany
            // ovan) och sammanräkningen; åldern prövas av metoden. Se docblocket
            // där för varför.
            const res = await this.escalateNoticeToInkassoReady(
              notice.id,
              notice.organizationId,
              nu,
            )
            if (res.flipped) summary.ready++
            else summary.skipped++
          } catch (err) {
            // INV-B-grinden vägrade — ofullständigt underlag. Inte ett systemfel;
            // avin omprövas nästa dygn. Avvikelsen är redan loggad i avins egen logg.
            if (err instanceof ConflictException) {
              summary.blocked++
              this.logger.warn(`Inkasso-redo blockerad för avi ${notice.id}: ${err.message}`)
              // #648 — den enda platsen som VET att avin är blockerad just nu.
              // Larmet ligger efter räknaren och före `continue`, så en blockerad
              // avi räknas oavsett om larmet gick eller inte.
              // Anropet är också omslutet: kastar något FÖRE try/catch:en inne
              // i metoden (t.ex. själva anspråksskrivningen) får det inte göra
              // en korrekt blockerad avi till ett cron-fel.
              try {
                if (await this.larmaOmBlockeradAvi(notice.id, notice.organizationId, nu)) {
                  summary.alerted++
                }
              } catch (larmFel) {
                this.logger.error(
                  `Larm om blockerad avi ${notice.id} kunde inte utvärderas: ` +
                    `${larmFel instanceof Error ? larmFel.message : String(larmFel)}`,
                )
              }
              continue
            }
            summary.errors++
            this.logger.error(
              `Inkasso-redo misslyckades för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }

        this.logger.log(
          `Inkasso-redo: ${summary.ready} klara, ${summary.blocked} blockerade ` +
            `(${summary.alerted} larmade), ${summary.skipped} hoppade över, ` +
            `${summary.pausedStale} pausade (inaktuell betalningsdata), ${summary.errors} fel`,
        )
      },
      { logger: this.logger, sink: this.cronErrors },
    )
    return summary
  }

  /**
   * LARMET OM EN AVI SOM FASTNAT — #648.
   *
   * Anropas när INV-B-grinden just vägrat. Returnerar `true` bara när ett larm
   * FAKTISKT skrevs, så cronens räknare inte påstår mer än som hände.
   *
   * ── VARFÖR TVÅ MARKÖRER OCH INTE EN ──────────────────────────────────────
   *
   * `blockedSince` är periodens BÖRJAN, `blockedAlertedAt` är larmets
   * idempotensmarkör. Frestelsen är att klara sig med den senare och räkna
   * åldern ur händelseloggen — men loggen är append-only och cronen skriver en
   * blockeringsanteckning VARJE DYGN. Den senaste är därför alltid ~i dag:
   * uppmätt gav `collectionStatus.blockedDays` **0** på en avi som stått
   * blockerad i tre dygn. Talet svarar på "när prövades den sist", inte på
   * "hur länge har den stått still".
   *
   * ── VARFÖR EN NOTIS OCH INTE ETT MEJL ────────────────────────────────────
   *
   * Åtgärden (rätta adressen, ladda upp underlaget) görs i appen. Ett mejl hade
   * dessutom konkurrerat med freshness-larmet, som redan mejlar per org.
   *
   * ── VAD METODEN INTE GÖR ─────────────────────────────────────────────────
   *
   *  • Inget nytt event. Blockeringen är redan skriven som `NOTE_ADDED` av
   *    grinden; ett andra spår om samma sak hade gjort loggen oense med sig
   *    själv.
   *  • Inget larm för en PAUSAD org — den vägen når aldrig hit (se loopen).
   *  • Ingen nollställning. Den sker på INGÅNGEN till REMINDED, som är den
   *    enda punkt varje ny blockeringsperiod måste passera.
   */
  private async larmaOmBlockeradAvi(
    noticeId: string,
    organizationId: string,
    now: Date,
  ): Promise<boolean> {
    // Periodens början — ett ANSPRÅK, inte läs-sedan-skriv: två repliker får
    // inte kunna sätta var sitt `blockedSince` och flytta fram tröskeln.
    await this.prisma.rentNotice.updateMany({
      where: { id: noticeId, organizationId, blockedSince: null },
      data: { blockedSince: now },
    })

    const rad = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      select: { noticeNumber: true, blockedSince: true, blockedAlertedAt: true },
    })
    if (!rad?.blockedSince || rad.blockedAlertedAt) return false

    const blockeradeDygn = this.daysSince(rad.blockedSince, now)
    if (blockeradeDygn < BLOCKERAD_AVI_LARMTROSKEL_DAGAR) return false

    // ETT larm per period. Anspråket avgör vem som skriver det; förlorar man
    // det har någon annan redan larmat och den här körningen ska tiga.
    const anspråk = await this.prisma.rentNotice.updateMany({
      where: { id: noticeId, organizationId, blockedAlertedAt: null },
      data: { blockedAlertedAt: now },
    })
    if (anspråk.count === 0) return false

    // Samma mottagarurval som stale-larmet i `payment-freshness.service.ts`.
    const mottagare = await this.prisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: [UserRole.OWNER, UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT] },
      },
      select: { id: true },
    })

    // ── ETT TRASIGT LARM FÅR INTE BLI ETT TRASIGT CRON ─────────────────────
    //
    // Larmet är ett SIDOSPÅR till eskaleringen. Kastar det här ut i loopen
    // fångas det av `runCronSafely` och hela körningen rapporteras som ett
    // cron-fel — en avi som korrekt blockerades hade då sett ut som ett
    // systemhaveri.
    //
    // Markören rullas tillbaka, exakt som stale-larmet gör: en tyst paus utan
    // notis vore värst, och nästa dygns körning ska få försöka igen.
    try {
      for (const user of mottagare) {
        await this.notifications.create(
          organizationId,
          user.id,
          'SYSTEM',
          `Avi ${rad.noticeNumber} har stått stilla i ${blockeradeDygn} dygn`,
          `Kravtrappan kan inte gå vidare med avi ${rad.noticeNumber}: underlaget är ` +
            'ofullständigt, och ärendet har prövats utan resultat varje dygn sedan ' +
            `${rad.blockedSince.toLocaleDateString('sv-SE')}. Öppna avin för att se ` +
            'exakt vad som saknas — en studsad påminnelse kräver att adressen rättas.',
          {
            // Listsidan, inte en djuplänk. `/avisering/:id` finns inte som rutt
            // (`router.tsx` registrerar bara `/avisering`), och en länk som ger
            // 404 är sämre än en som ger listan. Id:t följer med i den
            // strukturerade referensen, så en framtida fokusering kan öppna
            // avin utan att den här skrivaren ändras.
            link: `avisering/${noticeId}`,
            relatedEntityType: 'RENT_NOTICE',
            relatedEntityId: noticeId,
          },
        )
      }
    } catch (err) {
      await this.prisma.rentNotice
        .updateMany({
          where: { id: noticeId, organizationId, blockedAlertedAt: now },
          data: { blockedAlertedAt: null },
        })
        .catch(() => undefined)
      this.logger.error(
        `Larm om blockerad avi ${noticeId} misslyckades (markör återställd för ` +
          `omförsök): ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
    return true
  }

  /**
   * Eskalerar EN hyresavi REMINDED → INKASSO_READY (inkasso PR 4b, steg 2).
   *
   * INV-B (dokumentationsfullständighet): grinden VÄGRAR övergången
   * (ConflictException, ingen flip) om något i underlaget saknas — avikopia,
   * lagrad påminnelse-PDF, verifierad leverans, utskickslogg, komplett gäldenär
   * eller fordringsägardata, eller utestående skuld. Den saknade delen loggas
   * append-only innan undantaget kastas, så avvikelsen syns i avins historik.
   *
   * Slutkristallisering: precis innan flippen bokförs dröjsmålsräntan en SISTA
   * gång t.o.m. idag (crystallizeInterest, INV-A internt: ränta + verifikat i
   * samma transaktion, idempotent delta). Då bär COLLECTION_READY-eventet och
   * exporten (steg 3) en räntefordran som är beräknad ända fram till
   * inkassoöverlämningen — inte t.o.m. den tidigare påminnelsedagen.
   *
   * Idempotent + race-säker: en updateMany-claim på (OVERDUE, stage=REMINDED)
   * gör att bara EN körning kan flippa avin; en dubbel cron-fire eller retry ger
   * claim count=0 → flipped=false utan att skriva ett andra COLLECTION_READY.
   * Redan INKASSO_READY/WRITTEN_OFF → no-op (ingen omgrindning, ingen ombokning).
   */
  // ── #352: DEPOSITIONS-AVIER HÅLLS UTE AV URVALET, INTE AV DEN HÄR METODEN ──
  //
  // `RentNotice` har också typen DEPOSIT, och en depositionsavi ska aldrig
  // eskalera till inkasso — samma skäl som på fakturasidan (#352): en
  // deposition är en säkerhet som ställs vid kontraktsstart, inte en löpande
  // hyresskuld, och en överlämning kräver ett uttryckligt mänskligt beslut.
  //
  // I DAG HÅLLER DET, MEN INVARIANTEN ÄR IMPLICIT. `collectionStage` sätts
  // enbart från cron-looparna ovan, och de filtrerar `type: RentNoticeType.RENT`
  // i sina `where`. Den här metoden grindar däremot på `collectionStage`, INTE
  // på typ — den är alltså säker bara så länge den enda vägen in går via de
  // filtrerade looparna.
  //
  // EN FRAMTIDA ENDPOINT SOM EXPONERAR DEN HÄR METODEN DIREKT skulle tyst
  // återinföra #352 i syskonsystemet: en depositionsavi vars `collectionStage`
  // satts på något annat sätt skulle passera rakt igenom. Lägg då ett typfilter
  // HÄR, inte bara i den nya anroparen. (Kartlagt i code-reviewer-granskningen
  // av #352 PR 2 — verifierat säkert i dag, dokumenterat för att det inte ska
  // förbli en tyst slump.)
  async escalateNoticeToInkassoReady(
    noticeId: string,
    organizationId: string,
    /**
     * KLOCKAN, OBLIGATORISKT. Inget default — ett `= new Date()` hade gjort
     * det möjligt att glömma bort den utan att något blir rött, och det är
     * precis den halvdragna injektion #694 stängde på `daysSince`.
     */
    now: Date,
  ): Promise<{ flipped: boolean; missing?: string[]; tooEarly?: true }> {
    // Org-verifierad läsning INNAN avins logg/relationer läses (tenant-isolation:
    // ett läckt noticeId får aldrig exponera en annan organisations underlag).
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      include: INKASSO_READY_INCLUDE,
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    // Redan inkasso-redo (eller avskriven) → idempotent no-op.
    if (notice.collectionStage === 'INKASSO_READY' || notice.collectionStage === 'WRITTEN_OFF') {
      return { flipped: false }
    }

    // ── DAGSGRINDEN BOR HÄR, INTE HOS ANROPAREN ────────────────────────────
    //
    // Kontrollen låg tidigare i cron-loopen. Uppmätt (#648): metoden anropad
    // DIREKT på en avi som var 8 dygn förfallen mot en tröskel på 19 gav
    // `flipped=true` och `stage=INKASSO_READY` — alltså en avi överlämnad
    // till inkasso elva dygn för tidigt.
    //
    // I dag fanns bara EN anropare, så det var latent och inte trasigt. Men
    // det är exakt samma form som DEPOSIT-noten ovan varnar för: en grind
    // som ligger hos anroparen är säker bara så länge ingen skriver en andra
    // anropare. Ett manuellt "eskalera nu" i en controller hade tyst
    // förbigått fristen — och för tidig inkasso är inte ett kosmetiskt fel,
    // det är ett formellt krav mot en gäldenär som ännu har tid på sig.
    //
    // Loopen behåller sitt URVAL (`findMany` på OVERDUE/RENT/REMINDED). Den
    // avgränsningen är en prestandafråga; den här är en rättighetsfråga.
    const daysOverdue = this.daysSince(notice.dueDate, now)
    const threshold =
      notice.organization.rentReminderDay + notice.organization.rentInkassoDaysAfterReminder
    if (daysOverdue < threshold) {
      // Inte ett fel och inte ett ofullständigt underlag: fristen har bara
      // inte löpt ut. Eget fält i stället för ett kast, så anroparen kan
      // skilja "för tidigt" från "underlaget saknar något".
      return { flipped: false, tooEarly: true }
    }

    // INV-B-grind. Avins egen logg (org redan verifierad ovan).
    const events = await this.prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId: noticeId },
      select: { type: true, sendId: true },
    })
    // Leveransen gäller det SENASTE utskicket (#656), inte avin.
    const senasteUtskick = await this.prisma.rentNoticeSend.findFirst({
      where: { rentNoticeId: noticeId, kind: 'REMINDER' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    // PR 3a — steg 10 (utestående skuld) läses från den allokeringsderiverade
    // sanningskällan i stället för paidAmount-cachen. ocrOutstanding EXKLUDERAR
    // ränta (bevarar dagens explicita val: vi mäter den OCR-reglerbara delen).
    const debt = await this.rentDebt.outstanding(noticeId, organizationId)
    const missing = this.checkInkassoReadiness(
      notice,
      events,
      debt.ocrOutstanding,
      senasteUtskick?.id ?? null,
    )
    if (missing.length > 0) {
      await this.rentNoticeEvents
        .record(noticeId, 'NOTE_ADDED', 'SYSTEM', null, {
          action: 'inkasso-ready-blocked',
          missing,
        })
        .catch(() => undefined)
      throw new ConflictException(
        `Avi ${notice.noticeNumber} kan inte göras inkasso-redo — ofullständigt underlag: ${missing.join('; ')}`,
      )
    }

    // Slutkristallisera räntan t.o.m. idag. Egen transaktion, INV-A internt.
    // En räntefri dag (delta 0) ger null. Ett bokföringsfel (saknat 1510/8131)
    // kastar och fäller eskaleringen — INV-A: ingen inkasso-flip om sluträntans
    // verifikat inte kunde skapas. Avin omprövas nästa dygn.
    await this.rentInterest.crystallizeInterest(noticeId, organizationId, now)

    // (Tidigare stod här `const now = new Date()`. Klockan är numera en
    // parameter, och en lokal omläsning hade gjort injektionen halvdragen:
    // grinden ovan hade prövats mot ett `now` och skrivningarna nedan mot
    // ett annat.)
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId,
          status: 'OVERDUE',
          collectionStage: 'REMINDED',
        },
        data: {
          collectionStage: 'INKASSO_READY',
          collectionReadyAt: now,
          // #648 — ärendet är inte blockerat längre. Ingången nollställer
          // ändå vid nästa period; det här håller raden ärlig under tiden.
          blockedSince: null,
          blockedAlertedAt: null,
        },
      })
      if (claim.count === 0) return { flipped: false }

      // Färsk räntesnapshot EFTER slutkristalliseringen för COLLECTION_READY.
      const fresh = await tx.rentNotice.findUniqueOrThrow({
        where: { id: noticeId },
        select: {
          dueDate: true,
          totalAmount: true,
          consumptionAmount: true,
          miscChargeAmount: true,
          reminderFeeAmount: true,
          interestAccruedAmount: true,
          interestAccruedThrough: true,
          reminderPdfStorageKey: true,
          // #518 — kravsteget dokumenterar vad som drivs in, och det är netto
          // efter kreditering. Payloaden är räkenskapsspår (BFL 5 kap 11 §):
          // står bruttot där blir historiken oense med det underlag som faktiskt
          // exporteras.
          credits: { select: { amount: true } },
        },
      })
      const credited = fresh.credits.reduce((sum, c) => sum + Number(c.amount), 0)
      const capital = Math.max(
        0,
        round2(
          Number(fresh.totalAmount) +
            Number(fresh.consumptionAmount) +
            Number(fresh.miscChargeAmount) -
            credited,
        ),
      )
      const totalClaim = round2(
        capital + Number(fresh.reminderFeeAmount) + Number(fresh.interestAccruedAmount),
      )

      await this.rentNoticeEvents.record(
        noticeId,
        'COLLECTION_READY',
        'SYSTEM',
        null,
        {
          daysOverdue: this.daysSince(fresh.dueDate, now),
          capital,
          reminderFeeAmount: Number(fresh.reminderFeeAmount),
          interestAccruedAmount: Number(fresh.interestAccruedAmount),
          interestAccruedThrough: fresh.interestAccruedThrough
            ? toYmd(fresh.interestAccruedThrough)
            : null,
          totalClaim,
          // Bara en flagga att kopian finns — INTE själva R2-nyckeln
          // (säkerhetsgranskning LOW: event-payloaden exponeras via
          // GET /avisering/:id/events och nyckeln har inget frontend-värde).
          reminderPdfStored: !!fresh.reminderPdfStorageKey,
        },
        { tx },
      )
      return { flipped: true }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  /**
   * INV-B-grinden: returnerar en lista över allt som SAKNAS i underlaget för att
   * avin ska få överlämnas till inkasso. Tom lista = komplett dokumentation.
   *
   * Varje post motsvarar ett konkret bevis ett inkassobolag (och ev. en
   * tingsrätt) förväntar sig: att kravet utfärdats och nått gäldenären, att en
   * påminnelse skickats och bevisligen levererats (ej studsat), och att både
   * gäldenär och fordringsägare är fullständigt identifierade. Saknas något är
   * kravet angripbart — då ska det aldrig exporteras.
   */
  private checkInkassoReadiness(
    notice: InkassoReadyNotice,
    events: { type: RentNoticeEventType; sendId: string }[],
    ocrOutstanding: number,
    /**
     * Det SENASTE påminnelseutskicket, eller null för en avi som påmindes innan
     * utskicket blev en egen enhet (#656). `null` blir `''` nedan — samma
     * sentinel som de gamla leveransraderna bär, så EN kodväg räcker för båda.
     */
    senasteUtskickId: string | null,
  ): string[] {
    const missing: string[] = []
    const has = (t: RentNoticeEventType): boolean => events.some((e) => e.type === t)

    // 1. Original-avin utfärdad och utskickad. Avi-PDF:en regenereras on-demand
    //    ur avins data (getNoticePdfBuffer) — sentAt bevisar att dokumentet
    //    faktiskt gått till gäldenären, vilket är det grinden behöver verifiera.
    if (!notice.sentAt) missing.push('avin har inte skickats till hyresgästen (ingen avikopia)')

    // 2. Lagrad påminnelse-PDF (PR 4b₀) — dokumentkopian som följer med i exporten.
    if (!notice.reminderPdfStorageKey) missing.push('lagrad påminnelse-PDF saknas')

    // 3. Verifierad leverans av påminnelsen (Resend-webhook → EMAIL_DELIVERED).
    //
    // ── LEVERANSEN GÄLLER ETT UTSKICK, INTE AVIN (#656) ────────────────────
    //
    // Frågan var `has('EMAIL_BOUNCED')` — "har den här avin någonsin studsat".
    // Eftersom loggen är append-only blockerade den för ALLTID, även efter en
    // lyckad omsändning: en avi vars adress rättats och vars påminnelse kommit
    // fram kunde aldrig gå vidare.
    //
    // Rätt fråga gäller det SENASTE utskicket. Då finns ingen tidsstämpel att
    // jämföra och ingen ordning att resonera om — varje utskick bär sitt eget
    // svar, och vi läser det som gäller nu.
    const utskickId = senasteUtskickId ?? ''
    const utfall = (t: RentNoticeEventType): boolean =>
      events.some((e) => e.type === t && e.sendId === utskickId)

    if (!utfall('EMAIL_DELIVERED')) {
      missing.push('påminnelsens leverans är inte verifierad')
    }

    // 4. …och det senaste utskicket får inte ha studsat (felaktig adress).
    if (utfall('EMAIL_BOUNCED')) missing.push('påminnelsen studsade (leverans misslyckades)')

    // 5. Utskickslogg — minst en SENT-händelse i avins historik.
    if (!has('SENT')) missing.push('utskickslogg (SENT) saknas')

    // 6. Komplett gäldenär: person- ELLER organisationsnummer.
    const t = notice.tenant
    if (!t?.personalNumberHash && !t?.orgNumber) {
      missing.push('gäldenärens person-/organisationsnummer saknas')
    }

    // 7. Komplett gäldenäradress.
    if (!t?.street || !t?.postalCode || !t?.city) {
      missing.push('gäldenärens adress är ofullständig')
    }

    // 8. Fordringsägarens (hyresvärdens) organisationsnummer.
    const o = notice.organization
    if (!o?.orgNumber) missing.push('fordringsägarens organisationsnummer saknas')

    // 9. Fordringsägarens adress.
    if (!o?.street || !o?.postalCode || !o?.city) {
      missing.push('fordringsägarens adress är ofullständig')
    }

    // 10. Betalningshistorik: det måste finnas en utestående skuld att driva in.
    //     (En OVERDUE-avi är obetald, men en delbetalning kan ha registrerats —
    //     överlämna bara om restskulden är positiv.) PR 3a: ocrOutstanding läses nu
    //     från RentDebtService (allokeringsderiverad sanningskälla) i stället för
    //     paidAmount-cachen. interestAccruedAmount EXKLUDERAS fortsatt avsiktligt:
    //     räntan är en separat fordran (löper kontinuerligt, ingår inte i OCR-
    //     inbetalbart). Det vi mäter är den OCR-reglerbara delen — är den noll finns
    //     inget att driva in. (Waterfall-regeln definieras i RentDebtService.)
    if (ocrOutstanding <= 0) missing.push('ingen utestående skuld att driva in')

    return missing
  }

  /**
   * Renderar och skickar påminnelse-PDF:en. Anropas av PdfWorker (kind
   * 'avisering-reminder'). Idempotent: en redan loggad lyckad SENT-händelse
   * hoppar över utskicket så en Bull-retry inte ger dubbelmejl. Leveransstatus
   * loggas i RentNoticeEvent (SENT / SEND_FAILED) — kravstegets REMINDER_SENT
   * (avgiften togs) sattes redan atomiskt vid eskaleringen.
   */
  async processReminderSendJob(orgId: string, noticeId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: REMINDER_NOTICE_INCLUDE,
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    // ── GRIND 1: EN BULL-RETRY, INTE ETT OMFÖRSÖK ──────────────────────────
    //
    // Grinden ska finnas — en retry får aldrig ge dubbelmejl. Men "har någonsin
    // skickats" var fel FRÅGA: den låste också ute ett legitimt omförsök efter
    // en studs, och avin kunde varken gå framåt eller påminnas igen (#656).
    //
    // Rätt fråga är om det finns ett utskick I LUFTEN. Ett utskick vars utfall
    // ännu inte kommit är en pågående sändning; en retry av samma jobb ser det
    // och avstår. Har det SENASTE utskicket däremot fått sitt utfall — levererat
    // eller studsat — är sändningen avslutad och ett nytt utskick är en ny
    // handling, inte en dubblett.
    //
    // FAIL-CLOSED ÅT RÄTT HÅLL: saknas utfall avstår vi. Hellre ett uteblivet
    // omförsök som en människa kan trycka fram än ett dubbelmejl till en
    // hyresgäst som redan fått kravet.
    const senasteUtskick = await this.prisma.rentNoticeSend.findFirst({
      where: { rentNoticeId: noticeId, kind: 'REMINDER' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (senasteUtskick) {
      // ENDAST EN STUDS ÖPPNAR. Första versionen frågade bara om det FANNS ett
      // utfall, och släppte då igenom ett LEVERERAT utskick — funnet av
      // db-provet, inte av läsning. Ett andra brev efter en lyckad leverans är
      // en dubblett till en hyresgäst som redan fått kravet.
      //
      // Samma villkor som knappens (`bedömOmsändning`), och det är avsiktligt:
      // grinden är försvaret om någon når hit på en annan väg än knappen.
      const studs = await this.prisma.rentNoticeEvent.findFirst({
        where: { rentNoticeId: noticeId, sendId: senasteUtskick.id, type: 'EMAIL_BOUNCED' },
        select: { id: true },
      })
      // KÄND GRÄNS: ett utskick som aldrig nådde e-postleverantören (SEND_FAILED,
      // inget EMAIL_*) räknas som i luften och öppnar alltså inte heller. Det är
      // fail-closed åt rätt håll, men det betyder att just det fallet inte har
      // någon väg ut ännu.
      if (!studs) return
    } else {
      // Inget utskick registrerat. Före #656 fanns bara SENT-händelsen, så en
      // avi som påmindes DÅ har inget utskick — och ska inte påminnas om nu av
      // den anledningen. Den gamla frågan gäller alltså fortfarande för dem.
      const gammaltUtskick = await this.prisma.rentNoticeEvent.findFirst({
        where: { rentNoticeId: noticeId, type: 'SENT' },
        select: { id: true },
      })
      if (gammaltUtskick) return
    }

    if (!notice.tenant.email) {
      await this.rentNoticeEvents
        .record(noticeId, 'SEND_FAILED', 'SYSTEM', null, {
          reason: 'Hyresgästen saknar e-postadress',
        })
        .catch(() => undefined)
      return
    }

    try {
      const html = await this.buildReminderPdfHtml(notice, org)
      const pdfBuffer = await this.pdfService.generateFromHtml(html)

      // Inkasso PR 4b₀: lagra den FAKTISKT skickade påminnelse-PDF:en org-scopat
      // (reminders/{orgId}/…, samma R2-tenant-isolation som övriga dokument) så
      // dokumentkopian kan följa med i inkassoöverlämningen (PR 4b, INV-B).
      // Best-effort: en R2-hicka får INTE blocka den lagstadgade påminnelsen.
      // Idempotent — samma nyckel skrivs över vid en Bull-retry före lyckat
      // utskick (SENT-händelsen ovan stoppar retry EFTER lyckad send).
      await this.storeReminderPdf(orgId, noticeId, pdfBuffer)

      const tenantName =
        notice.tenant.type === 'INDIVIDUAL'
          ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
          : (notice.tenant.companyName ?? notice.tenant.email)

      const { payable, nominalBeforeFee, fee, paid, overpaid } = rentNoticeOutstanding(notice)

      // UTSKICKET ÄR EN EGEN SAK, och det skapas FÖRE köandet: köns svar
      // (message-id) måste kunna skrivas på en rad som redan finns.
      const utskick = await this.prisma.rentNoticeSend.create({
        data: {
          rentNoticeId: noticeId,
          kind: 'REMINDER',
          // Adressens fingeravtryck hör till UTSKICKET, inte till avin: det är
          // just "vart gick DET HÄR brevet" som avgör om ett omförsök är
          // meningsfullt eller bara ger samma studs igen.
          toHash: hashaAdress(notice.tenant.email),
        },
        select: { id: true },
      })

      const jobId = await this.mailService.sendRentNoticeReminder({
        rentNoticeId: noticeId,
        sendId: utskick.id,
        to: notice.tenant.email,
        organizationId: orgId,
        tenantName,
        noticeNumber: notice.noticeNumber,
        ocrNumber: notice.ocrNumber,
        // ── #344: RESTSKULDEN, INTE BRUTTOT ────────────────────────────────
        //
        // `payable` — det KRÄVDA beloppet — är den OCR-reglerbara restskulden
        // INKLUSIVE den avgift som just bokförts (avgiften skrivs in i
        // `reminderFeeAmount` av `escalateNoticeToReminded`, före det här jobbet
        // körs). Specifikationen ovanför totalen står NOMINELLT med betalningen
        // som eget avdrag, så raderna summerar till totalen i varje läge —
        // inklusive när en betalning hunnit äta in på avgiften (FAR, #344).
        noticeAmount: nominalBeforeFee,
        feeAmount: fee,
        payableTotal: payable,
        paidSoFar: paid,
        overpaidAmount: overpaid,
        dueDate: notice.dueDate,
        daysOverdue: this.daysSince(notice.dueDate, new Date()),
        organizationName: org.name,
        accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
        pdfBuffer,
        // ── GRIND 4: NYCKELN ÄR PER UTSKICK (#656) ──────────────────────
        //
        // `rent-reminder-${notice.id}` var EN nyckel per avi, för all framtid,
        // mot Bulls minne (7 dygn eller 1000 jobb). En omsändning inom det
        // fönstret dedupades och brevet skickades ALDRIG — utan felmeddelande —
        // medan samma omsändning utanför fönstret gick igenom. "Fungerar
        // ibland" är sämre än att inte fungera.
        //
        // Kön ska hindra dubbelutskick INOM ett jobb. Utfallet bor i databasen,
        // inte i kö-fönstret — det var #651:s lärdom.
        idempotencyKey: `rent-reminder-${utskick.id}`,
      })

      // FÄLTET HETER `jobId` DÄRFÖR ATT DET ÄR ETT JOBID (#651).
      //
      // Det hette `messageId` och lagrades dessutom i `reminderMessageId` som
      // webhookens korrelationsnyckel. Men `MailQueue.enqueue` returnerar Bulls
      // jobId (= idempotensnyckeln, här `rent-reminder-<id>`), inte Resends
      // email_id — två skilda namnrymder. Webhooken frågade på email_id och kunde
      // aldrig träffa, så EMAIL_DELIVERED skrevs ALDRIG och INV-B-grinden kunde
      // aldrig släppa fram en avi till inkasso. Ett namn som ljuger om sitt
      // innehåll var halva orsaken till att ingen såg det.
      await this.rentNoticeEvents.record(
        noticeId,
        'SENT',
        'SYSTEM',
        null,
        { channel: 'EMAIL', ...(jobId ? { jobId } : {}) },
        { sendId: utskick.id },
      )
      if (jobId) {
        await this.prisma.rentNoticeSend
          .update({ where: { id: utskick.id }, data: { jobId } })
          .catch(() => undefined)
      }

      // KORRELATIONSNYCKELN SKRIVS INTE HÄR. `reminderMessageId` sätts av
      // `persistResendId` i mail.worker.ts, efter lyckat utskick, med det id
      // Resend gav TILLBAKA — det enda värde webhooken kan matcha på. Vi skickar
      // `rentNoticeId` som `correlation` och låter workern äga skrivningen.
      // Leveransutfallet (EMAIL_DELIVERED/EMAIL_BOUNCED) loggas därefter
      // append-only i RentNoticeEvent av ResendWebhookService.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.rentNoticeEvents
        .record(noticeId, 'SEND_FAILED', 'SYSTEM', null, { reason: msg })
        .catch(() => undefined)
      throw err
    }
  }

  /**
   * Hela dygn mellan `date` och `now`.
   *
   * `now` är OBLIGATORISK, och det är hela poängen. Hjälparen läste tidigare
   * `Date.now()` själv, vilket gjorde `collectionStatus(…, now)` HALVDRAGEN:
   * signaturen tog emot en tidpunkt, `freshness.evaluate(org, now)` honorerade
   * den, men `daysOverdue` och `blockedDays` räknades mot den riktiga klockan.
   * Anroparen trodde att den styrde tiden.
   *
   * Utfallet var en tidsbomb i `rent-collection-status.db.spec.ts`: specen
   * INJICERADE sin `NU` och blev ändå röd när verklig tid passerade
   * 2026-09-03T12:00Z, eftersom `daysOverdue` drev och det injicerade värdet
   * inte gjorde det (#690). Rättningen där gjorde fixturen relativ — alltså
   * gav upp injektionen — i stället för att laga det som var trasigt.
   *
   * Med `now` obligatorisk kan ingen väg läsa klockan GÖMD i hjälparen. En
   * cron-väg får läsa den riktiga klockan, men skriver då `new Date()` synligt
   * vid sitt eget anropsställe.
   */
  private daysSince(date: Date, now: Date): number {
    const ms = now.getTime() - date.getTime()
    return Math.floor(ms / (24 * 60 * 60 * 1000))
  }

  /**
   * Laddar upp påminnelse-PDF:en till R2 (org-scopat) och persisterar nyckeln på
   * avin. Best-effort: ett lagringsfel loggas men kastas INTE — den lagstadgade
   * påminnelsen ska skickas oavsett om dokumentkopian kunde sparas. PR 4b:s
   * inkasso-ready-grind vägrar i sin tur övergången om nyckeln saknas (INV-B).
   */
  private async storeReminderPdf(
    orgId: string,
    noticeId: string,
    pdfBuffer: Buffer,
  ): Promise<void> {
    const storageKey = `reminders/${orgId}/${noticeId}.pdf`
    try {
      await this.storage.uploadFile(pdfBuffer, storageKey, 'application/pdf')
      await this.prisma.rentNotice.update({
        where: { id: noticeId },
        data: { reminderPdfStorageKey: storageKey },
      })
    } catch (err) {
      this.logger.error(
        `Kunde inte lagra påminnelse-PDF för avi ${noticeId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Exponerad för test (org-adress + villkorat bankgiro enligt lag 1981:739 5 §).
  async buildReminderPdfHtml(
    notice: ReminderNotice,
    org: {
      name: string
      street?: string | null
      postalCode?: string | null
      city?: string | null
      bankgiro?: string | null
      invoiceColor?: string | null
      brandSecondaryColor?: string | null
      brandFont?: string | null
      logoStorageKey?: string | null
    },
  ): Promise<string> {
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)
    // Steg 3, PR 3d: hårdkodad #1a6b3c → delad DEFAULT_BRAND_COLOR (= '#1a6b3c',
    // pixel-identiskt för orgs utan egen invoiceColor). Avbockad i kartan.
    const accent = org.invoiceColor ?? DEFAULT_BRAND_COLOR
    const fmt = (n: number): string =>
      Number(n).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    // ── #344: PDF:en ÄR KRAVET — den ska bära restskulden ────────────────────
    //
    // Den här ytan namngavs inte i ärendet; den hittades genom att inventera
    // ALLA konsumenter av `rentNoticePayableTotal`. Brevet hänvisar uttryckligen
    // till bilagan ("bifogad påminnelse visar beloppet"), så en PDF med bruttot
    // och ett mejl med restskulden vore värre än två fel siffror — de hade
    // motsagt varandra i samma försändelse.
    const { payable, nominalBeforeFee, fee, paid, overpaid } = rentNoticeOutstanding(notice)
    const daysOverdue = this.daysSince(notice.dueDate, new Date())
    const dueDateStr = notice.dueDate.toLocaleDateString('sv-SE')

    const tenantName =
      notice.tenant.type === 'INDIVIDUAL'
        ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
        : (notice.tenant.companyName ?? '')

    const feeRowHtml =
      fee > 0
        ? `<tr><td style="padding:6px 0;color:#6B7280">Påminnelseavgift</td>
             <td style="padding:6px 0;text-align:right;color:#111827">${fmt(fee)} kr</td></tr>`
        : ''

    // #344 — bara när något faktiskt är betalt. Beloppet är Σ allokeringar,
    // aldrig ett klampat restvärde: raden är avdraget som gör att posterna ovan
    // summerar till "Att betala nu".
    const paidRowHtml =
      paid > 0
        ? `<tr><td style="padding:6px 0;color:#6B7280">Registrerad betalning</td>
             <td style="padding:6px 0;text-align:right;color:#111827">−${fmt(paid)} kr</td></tr>`
        : ''

    // Överbetalning: utan den här raden hade posterna summerat till ett negativt
    // tal medan totalen visade 0 (klampad). Sällsynt — men brevet ska gå ihop i
    // varje läge, inte i de vanliga.
    const overpaidRowHtml =
      overpaid > 0
        ? `<tr><td style="padding:6px 0;color:#6B7280">Överbetalt belopp</td>
             <td style="padding:6px 0;text-align:right;color:#111827">${fmt(overpaid)} kr</td></tr>`
        : ''

    // Fordringsägarens (hyresvärdens) namn + adress måste framgå av påminnelsen
    // (lag 1981:739 5 §) — annars kan avgiftens giltighet ifrågasättas.
    const addressLine = [org.street, [org.postalCode, org.city].filter(Boolean).join(' ').trim()]
      .filter(Boolean)
      .join(', ')
    const orgAddressHtml = `<div class="muted" style="margin-bottom:24px">
      <strong style="color:#111827">${org.name}</strong>${addressLine ? `<br/>${addressLine}` : ''}
    </div>`

    // Bankgiro visas BARA om det finns — aldrig ett ogiltigt '0000-0000' som
    // hyresgästen inte kan betala till.
    const bankgiroRowHtml = org.bankgiro
      ? `<tr><td style="padding:4px 0;color:#6B7280">Bankgiro</td>
             <td style="padding:4px 0;text-align:right" class="mono">${org.bankgiro}</td></tr>`
      : ''

    // Steg 3, PR 3d: påminnelsen renderas genom den gemensamma brandade shellen.
    // Egen html/head/body + egen logga/titel borttagna — shellen ger logga,
    // dokumenttitel, typsnitt och varumärkesfärg. hideFooter:true (samma val som
    // hyresavin): fordringsägarens namn/adress (lag 1981:739 5 §) och betalnings-
    // rutan ligger i innehållet; ingen generisk footer efter dem. Tonen/texten och
    // ALLA betalningsbärande fält (OCR, avgift, total, bankgiro, förfallodatum,
    // mottagare) bar samma värden som före brandningen — den ändringen rörde
    // bara ramen.
    //
    // #344 ÄNDRADE BELOPPEN MED FLIT: TOTALEN ("Att betala nu") bar bruttot och
    // bär nu restskulden. Posterna ovanför totalen står kvar NOMINELLT — så som
    // de bokfördes — med betalningen som egen avdragsrad, vilket är både sant och
    // summerbart (FAR:s krav i granskningen). Raden hette "Ursprungligt belopp"
    // med ett tal som inte längre var ursprungligt; den heter nu "Avins belopp"
    // och bär just det. Brödtexten påstår inte längre att ingen betalning
    // registrerats — vilket var FALSKT för en delbetald avi.
    const contentCss = `
  .bp-content { color: #111827; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  .totalrow td { border-top:2px solid #111827; padding-top:10px; font-weight:700; font-size:15px; }
  .ocrbox { background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px; padding:16px 20px; margin-top:24px; }
  .mono { font-family:monospace; font-weight:700; letter-spacing:0.06em; }
  .muted { color:#6B7280; font-size:12px; }`

    const contentHtml = `<style>${contentCss}</style>
  <p class="muted" style="margin-bottom:24px">Avi ${notice.noticeNumber}${daysOverdue > 0 ? ` · ${daysOverdue} dagar förfallen` : ''}</p>

  ${orgAddressHtml}

  <p style="font-size:13.5px;line-height:1.6">
    ${tenantName ? `Hej ${escapeHtml(tenantName)},<br/>` : ''}
    hyresavi <strong>${notice.noticeNumber}</strong> förföll ${dueDateStr} och är ännu inte
    fullt betald. Vänligen betala snarast. En påminnelseavgift enligt
    4 § lagen (1981:739) om ersättning för inkassokostnader har tillkommit.
  </p>

  <table style="margin-top:24px">
    <tr><td style="padding:6px 0;color:#6B7280">Avins belopp</td>
        <td style="padding:6px 0;text-align:right;color:#111827">${fmt(nominalBeforeFee)} kr</td></tr>
    ${feeRowHtml}
    ${paidRowHtml}
    ${overpaidRowHtml}
    <tr class="totalrow"><td>Att betala nu</td>
        <td style="text-align:right">${fmt(payable)} kr</td></tr>
  </table>

  <div class="ocrbox">
    <table>
      ${bankgiroRowHtml}
      <tr><td style="padding:4px 0;color:#6B7280">OCR-nummer</td>
          <td style="padding:4px 0;text-align:right"><span class="mono" style="color:${accent}">${notice.ocrNumber}</span></td></tr>
    </table>
  </div>

  <p class="muted" style="margin-top:32px">
    Har du redan betalat kan du bortse från denna påminnelse.
  </p>`

    return buildBrandedPdfHtml({
      // Footern dold (hideFooter) → fordringsägarens namn/adress (lag 1981:739 5 §)
      // ligger kvar i innehållet ovan. Shellen behöver bara namnet.
      org: { name: org.name },
      logoDataUrl,
      primaryColor: org.invoiceColor ?? null,
      secondaryColor: org.brandSecondaryColor ?? null,
      brandFont: org.brandFont ?? null,
      title: 'Betalningspåminnelse',
      contentHtml,
      hideFooter: true,
    })
  }

  /**
   * VARFÖR STÅR DEN HÄR AVIN STILL? — läsande, och samma källa som grinden.
   *
   * ── DEN FRÅGA VYN FAKTISKT STÄLLER ──────────────────────────────────────
   *
   * En avi i `REMINDED` som ligger kvar ser likadan ut oavsett orsak. Cronet
   * (`escalateOverdueToInkassoReady`) går vidare på TRE olika sätt, och bara
   * ETT av dem lämnar ett spår i avins logg:
   *
   *     daysOverdue < tröskeln     → `skipped`      INGET event   = väntar
   *     INV-B saknar något         → NOTE_ADDED     event varje dygn = fastnat
   *     orgens betalningsdata gammal → `pausedStale` INGET event   = pausad
   *
   * Två av tre tillstånd är alltså osynliga i händelseloggen, och det tredje
   * går bara att skilja från de andra om man vet vad man letar efter. Frånvaro
   * syns bara om den beräknas mot en förväntan — samma sak som luckorna i
   * historikvyn.
   *
   * ── VARFÖR EN ENDPOINT OCH INTE EN UTRÄKNING I WEBBEN ───────────────────
   *
   * INV-B har tio krav. Räknades de om i frontend fanns två uppsättningar som
   * ska vara lika men kan ändras var för sig, och den som visas för operatören
   * hade varit den som INTE grindar. `checkInkassoReadiness` är privat och
   * förblir det; den här metoden är dess enda läsande väg ut.
   *
   * ── `missing` FYLLS ALLTID, OAVSETT `state` ─────────────────────────────
   *
   * `state` säger vad cronet kommer att göra. `missing` säger vad som är fel.
   * De är olika frågor: en avi som väntar OCH har en studsad påminnelse ska
   * visa studsen nu, inte om nio dagar när tröskeln passeras — hela poängen är
   * att adressen ska hinna rättas innan kravet stannar.
   *
   * ── VAD DEN HÄR METODEN INTE KAN SE ─────────────────────────────────────
   *
   * Om cronet faktiskt KÖRDE. Den räknar ut vad som skulle hända om det körde
   * nu. Står jobbet still av något skäl utanför de tre ovan — en kö som inte
   * dras, en container som inte startar — svarar den ändå `WAITING`. Den
   * frågan ägs av cron-felsänkan och av `/v1/health`.
   */
  async collectionStatus(
    noticeId: string,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<RentCollectionStatus> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      include: INKASSO_READY_INCLUDE,
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    const events = await this.prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId: noticeId },
      select: { type: true, createdAt: true, payload: true, sendId: true },
      orderBy: { createdAt: 'asc' },
    })
    const senasteUtskickFullt = await this.prisma.rentNoticeSend.findFirst({
      where: { rentNoticeId: noticeId, kind: 'REMINDER' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, toHash: true },
    })
    const senasteUtskick = senasteUtskickFullt
    const debt = await this.rentDebt.outstanding(noticeId, organizationId)

    // SAMMA funktion som grinden kastar på. Inget andra regelverk.
    const missing = this.checkInkassoReadiness(
      notice,
      events,
      debt.ocrOutstanding,
      senasteUtskick?.id ?? null,
    )

    const org = notice.organization
    const freshness = this.freshness.evaluate(org, now)
    const thresholdDays = org.rentReminderDay + org.rentInkassoDaysAfterReminder
    const daysOverdue = this.daysSince(notice.dueDate, now)

    const senaste = (t: RentNoticeEventType): Date | null => {
      let träff: Date | null = null
      for (const e of events) if (e.type === t) träff = e.createdAt
      return träff
    }

    // Den senaste gången grinden faktiskt vägrade. Cronet skriver en sådan rad
    // per dygn, så avståndet till i dag är hur länge ärendet stått still.
    let senastBlockerad: Date | null = null
    for (const e of events) {
      if (e.type !== 'NOTE_ADDED') continue
      const p = e.payload as { action?: unknown }
      if (p?.action === 'inkasso-ready-blocked') senastBlockerad = e.createdAt
    }

    const state: RentCollectionState =
      notice.collectionStage !== 'REMINDED'
        ? 'NOT_APPLICABLE'
        : !org.remindersEnabled
          ? 'REMINDERS_OFF'
          : freshness.stale
            ? 'PAUSED_STALE'
            : daysOverdue < thresholdDays
              ? 'WAITING'
              : missing.length > 0
                ? 'BLOCKED'
                : 'READY'

    return {
      state,
      collectionStage: notice.collectionStage,
      missing,
      daysOverdue,
      thresholdDays,
      /** Dygn kvar tills cronet prövar avin. 0 när den redan prövas. */
      daysUntilEvaluation: Math.max(0, thresholdDays - daysOverdue),
      freshness: {
        stale: freshness.stale,
        through: freshness.through,
        ageDays: Number.isFinite(freshness.ageDays) ? freshness.ageDays : null,
        thresholdDays: freshness.thresholdDays,
      },
      // AVINS leverans och PÅMINNELSENS är SKILDA fält, och det är inte
      // kosmetik: INV-B läser bara påminnelsens. #651 gav dem egna
      // händelsetyper just för att en avileverans aldrig ska kunna uppfylla en
      // grind som betyder "påminnelsen kom fram".
      delivery: {
        noticeSentAt: notice.sentAt,
        noticeDeliveredAt: senaste('NOTICE_EMAIL_DELIVERED'),
        noticeBouncedAt: senaste('NOTICE_EMAIL_BOUNCED'),
        reminderSentAt: senaste('REMINDER_SENT'),
        reminderDeliveredAt: senaste('EMAIL_DELIVERED'),
        reminderBouncedAt: senaste('EMAIL_BOUNCED'),
        sendFailedAt: senaste('SEND_FAILED'),
      },
      lastBlockedAt: senastBlockerad,
      // ── VAD `blockedDays` FAKTISKT MÄTER (#648) ──────────────────────────
      //
      // Talet räknade från den SENASTE blockeringsanteckningen. Men cronen
      // skriver en sådan varje dygn, så det var alltid ~0 — uppmätt: 0 på en
      // avi som stått blockerad i tre dygn. Fältet svarade på "när prövades
      // den sist" medan namnet lovar "hur länge har den stått still", och det
      // är den senare frågan både operatören och larmet ställer.
      //
      // `blockedSince` är periodens början och nollställs på ingången till
      // REMINDED. Fallbacken finns för rader som blockerades innan kolumnen
      // fanns: där är `blockedSince` null, och då är det gamla talet det enda
      // som går att svara — men `lastBlockedAt` står bredvid, så en läsare kan
      // se vilket av de två svaren hen får.
      blockedDays: notice.blockedSince
        ? this.daysSince(notice.blockedSince, now)
        : senastBlockerad
          ? this.daysSince(senastBlockerad, now)
          : null,
      resend: bedömOmsändning({
        collectionStage: notice.collectionStage,
        senasteUtskick: senasteUtskickFullt,
        utfall: senasteUtskickFullt
          ? events
              .filter(
                (e) =>
                  e.sendId === senasteUtskickFullt.id &&
                  (e.type === 'EMAIL_DELIVERED' || e.type === 'EMAIL_BOUNCED'),
              )
              .map((e) => e.type)
          : [],
        tenantEmail: notice.tenant?.email ?? null,
      }),
    }
  }

  /**
   * SKICKA OM PÅMINNELSEN — samma påminnelse, inte ett nytt trappsteg.
   *
   * ── VAD DEN INTE GÖR, OCH VARFÖR DET ÄR HELA POÄNGEN ────────────────────
   *
   * Ingen ny avgift. Ingen omräknad ränta. Ingen förflyttning i kravtrappan.
   * `collectionStage` står kvar på `REMINDED`, och därför rörs aldrig
   * eskaleringens anspråk — den grindar på `collectionStage: 'NONE'`, och en
   * omsändning går en annan väg av konstruktion.
   *
   * Skälet är inte teknik utan pengar: en studs betyder att ADRESSEN var fel.
   * #654 återför redan avgiften när påminnelsen studsar — vi tar inte betalt för
   * ett brev som inte kom fram. Att ta en NY avgift för att skicka om det vore
   * att låta hyresgästen betala för hyresvärdens felaktiga adressdata.
   *
   * ── GRINDARNA, OCH VARFÖR VAR OCH EN ────────────────────────────────────
   *
   * Alla fyra är fail-closed: kan vi inte visa att omsändningen betyder något,
   * skickar vi inte.
   *
   *   1. Avin måste vara i REMINDED. Utanför kravsteget finns ingen påminnelse
   *      att skicka om.
   *   2. Det måste finnas ett tidigare utskick. Annars är det inte en OMsändning.
   *   3. Det senaste utskicket måste ha STUDSAT. Levererades det finns inget
   *      problem att laga, och ett andra brev vore en dubblett till en
   *      hyresgäst som redan fått kravet. Saknas utfallet är sändningen
   *      fortfarande i luften.
   *   4. Hyresgästen måste ha en adress att skicka till.
   *
   * ── VAD DEN HÄR METODEN INTE KAN SE ─────────────────────────────────────
   *
   * Om den NYA adressen är riktig. Den kan bara se att den är en annan än den
   * som studsade — `bedömOmsändning` räknar ut det, och gränssnittet varnar när
   * den är densamma. Ett omförsök till samma trasiga adress ger samma studs.
   */
  async resendReminder(
    noticeId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ enqueued: true }> {
    const status = await this.collectionStatus(noticeId, organizationId)
    if (!status.resend.allowed) {
      throw new ConflictException(status.resend.blockedReason ?? 'Påminnelsen kan inte skickas om.')
    }

    // ANTECKNAS FÖRE UTSKICKET. Kraschar köandet ska det ändå synas att en
    // människa bad om det — ett spårlöst försök är samma tystnad som vyn i #648
    // finns för att ta bort.
    await this.rentNoticeEvents
      .record(noticeId, 'NOTE_ADDED', 'USER', userId, {
        action: 'reminder-resend-requested',
        förraUtskicket: status.resend.senasteUtskickId,
      })
      .catch(() => undefined)

    // ── DIREKT ENQUEUE, INTE enqueueSafely ─────────────────────────────────
    //
    // `enqueueSafely` finns för vägar som INTE får kasta: en cron ska inte dö
    // för att kön blinkade, och därför sväljer hjälparen felet och rapporterar
    // det på sidan om. Den här vägen är motsatsen. En människa står och tittar
    // på knappen, och ett misslyckat köande MÅSTE nå tillbaka som ett fel —
    // annars ser omsändningen ut att ha skett.
    //
    // Att köa via hjälparen och sedan kasta ändå hade gett två rapporteringar
    // av samma fel och ett svar som ändå blev ett kast.
    try {
      await this.pdfQueue.enqueue({ kind: 'avisering-reminder', organizationId, noticeId })
    } catch (err) {
      this.logger.error(
        `Omsändning av påminnelse kunde inte köas för avi ${noticeId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      throw new ConflictException(
        'Påminnelsen kunde inte köas för utskick. Försök igen om en stund.',
      )
    }
    return { enqueued: true }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
