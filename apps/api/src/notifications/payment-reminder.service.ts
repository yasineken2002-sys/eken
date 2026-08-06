import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { Prisma } from '@prisma/client'
import type { PaymentReminderType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { runCronSafely } from '../common/cron/cron-safety'
import { enqueueSafely } from '../common/queue/enqueue-safety'
import { MailService } from '../mail/mail.service'
import { QUEUE_NORMAL } from '../mail/mail.types'
import { computeInvoiceDebt, invoiceOutstanding } from '../invoices/invoice-debt'
import { NotificationsService } from './notifications.service'
import { AccountingService } from '../accounting/accounting.service'
import { SAFE_CUSTOMER_SELECT } from '../customers/customers.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

interface ProcessSummary {
  friendlySent: number
  formalSent: number
  readyForCollection: number
  errors: number
  skipped: number
}

@Injectable()
export class PaymentReminderService {
  private readonly logger = new Logger(PaymentReminderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly accounting: AccountingService,
  ) {}

  /**
   * Cron-jobb som körs dagligen kl 09:00. Itererar över alla förfallna
   * fakturor och triggar lämplig påminnelsenivå baserat på dagar sedan
   * förfall + organisationens inställningar.
   *
   * Idempotency: PaymentReminder har UNIQUE (invoiceId, type), så samma
   * påminnelsetyp kan aldrig skickas två gånger för samma faktura. En
   * cron-restart eller dubbel cron-fire blir därmed harmlös.
   */
  @Cron('0 9 * * *')
  async processOverdueReminders(): Promise<ProcessSummary> {
    const summary: ProcessSummary = {
      friendlySent: 0,
      formalSent: 0,
      readyForCollection: 0,
      errors: 0,
      skipped: 0,
    }

    // T5 B1b — linda hela cron-kroppen: en DB-blipp på findMany larmar nu via
    // Sentry istället för tyst död. Per-invoice-isoleringen (try/catch nedan) och
    // summeringen är OFÖRÄNDRADE — summary muteras in-place och returneras nedan.
    await runCronSafely(
      'payment-reminder-process-overdue',
      async () => {
        const overdue = await this.prisma.invoice.findMany({
          where: {
            status: 'OVERDUE',
            remindersPaused: false,
          },
          include: {
            tenant: { select: SAFE_TENANT_SELECT },
            customer: { select: SAFE_CUSTOMER_SELECT },
            organization: true,
            paymentReminders: true,
            // ── #329: RESTSKULDEN GÅR INTE ATT RÄKNA UTAN ALLOKERINGARNA ────
            //
            // Breven visade `invoice.total` — ursprungsbeloppet — medan vyerna
            // sedan #322 visar restskulden. Operatören såg 2 000 i systemet
            // medan hyresgästen fick krav på 10 000.
            //
            // URVALET ÄR OFÖRÄNDRAT: `where` rörs inte, bara `include`. Exakt
            // samma fakturor påminns som förut — det enda som ändras är vilket
            // belopp brevet bär.
            payments: { select: { amount: true } },
          },
        })

        for (const invoice of overdue) {
          try {
            const org = invoice.organization
            if (!org.remindersEnabled) {
              summary.skipped++
              continue
            }

            const party = invoice.tenant ?? invoice.customer
            if (!party?.email) {
              summary.skipped++
              continue
            }

            const daysOverdue = this.daysSince(invoice.dueDate)
            const sentTypes = new Set<PaymentReminderType>(
              invoice.paymentReminders.map((r) => r.type),
            )

            // ── Dag 30+ → markera redo för inkasso ───────────────────────────
            if (
              daysOverdue >= org.reminderCollectionDay &&
              !sentTypes.has('READY_FOR_COLLECTION')
            ) {
              await this.markReadyForCollection(invoice.id, org.id, daysOverdue)
              summary.readyForCollection++
              continue
            }

            // ── Dag formal+ → formell påminnelse + 60 kr avgift ──────────────
            if (daysOverdue >= org.reminderFormalDay && !sentTypes.has('REMINDER_FORMAL')) {
              await this.sendFormalReminder(invoice, party.email, daysOverdue)
              summary.formalSent++
              continue
            }

            // ── Dag 1-7 → vänlig påminnelse, ingen avgift ────────────────────
            if (daysOverdue >= 1 && daysOverdue <= 7 && !sentTypes.has('REMINDER_FRIENDLY')) {
              await this.sendFriendlyReminder(invoice, party.email, daysOverdue)
              summary.friendlySent++
              continue
            }

            summary.skipped++
          } catch (err) {
            this.logger.error(
              `Reminder failed for invoice ${invoice.id}: ${err instanceof Error ? err.message : String(err)}`,
            )
            summary.errors++
          }
        }

        this.logger.log(
          `Påminnelser: ${summary.friendlySent} vänliga, ${summary.formalSent} formella, ${summary.readyForCollection} markerade redo för inkasso, ${summary.errors} fel, ${summary.skipped} hoppades över`,
        )
      },
      { logger: this.logger },
    )
    return summary
  }

  // ── Manuella triggers (används av AI-tools / UI) ─────────────────────────

  async pauseReminders(invoiceId: string, organizationId: string, reason?: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      throw new BadRequestException('Kan inte pausa påminnelser på en avslutad faktura')
    }
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        remindersPaused: true,
        remindersPausedAt: new Date(),
        ...(reason ? { remindersPausedReason: reason } : { remindersPausedReason: null }),
      },
    })
  }

  async resumeReminders(invoiceId: string, organizationId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        remindersPaused: false,
        remindersPausedAt: null,
        remindersPausedReason: null,
      },
    })
  }

  async getOverdueStatus(organizationId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['OVERDUE', 'SENT_TO_COLLECTION'] },
      },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
        paymentReminders: { orderBy: { sentAt: 'desc' } },
        // #307A: vyn ska visa RESTSKULDEN, inte ursprungsbeloppet — därför
        // behövs allokeringarna. Selecten är avsiktligt smal: bara beloppet.
        payments: { select: { amount: true } },
      },
      orderBy: { dueDate: 'asc' },
    })

    return invoices.map((inv) => {
      const party = inv.tenant ?? inv.customer
      const daysOverdue = this.daysSince(inv.dueDate)
      const reminders = inv.paymentReminders
      const lastReminder = reminders[0] ?? null
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        // ── #307A: RESTSKULDEN, INTE URSPRUNGSBELOPPET ────────────────────
        //
        // Här stod `Number(inv.total)`. Urvalet ovan innehåller
        // SENT_TO_COLLECTION, och en delbetald faktura KAN stå där: exporten
        // släppte igenom PARTIAL, statusen blev SENT_TO_COLLECTION, och den här
        // vyn visade sedan hela ursprungsbeloppet. Inkassovyn och AI-verktyget
        // (tool-executor `get_overdue_status`) läser båda den här siffran, så
        // operatörens beslutsunderlag ljög om skuldens storlek.
        //
        // Till skillnad från PR 2a rör det INTE ett dokument som går externt —
        // ingen Inkassolagen-fråga — men det är underlaget en människa fattar
        // beslut på, och samma sanningskälla ska gälla överallt.
        //
        // URVALET ÄR OFÖRÄNDRAT. Bara beloppet ändras; exakt samma fakturor
        // listas som förut.
        total: computeInvoiceDebt({
          total: inv.total,
          allocations: inv.payments.map((p) => p.amount),
        }).outstanding.toNumber(),
        dueDate: inv.dueDate,
        daysOverdue,
        remindersPaused: inv.remindersPaused,
        sentToCollectionAt: inv.sentToCollectionAt,
        tenantName: party
          ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
          : '–',
        tenantEmail: party?.email ?? null,
        reminderCount: reminders.length,
        reminders: reminders.map((r) => ({
          type: r.type,
          sentAt: r.sentAt,
          feeAmount: Number(r.feeAmount),
        })),
        lastReminderType: lastReminder?.type ?? null,
        lastReminderAt: lastReminder?.sentAt ?? null,
      }
    })
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

  private daysSince(date: Date): number {
    const now = new Date()
    const ms = now.getTime() - date.getTime()
    return Math.floor(ms / (24 * 60 * 60 * 1000))
  }

  private async sendFriendlyReminder(
    invoice: Prisma.InvoiceGetPayload<{
      include: {
        tenant: { select: typeof SAFE_TENANT_SELECT }
        customer: { select: typeof SAFE_CUSTOMER_SELECT }
        organization: true
        paymentReminders: true
        payments: { select: { amount: true } }
      }
    }>,
    email: string,
    daysOverdue: number,
  ): Promise<void> {
    const party = invoice.tenant ?? invoice.customer
    const tenantName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : 'Hyresgäst'

    const messageId = await this.mail.sendReminderFriendly({
      to: email,
      tenantName,
      invoiceNumber: invoice.invoiceNumber,
      // #329 — RESTSKULDEN, inte ursprungsbeloppet. Brevet ber hyresgästen
      // betala; då måste siffran vara vad hen faktiskt är skyldig.
      total: invoiceOutstanding(invoice),
      dueDate: invoice.dueDate,
      daysOverdue,
      organizationName: invoice.organization.name,
      ocrNumber: invoice.ocrNumber,
      bankgiro: invoice.organization.bankgiro,
      idempotencyKey: `reminder-friendly-${invoice.id}`,
    })

    await this.prisma.paymentReminder.create({
      data: {
        invoiceId: invoice.id,
        type: 'REMINDER_FRIENDLY',
        feeAmount: 0,
        emailMessageId: messageId,
      },
    })

    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId: invoice.id,
        type: 'REMINDER_SENT',
        actorType: 'SYSTEM',
        actorLabel: 'Vänlig påminnelse',
        payload: { reminderType: 'REMINDER_FRIENDLY', daysOverdue, fee: 0 },
      },
    })
  }

  private async sendFormalReminder(
    invoice: Prisma.InvoiceGetPayload<{
      include: {
        tenant: { select: typeof SAFE_TENANT_SELECT }
        customer: { select: typeof SAFE_CUSTOMER_SELECT }
        organization: true
        paymentReminders: true
        payments: { select: { amount: true } }
      }
    }>,
    email: string,
    daysOverdue: number,
  ): Promise<void> {
    const party = invoice.tenant ?? invoice.customer
    const tenantName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : 'Hyresgäst'

    const fee = Number(invoice.organization.reminderFeeSek)

    // ── #329: TVÅ OLIKA BELOPP, TIDIGARE SAMMA VARIABEL ──────────────────────
    //
    // `originalTotal = Number(invoice.total)` användes till TVÅ saker som bara
    // råkade sammanfalla när fakturan var obetald:
    //
    //   1. FAKTURANS NOMINELLA TOTAL, som avgiften skrivs in i. Här är
    //      `invoice.total` RÄTT och SKA växa — fakturan är på ett större belopp
    //      efter att avgiften lagts till. Rör man den blir avgiftsbokföringen
    //      fel i stället.
    //   2. BELOPPET I BREVET till hyresgästen. Här är `invoice.total` FEL så
    //      snart något är betalt: brevet krävde ursprungsbeloppet av någon som
    //      redan betalat en del av det.
    //
    // De är åtskilda nu, med namn som säger vilket som är vilket.
    const nominalTotal = Number(invoice.total)
    const nominalTotalWithFee = nominalTotal + fee

    // Restskulden FÖRE avgiften — det hyresgästen är skyldig just nu.
    const outstandingBefore = invoiceOutstanding(invoice)
    const outstandingWithFee = outstandingBefore + fee

    // ── #357: HELA AVGIFTEN I EN TRANSAKTION, MARKÖREN FÖRST ─────────────────
    //
    // Tidigare skrevs avgiftsraden, verifikatet, utskicket och markören i FYRA
    // separata transaktioner med markören SIST. Ett kast däremellan (kön nere,
    // DB-blipp, processdöd) lämnade fakturan uppskriven UTAN markör — och nästa
    // dygns cron-körning såg ingen `REMINDER_FORMAL` i `sentTypes` och lade på
    // en avgiftsrad till. `bookReminderFee` är däremot idempotent på sin
    // `sourceId`, så verifikatet skrevs bara en gång:
    //
    //     reskontra 120 kr krävt   vs   huvudbok 60 kr bokfört
    //
    // Mätt mot riktig Postgres (#357): två `InvoiceLine`, `total` 9120, ETT
    // verifikat på 3593. `@@unique([invoiceId, type])` fanns hela tiden men kan
    // bara verka på en rad som skrivits — en spärr som skrivs sist är ingen
    // spärr mot det som kastar innan.
    //
    // MALLEN ÄR AVI-VÄGEN, inte något nytt: `escalateNoticeToReminded` tar ett
    // VILLKORAT ANSPRÅK först, bokför i samma `tx`, kastar om verifikatet
    // uteblir, och köar utskicket EFTER commit. Riggen försökte fälla den i två
    // scenarier och lyckades inte. Här speglas exakt det.
    //
    // `createMany` + `skipDuplicates` är fakturasidans motsvarighet till avins
    // `updateMany`-claim: unik-villkoret gör `count === 0` till ett entydigt
    // "någon annan har redan tagit avgiften" — utan att göra undantag till
    // styrflöde, och race-säkert eftersom villkoret ligger i databasen.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.paymentReminder.createMany({
        data: [
          {
            invoiceId: invoice.id,
            type: 'REMINDER_FORMAL',
            feeAmount: new Prisma.Decimal(fee.toFixed(2)),
          },
        ],
        skipDuplicates: true,
      })
      if (claim.count === 0) return false

      await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          description: 'Påminnelseavgift enligt lag (1981:739)',
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(fee.toFixed(2)),
          vatRate: 0,
          total: new Prisma.Decimal(fee.toFixed(2)),
        },
      })
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          // NOMINELLT belopp — inte restskulden. Fakturan är på ett större
          // belopp efter avgiften; restskulden följer med automatiskt eftersom
          // den är `total − Σ allokeringar`.
          total: new Prisma.Decimal(nominalTotalWithFee.toFixed(2)),
        },
      })

      // INV-A (avi-vägens invariant, nu även här): ingen avgift utan verifikat.
      // `bookReminderFee` returnerar null både när avgiften är ≤ 0 OCH när
      // 1510/3593 saknas i kontoplanen — de två fallen får INTE behandlas lika.
      // Är avgiften 0 har org konfigurerat bort den och det finns inget att
      // bokföra. Saknas kontona är avgiften obokförbar, och då ska hela
      // transaktionen rullas tillbaka i stället för att kräva hyresgästen på
      // något som aldrig når räkenskaperna.
      if (fee > 0) {
        const entry = await this.accounting.bookReminderFee({
          organizationId: invoice.organizationId,
          source: 'INVOICE',
          sourceId: `reminder-fee:${invoice.id}`,
          fee,
          description: `Påminnelseavgift faktura ${invoice.id}`,
          tx,
        })
        if (!entry) {
          throw new InternalServerErrorException(
            `Påminnelseavgift kunde inte bokföras för faktura ${invoice.id} — ` +
              'kontrollera att kontoplanen innehåller konto 1510 och 3593.',
          )
        }
      }

      await tx.invoiceEvent.create({
        data: {
          invoiceId: invoice.id,
          type: 'REMINDER_SENT',
          actorType: 'SYSTEM',
          actorLabel: 'Formell påminnelse',
          payload: { reminderType: 'REMINDER_FORMAL', daysOverdue, fee },
        },
      })
      return true
    })

    // Anspråket togs av någon annan (dubbel cron-fire, retry efter lyckad
    // körning). Ingen andra avgift, inget andra utskick.
    if (!claimed) return

    // ── Utskicket ligger EFTER commit — samma ordning som avi-vägen ───────────
    //
    // Pengarna är nu korrekt tagna och bokförda. Ett kö-fel får därför inte
    // rulla tillbaka avgiften: då hade vi bytt en osynk mot en annan. Men det
    // är ett PENGASTÄLLE — avgiften ÄR debiterad, så ett tyst misslyckat
    // utskick betyder att hyresgästen betalar för en påminnelse som aldrig kom.
    // `enqueueSafely` kastar aldrig, golvar väntetiden och larmar via Sentry
    // (samma hantering som `rent-reminder.service.ts` gör på sitt pengaställe).
    const outcome = await enqueueSafely(
      () =>
        this.mail.sendReminderFormal({
          to: email,
          tenantName,
          invoiceNumber: invoice.invoiceNumber,
          // #329 — brevets siffror är RESTSKULDEN, inte fakturans nominella total.
          outstandingBeforeFee: outstandingBefore,
          feeAmount: fee,
          newTotal: outstandingWithFee,
          dueDate: invoice.dueDate,
          daysOverdue,
          organizationName: invoice.organization.name,
          ocrNumber: invoice.ocrNumber,
          bankgiro: invoice.organization.bankgiro,
          collectionDay: invoice.organization.reminderCollectionDay,
          idempotencyKey: `reminder-formal-${invoice.id}`,
        }),
      {
        queue: QUEUE_NORMAL,
        jobType: 'reminder-formal',
        organizationId: invoice.organizationId,
        logger: this.logger,
      },
    )

    // Leveranskorrelationen skrivs i efterhand. Den är en NOTERING, inte en
    // spärr: markören som styr idempotensen är redan committad ovan, och ett
    // misslyckat köande får inte göra avgiften ogjord.
    if (outcome.status === 'ok') {
      await this.prisma.paymentReminder.updateMany({
        where: { invoiceId: invoice.id, type: 'REMINDER_FORMAL' },
        data: { emailMessageId: outcome.jobId },
      })
    } else {
      this.logger.error(
        `Formell påminnelse för faktura ${invoice.id}: avgiften är bokförd men ` +
          'utskicket kunde inte köas — hyresgästen har debiterats utan att ha fått brevet.',
      )
    }
  }

  private async markReadyForCollection(
    invoiceId: string,
    organizationId: string,
    daysOverdue: number,
  ): Promise<void> {
    await this.prisma.paymentReminder.create({
      data: {
        invoiceId,
        type: 'READY_FOR_COLLECTION',
        feeAmount: 0,
      },
    })

    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId,
        type: 'DEBT_COLLECTION',
        actorType: 'SYSTEM',
        actorLabel: 'Markerad redo för inkasso',
        payload: { daysOverdue },
      },
    })

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
      },
    })
    const party = invoice?.tenant ?? invoice?.customer
    const tenantName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : 'okänd hyresgäst'

    void this.notifications
      .createForAllOrgUsers(
        organizationId,
        'INVOICE_OVERDUE',
        '⚠️ Faktura redo för inkasso',
        `Faktura ${invoice?.invoiceNumber} (${tenantName}) är förfallen ${daysOverdue} dagar och redo att skickas till inkasso. Generera underlag i Inkasso-vyn.`,
        { relatedEntityType: 'INVOICE', relatedEntityId: invoiceId },
      )
      .catch(() => undefined)
  }

  // #357: den privata `bookReminderFee`-wrappern är BORTTAGEN. Den anropade den
  // delade kärnan UTAN `tx` och UTAN att kontrollera returvärdet — vilket var
  // exakt det som gjorde att en avgift kunde debiteras utan verifikat när
  // 1510/3593 saknades. Anropet ligger nu inlinat i `sendFormalReminder`, inuti
  // transaktionen och med `null` som kastfall. Konteringen sker fortfarande
  // enbart i AccountingService — ingen bokföringslogik har flyttat hit.
}
