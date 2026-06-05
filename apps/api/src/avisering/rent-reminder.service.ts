import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { Prisma, RentNoticeType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { AccountingService } from '../accounting/accounting.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { rentNoticePayableTotal } from '../common/utils/rent-notice-total.util'
import { getLogoDataUrl } from './avisering.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentInterestService } from './rent-interest.service'

interface ReminderSummary {
  reminded: number
  skipped: number
  errors: number
}

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
    const summary: ReminderSummary = { reminded: 0, skipped: 0, errors: 0 }

    const candidates = await this.prisma.rentNotice.findMany({
      where: {
        status: 'OVERDUE',
        type: RentNoticeType.RENT,
        collectionStage: 'NONE',
        organization: { remindersEnabled: true },
      },
      include: { organization: true, tenant: { select: SAFE_TENANT_SELECT } },
    })

    for (const notice of candidates) {
      try {
        const daysOverdue = this.daysSince(notice.dueDate)
        if (daysOverdue < notice.organization.rentReminderDay) {
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
      `Hyrespåminnelser: ${summary.reminded} skickade, ${summary.skipped} hoppades över, ${summary.errors} fel`,
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
      logoStorageKey?: string | null
    },
  ): Promise<string> {
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)
    const accent = org.invoiceColor ?? '#1a6b3c'
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

    return `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"/>
<style>
  body { font-family: -apple-system, Arial, sans-serif; color:#111827; margin:0; padding:40px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px; }
  .title { font-size:22px; font-weight:700; color:${accent}; margin:0 0 4px; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  .totalrow td { border-top:2px solid #111827; padding-top:10px; font-weight:700; font-size:15px; }
  .ocrbox { background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px; padding:16px 20px; margin-top:24px; }
  .mono { font-family:monospace; font-weight:700; letter-spacing:0.06em; }
  .muted { color:#6B7280; font-size:12px; }
</style></head>
<body>
  <div class="header">
    <div>
      <p class="title">Betalningspåminnelse</p>
      <p class="muted">Avi ${notice.noticeNumber}${daysOverdue > 0 ? ` · ${daysOverdue} dagar förfallen` : ''}</p>
    </div>
    ${logoDataUrl ? `<img src="${logoDataUrl}" alt="" style="max-height:48px"/>` : `<div style="font-weight:700">${org.name}</div>`}
  </div>

  ${orgAddressHtml}

  <p style="font-size:13.5px;line-height:1.6">
    ${tenantName ? `Hej ${tenantName},<br/>` : ''}
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
  </p>
</body></html>`
  }
}
