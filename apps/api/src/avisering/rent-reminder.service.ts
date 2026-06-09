import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { Prisma, RentNoticeType, type RentNoticeEventType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { AccountingService } from '../accounting/accounting.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { rentNoticePayableTotal } from '../common/utils/rent-notice-total.util'
import { getLogoDataUrl } from './avisering.service'
import { buildBrandedPdfHtml, escapeHtml } from '../common/branding'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentInterestService } from './rent-interest.service'
import { RentDebtService } from './rent-debt.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'

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
}

// Avin med precis de relationer INV-B-grinden behöver för att avgöra om
// dokumentationen är komplett (gäldenär + fordringsägare). Org redan verifierad
// av anroparen (findFirst på organizationId) innan grinden körs.
const INKASSO_READY_INCLUDE = {
  tenant: { select: SAFE_TENANT_SELECT },
  organization: true,
} satisfies Prisma.RentNoticeInclude

type InkassoReadyNotice = Prisma.RentNoticeGetPayload<{ include: typeof INKASSO_READY_INCLUDE }>

const REMINDER_NOTICE_INCLUDE = {
  tenant: { select: SAFE_TENANT_SELECT },
  lease: { include: { unit: { include: { property: true } } } },
  lines: true,
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
  @Cron('0 10 * * *')
  async escalateOverdueRentNotices(): Promise<ReminderSummary> {
    const summary: ReminderSummary = { reminded: 0, skipped: 0, errors: 0, pausedStale: 0 }

    const candidates = await this.prisma.rentNotice.findMany({
      where: {
        status: 'OVERDUE',
        type: RentNoticeType.RENT,
        collectionStage: 'NONE',
        organization: { remindersEnabled: true },
      },
      include: { organization: true, tenant: { select: SAFE_TENANT_SELECT } },
    })

    // PR 4 (B) — pausa (och larma) eskaleringen för org vars betalningsdata är
    // inaktuell: påminnelseavgiften FLYTTAR FRAM kravet och tar betalt, så den får
    // inte rulla mot en hyresgäst som kan ha betalat utan att avstämningen vet det.
    const staleOrgs = await this.freshness.evaluateAndAlert(candidates.map((n) => n.organizationId))

    for (const notice of candidates) {
      try {
        if (staleOrgs.has(notice.organizationId)) {
          summary.pausedStale++
          continue
        }
        const daysOverdue = this.daysSince(notice.dueDate)
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
          await this.rentInterest.crystallizeInterest(notice.id, notice.organizationId, new Date())
        } catch (err) {
          this.logger.error(
            `Räntekristallisering misslyckades för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // Avgift + kravsteg är nu bokförda atomiskt. Köa påminnelse-PDF:en — om
        // utskicket fallerar är avgiften ändå korrekt tagen (samma mönster som
        // faktura-/avi-flödet); leveransstatus loggas av jobbet.
        await this.pdfQueue.enqueue({
          kind: 'avisering-reminder',
          organizationId: notice.organizationId,
          noticeId: notice.id,
        })
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
    const safeFee = Number.isFinite(fee) && fee > 0 ? fee : 0

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId,
          status: 'OVERDUE',
          collectionStage: 'NONE',
        },
        data: {
          collectionStage: 'REMINDED',
          remindedAt: now,
          reminderFeeAmount: new Prisma.Decimal(safeFee.toFixed(2)),
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
    })
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
  @Cron('0 11 * * *')
  async escalateRemindedToInkassoReady(): Promise<InkassoReadySummary> {
    const summary: InkassoReadySummary = {
      ready: 0,
      blocked: 0,
      skipped: 0,
      errors: 0,
      pausedStale: 0,
    }

    const candidates = await this.prisma.rentNotice.findMany({
      where: {
        status: 'OVERDUE',
        type: RentNoticeType.RENT,
        collectionStage: 'REMINDED',
        organization: { remindersEnabled: true },
      },
      include: {
        organization: { select: { rentReminderDay: true, rentInkassoDaysAfterReminder: true } },
      },
    })

    // PR 4 (B) — inkasso-redo FLYTTAR FRAM inkassoärendet (och slutkristalliserar
    // ränta). Pausa + larma för org med inaktuell betalningsdata.
    const staleOrgs = await this.freshness.evaluateAndAlert(candidates.map((n) => n.organizationId))

    for (const notice of candidates) {
      try {
        if (staleOrgs.has(notice.organizationId)) {
          summary.pausedStale++
          continue
        }
        const daysOverdue = this.daysSince(notice.dueDate)
        const threshold =
          notice.organization.rentReminderDay + notice.organization.rentInkassoDaysAfterReminder
        if (daysOverdue < threshold) {
          summary.skipped++
          continue
        }

        const res = await this.escalateNoticeToInkassoReady(notice.id, notice.organizationId)
        if (res.flipped) summary.ready++
        else summary.skipped++
      } catch (err) {
        // INV-B-grinden vägrade — ofullständigt underlag. Inte ett systemfel;
        // avin omprövas nästa dygn. Avvikelsen är redan loggad i avins egen logg.
        if (err instanceof ConflictException) {
          summary.blocked++
          this.logger.warn(`Inkasso-redo blockerad för avi ${notice.id}: ${err.message}`)
          continue
        }
        summary.errors++
        this.logger.error(
          `Inkasso-redo misslyckades för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    this.logger.log(
      `Inkasso-redo: ${summary.ready} klara, ${summary.blocked} blockerade, ${summary.skipped} hoppade över, ` +
        `${summary.pausedStale} pausade (inaktuell betalningsdata), ${summary.errors} fel`,
    )
    return summary
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
  async escalateNoticeToInkassoReady(
    noticeId: string,
    organizationId: string,
  ): Promise<{ flipped: boolean; missing?: string[] }> {
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

    // INV-B-grind. Avins egen logg (org redan verifierad ovan).
    const events = await this.prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId: noticeId },
      select: { type: true },
    })
    // PR 3a — steg 10 (utestående skuld) läses från den allokeringsderiverade
    // sanningskällan i stället för paidAmount-cachen. ocrOutstanding EXKLUDERAR
    // ränta (bevarar dagens explicita val: vi mäter den OCR-reglerbara delen).
    const debt = await this.rentDebt.outstanding(noticeId, organizationId)
    const missing = this.checkInkassoReadiness(notice, events, debt.ocrOutstanding)
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
    await this.rentInterest.crystallizeInterest(noticeId, organizationId, new Date())

    const now = new Date()
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId,
          status: 'OVERDUE',
          collectionStage: 'REMINDED',
        },
        data: { collectionStage: 'INKASSO_READY', collectionReadyAt: now },
      })
      if (claim.count === 0) return { flipped: false }

      // Färsk räntesnapshot EFTER slutkristalliseringen för COLLECTION_READY.
      const fresh = await tx.rentNotice.findUniqueOrThrow({
        where: { id: noticeId },
        select: {
          dueDate: true,
          totalAmount: true,
          consumptionAmount: true,
          reminderFeeAmount: true,
          interestAccruedAmount: true,
          interestAccruedThrough: true,
          reminderPdfStorageKey: true,
        },
      })
      const capital = Number(fresh.totalAmount) + Number(fresh.consumptionAmount)
      const totalClaim = round2(
        capital + Number(fresh.reminderFeeAmount) + Number(fresh.interestAccruedAmount),
      )

      await this.rentNoticeEvents.record(
        noticeId,
        'COLLECTION_READY',
        'SYSTEM',
        null,
        {
          daysOverdue: this.daysSince(fresh.dueDate),
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
    })
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
    events: { type: RentNoticeEventType }[],
    ocrOutstanding: number,
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
    if (!has('EMAIL_DELIVERED')) missing.push('påminnelsens leverans är inte verifierad')

    // 4. …och påminnelsen får inte ha studsat (utebliven/felaktig adress).
    if (has('EMAIL_BOUNCED')) missing.push('påminnelsen studsade (leverans misslyckades)')

    // 5. Utskickslogg — minst en SENT-händelse i avins historik.
    if (!has('SENT')) missing.push('utskickslogg (SENT) saknas')

    // 6. Komplett gäldenär: person- ELLER organisationsnummer.
    const t = notice.tenant
    if (!t?.personalNumber && !t?.orgNumber) {
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

    const alreadySent = await this.prisma.rentNoticeEvent.findFirst({
      where: { rentNoticeId: noticeId, type: 'SENT' },
      select: { id: true },
    })
    if (alreadySent) return

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

      const messageId = await this.mailService.sendRentNoticeReminder({
        to: notice.tenant.email,
        tenantName,
        noticeNumber: notice.noticeNumber,
        ocrNumber: notice.ocrNumber,
        originalAmount: Number(notice.totalAmount) + Number(notice.consumptionAmount),
        feeAmount: Number(notice.reminderFeeAmount),
        payableTotal: rentNoticePayableTotal(notice),
        dueDate: notice.dueDate,
        daysOverdue: this.daysSince(notice.dueDate),
        organizationName: org.name,
        accentColor: org.invoiceColor ?? '#2563EB',
        pdfBuffer,
        idempotencyKey: `rent-reminder-${notice.id}`,
      })

      await this.rentNoticeEvents.record(noticeId, 'SENT', 'SYSTEM', null, {
        channel: 'EMAIL',
        ...(messageId ? { messageId } : {}),
      })

      // Spara Resends message-id som webhookens korrelationsnyckel mot rätt avi
      // (@unique). Leveransutfallet (EMAIL_DELIVERED/EMAIL_BOUNCED) skrivs sedan
      // append-only till RentNoticeEvent av ResendWebhookService.
      if (messageId) {
        await this.prisma.rentNotice.update({
          where: { id: noticeId },
          data: { reminderMessageId: messageId },
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.rentNoticeEvents
        .record(noticeId, 'SEND_FAILED', 'SYSTEM', null, { reason: msg })
        .catch(() => undefined)
      throw err
    }
  }

  private daysSince(date: Date): number {
    const ms = Date.now() - date.getTime()
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

    const original = Number(notice.totalAmount) + Number(notice.consumptionAmount)
    const fee = Number(notice.reminderFeeAmount)
    const payable = rentNoticePayableTotal(notice)
    const daysOverdue = this.daysSince(notice.dueDate)
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
    // ALLA betalningsbärande fält (OCR, ursprungsbelopp, avgift, total, bankgiro,
    // förfallodatum, mottagare) är byte-för-byte oförändrade — bara ramen brandas.
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
    vi har inte registrerat någon betalning för hyresavi <strong>${notice.noticeNumber}</strong>
    som förföll ${dueDateStr}. Vänligen betala snarast. En påminnelseavgift enligt
    lag (1981:739) om ersättning för inkassokostnader har tillkommit.
  </p>

  <table style="margin-top:24px">
    <tr><td style="padding:6px 0;color:#6B7280">Ursprungligt belopp</td>
        <td style="padding:6px 0;text-align:right;color:#111827">${fmt(original)} kr</td></tr>
    ${feeRowHtml}
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
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
