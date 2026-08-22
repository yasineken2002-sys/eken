import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  ConflictException,
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
import { REMINDER_FEE_LINE_DESCRIPTION } from '../invoices/reminder-fee-line'
import { resolveInvoiceDebtOrigin } from '../accounting/debt-origin'
import { resolveReminderFee, reminderFeeCapMessage } from '../accounting/reminder-fee'
import { NotificationsService } from './notifications.service'
import { AccountingService } from '../accounting/accounting.service'
import { SAFE_CUSTOMER_SELECT } from '../customers/customers.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { resolveActorType, aiOriginColumns } from '../common/ai-origin/ai-origin.context'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

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
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // Mail-kön dedupar: statisk idempotencyKey
  // (reminder-friendly-/reminder-formal-<invoiceId>) sätts som Bull jobId i
  // mail.queue.ts:96, så två köade jobb blir ett.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
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
            // G2: avtalsgrunden för påminnelseavgiften bor på avtalet. En
            // faktura utan lease (kundfaktura) får null → ingen avgift.
            lease: { select: { reminderFeeTermsFrom: true } },
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
            creditNotes: { select: { total: true } },
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
            //
            // #352 PR 2 FÖRSÖKTE LÄGGA EN DEPOSIT-SPÄRR HÄR OCH BACKADE. Skälet
            // är mätt, inte antaget, och är värt att spara:
            //
            // Grenarna är en if/continue-kedja — inkasso (30+), formell (14+),
            // vänlig (1–7). Spärras BARA inkassogrenen för DEPOSIT faller
            // fakturan ner i nästa gren i stället för att lämnas i fred. För en
            // deposition som når dag 30+ UTAN att ha fått sin formella
            // påminnelse (pausad och återupptagen, utebliven cron-körning,
            // bakdaterad förfallodag) blir följden att den i stället får
            // FORMELL PÅMINNELSE MED AVGIFT bokförd på 3593.
            //
            // Mätt: deposition 40 dagar, inga tidigare påminnelser →
            //   före spärr:  readyForCollection 1, avgift 0
            //   efter spärr: formalSent 1,        avgift 1
            //
            // Spärren gjorde alltså saken VÄRRE i exakt den dimension #352 finns
            // för att laga. Steg 5 kan därför inte stängas isolerat — det kräver
            // att steg 4 stängs samtidigt, och det är PR 1b, som väntar på ett
            // juridiskt beslut. PR 1b är alltså inte bara "nästa" utan en
            // FÖRUTSÄTTNING för den här spärren.
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
              // #357: utfallet avgör räknaren. `enqueueSafely` kastar aldrig, så
              // ett misslyckat köande hade annars räknats som en skickad formell
              // påminnelse och loggraden hade påstått det. Avi-vägen gör samma
              // sak via `isEnqueueProblem` (rent-reminder.service.ts:229).
              const sent = await this.sendFormalReminder(invoice, party.email, daysOverdue)
              if (sent) summary.formalSent++
              else summary.errors++
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
        creditNotes: { select: { total: true } },
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
        // #352 PR 2 — TYPEN MÅSTE NÅ VYN. En förfallen deposition SKA synas här
        // (annars går den enskilda export-vägen inte att hitta), men den kan
        // inte bulk-exporteras. Utan `type` kan gränssnittet inte skilja på
        // "kan exporteras i batch" och "kräver enskilt beslut" — och en
        // kryssruta som ser markerad ut men tyst faller bort ur resultatet är
        // en fälla, inte ett skydd.
        type: inv.type,
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
          credits: inv.creditNotes.map((c) => c.total),
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
        creditNotes: { select: { total: true } }
        lease: { select: { reminderFeeTermsFrom: true } }
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
      organizationId: invoice.organizationId,
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
        actorType: resolveActorType('SYSTEM'),
        ...aiOriginColumns(),
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
        creditNotes: { select: { total: true } }
        lease: { select: { reminderFeeTermsFrom: true } }
      }
    }>,
    email: string,
    daysOverdue: number,
  ): Promise<boolean> {
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
    // #357 tog bort den första variabeln helt: fakturans total räknas nu upp med
    // `increment` inne i transaktionen, så det nominella beloppet läses aldrig
    // ut hit. Sammanblandningen är därmed inte längre möjlig att göra — bara
    // brevets belopp beräknas här.
    //
    // ── G2: AVGIFTENS BELOPP AVGÖRS FÖRE ANSPRÅKET ────────────────────────
    //
    // Måste ske här, inte i bokföringen: anspråket nedan räknar upp
    // `invoice.total`, skriver avgiftsraden och sätter `PaymentReminder.feeAmount`
    // (som inkassounderlaget summerar rakt in i sin avgiftskolumn). Avgjordes
    // beloppet först i `bookReminderFee` skulle fakturan kräva ett belopp som
    // huvudboken inte bär — exakt den divergens #357 stängde, med omvänt tecken.
    //
    // `resolveReminderFee` bär BÅDA reglerna:
    //   • avtalsgrunden — en faktura utan hyresavtal (ren kundfaktura) har ingen
    //     alls → `termsFrom` null → ingen avgift. Rätt utfall: villkoret avtalas
    //     i hyresavtalet, och finns inget avtal finns inget villkor.
    //   • det lagstadgade taket — ett för högt värde i `reminderFeeSek` klampas
    //     här, INNAN någon skrivning ser det.
    //
    // Den fångar också det negativa fallet (FAR M2, #357): `bookReminderFee`
    // returnerar null för ALLA fee <= 0 medan anroparen bara grindar på > 0, så
    // ett negativt belopp hade skrivit en negativ avgiftsrad, MINSKAT fakturans
    // total och inte bokfört något.
    //
    // Datumet konstrueras ALDRIG här. `resolveInvoiceDebtOrigin` äger regeln
    // (fakturans `issueDate`), och dess brandade returtyp är det enda
    // `bookReminderFee` accepterar.
    const debtOrigin = resolveInvoiceDebtOrigin(invoice)
    const termsFrom = invoice.lease?.reminderFeeTermsFrom ?? null
    const feeDecision = resolveReminderFee(fee, debtOrigin, termsFrom)
    const safeFee = feeDecision.amount
    if (feeDecision.cappedByLaw) {
      this.logger.warn(
        reminderFeeCapMessage(
          invoice.organizationId,
          feeDecision,
          `faktura ${invoice.invoiceNumber}`,
        ),
      )
    }

    // Restskulden FÖRE avgiften — det hyresgästen är skyldig just nu.
    const outstandingBefore = invoiceOutstanding(invoice)
    const outstandingWithFee = outstandingBefore + safeFee

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
            feeAmount: new Prisma.Decimal(safeFee.toFixed(2)),
          },
        ],
        skipDuplicates: true,
      })
      if (claim.count === 0) return false

      // ── ANDRA ANSPRÅKET: förutsättningarna omprövas INNE i transaktionen ────
      //
      // Avi-vägens claim omprövar affärsvillkoren (`status`, `collectionStage`,
      // `isBackfill`, `organizationId`); fakturasidans markör-claim säger bara
      // "inte redan påmind". Allt annat — status, pausflaggan, restskulden —
      // lästes i cronens `findMany` FÖRE loopen, och loopen kan gå länge (varje
      // faktura väntar upp till 5 s på köandet). Betalar hyresgästen eller
      // pausar operatören kravtrappan mitt i körningen togs avgiften ändå, och
      // bokfördes. (FAR M3 — beteendet fanns före #357, men den nya strukturen
      // är platsen att stänga det.)
      //
      // `increment` i stället för ett absolut värde: totalen härleddes ur en
      // läsning UTANFÖR transaktionen (`nominalTotal + safeFee`), vilket är lost
      // update-formen. Inte utlösbar i dag, men fel form — och ett relativt
      // tillägg kan dessutom aldrig bära restskulden av misstag, vilket var
      // felformen #329 lagade. (FAR M4.)
      //
      // Körs även när avgiften är 0 — då är det en ren omprövning av
      // förutsättningarna, och `increment: 0` skriver inget belopp.
      const bumped = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          organizationId: invoice.organizationId,
          status: 'OVERDUE',
          remindersPaused: false,
        },
        // ── #363: SUBTOTAL FÖLJER MED TOTAL ────────────────────────────────
        //
        // `computeInvoiceAmounts` håller invarianten "subtotal + moms = total"
        // exakt, och faktura-PDF:en skriver ut alla tre som egna poster. Växte
        // bara `total` summerade "Netto exkl. moms" + "Moms" inte längre till
        // "Att betala" — de skiljde exakt avgiften, i ett dokument hyresgästen
        // kan räkna efter.
        //
        // `vatTotal` rörs INTE: avgiftsraden skrivs med `vatRate: 0` några rader
        // ned och bokförs 1510 D / 3593 K utan momskonto. Hela beloppet hör till
        // nettot, så att flytta momsen hade brutit invarianten i andra riktningen.
        //
        // Relativt tillägg av samma skäl som `total` (#357, FAR M4): ett absolut
        // värde här hade härletts ur en läsning UTANFÖR transaktionen, alltså
        // lost update-formen.
        data: {
          total: { increment: new Prisma.Decimal(safeFee.toFixed(2)) },
          subtotal: { increment: new Prisma.Decimal(safeFee.toFixed(2)) },
        },
      })
      if (bumped.count === 0) {
        throw new ConflictException(
          `Faktura ${invoice.id} ändrade tillstånd under påminnelsekörningen ` +
            '(betald, pausad eller makulerad) — ingen avgift togs.',
        )
      }

      // Avgiftsrad OCH bokföring grindas på samma villkor. En rad på 0,00 kr med
      // texten "enligt lag" är ingen affärshändelse, men den följer med ut på
      // fakturaunderlaget och i inkassokravets radtabell och påstår där en
      // lagstadgad avgift på noll kronor. (FAR M1.)
      if (safeFee > 0) {
        await tx.invoiceLine.create({
          data: {
            invoiceId: invoice.id,
            // Delad konstant — VOID-grenen i InvoicesService plockar bort raden
            // igen och känner bara igen den på texten (InvoiceLine saknar typkolumn).
            description: REMINDER_FEE_LINE_DESCRIPTION,
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal(safeFee.toFixed(2)),
            vatRate: 0,
            total: new Prisma.Decimal(safeFee.toFixed(2)),
          },
        })

        // INV-A (avi-vägens invariant, nu även här): ingen avgift utan verifikat.
        // `bookReminderFee` returnerar null både när avgiften är ≤ 0 OCH när
        // 1510/3593 saknas i kontoplanen — de två fallen får INTE behandlas lika.
        // Här är avgiften bevisligen > 0, så null betyder saknad kontoplan: då
        // ska hela transaktionen rullas tillbaka i stället för att kräva
        // hyresgästen på något som aldrig når räkenskaperna.
        const entry = await this.accounting.bookReminderFee({
          organizationId: invoice.organizationId,
          source: 'INVOICE',
          sourceId: `reminder-fee:${invoice.id}`,
          fee: safeFee,
          // BFL 5 kap 7 §: verifikationen ska ange vad händelsen avser och vilken
          // motpart den berör, sökbart utan svårighet. Ett UUID är inget en
          // revisor kan slå upp i reskontran — fakturanumret är det. (FAR M7.)
          description: `Påminnelseavgift faktura ${invoice.invoiceNumber} – ${tenantName}`,
          debtOrigin,
          termsFrom,
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
          actorType: resolveActorType('SYSTEM'),
          ...aiOriginColumns(),
          actorLabel: 'Formell påminnelse',
          payload: { reminderType: 'REMINDER_FORMAL', daysOverdue, fee: safeFee },
        },
      })
      return true
    }, PRISMA_DEFAULT_TX_LIMITS)

    // Anspråket togs av någon annan (dubbel cron-fire, retry efter lyckad
    // körning). Ingen andra avgift, inget andra utskick — och ingen räknas som
    // skickad.
    if (!claimed) return false

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
          organizationId: invoice.organizationId,
          tenantName,
          invoiceNumber: invoice.invoiceNumber,
          // #329 — brevets siffror är RESTSKULDEN, inte fakturans nominella total.
          outstandingBeforeFee: outstandingBefore,
          feeAmount: safeFee,
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
        // Landar jobbet efter golvet är det ett FALSKLARM, och markören ska inte
        // för alltid se ut som en missad leverans. Jobb-id:t är deterministiskt
        // (`jobId = idempotencyKey`), så korrelationen kan skrivas i efterhand.
        // Callbacken körs frånkopplat och får aldrig kasta vidare. (FAR M6.)
        onLateOutcome: (landed) => {
          if (!landed) return
          void this.prisma.paymentReminder
            .updateMany({
              where: {
                invoiceId: invoice.id,
                type: 'REMINDER_FORMAL',
                invoice: { organizationId: invoice.organizationId },
              },
              data: { emailMessageId: `reminder-formal-${invoice.id}` },
            })
            .catch(() => undefined)
        },
      },
    )

    // Leveranskorrelationen skrivs i efterhand. Den är en NOTERING, inte en
    // spärr: markören som styr idempotensen är redan committad ovan, och ett
    // misslyckat köande får inte göra avgiften ogjord.
    if (outcome.status === 'ok') {
      await this.prisma.paymentReminder.updateMany({
        // `PaymentReminder` bär inget eget `organizationId` och kan bara scopas
        // via `Invoice`. Bindningen står här som FÖRSVAR I DJUPET: cronen äger
        // alla organisationer och `invoice` kommer från dess eget urval, så det
        // finns ingen anropare som kan smuggla in ett främmande id — men en
        // framtida anropare ska inte kunna det heller, och scopningen ska gå att
        // granska på plats. (Objektnivå-grinden, #273/#274.)
        where: {
          invoiceId: invoice.id,
          type: 'REMINDER_FORMAL',
          invoice: { organizationId: invoice.organizationId },
        },
        data: { emailMessageId: outcome.jobId },
      })
      return true
    }

    // ── FAILED och TIMEOUT är INTE samma sak ─────────────────────────────────
    //
    // `enqueue-safety.ts` är uttrycklig: TIMEOUT betyder "kunde inte bekräftas",
    // inte "blev inte av" — mätt där: en 5–8 s Redis-blip ger timeout men jobbet
    // landar efter 11,3 s. Att i det läget påstå att hyresgästen inte fått
    // brevet är ett påstående systemet inte kan belägga, och det kan leda till
    // att en korrekt avgift krediteras i onödan. (FAR M6.)
    this.logger.error(
      outcome.status === 'failed'
        ? `Formell påminnelse faktura ${invoice.invoiceNumber}: avgiften är bokförd men ` +
            'utskicket MISSLYCKADES — hyresgästen har debiterats utan att ha fått brevet.'
        : `Formell påminnelse faktura ${invoice.invoiceNumber}: avgiften är bokförd men ` +
            'köandet KUNDE INTE BEKRÄFTAS inom tidsgränsen — brevet kan ha gått ut ändå. ' +
            'Kontrollera leveransen innan avgiften ifrågasätts.',
    )

    // `InvoiceEvent` är append-only: `REMINDER_SENT` skrevs i transaktionen,
    // innan utskicket var känt, och kan aldrig rättas. Utan en kompenserande
    // post säger den logg som operatören — och inkassoexporten — läser att ett
    // brev gick ut. Båda systerflödena skriver `SEND_FAILED` i just det läget.
    await this.prisma.invoiceEvent
      .create({
        data: {
          invoiceId: invoice.id,
          type: 'SEND_FAILED',
          actorType: resolveActorType('SYSTEM'),
          ...aiOriginColumns(),
          actorLabel: 'Formell påminnelse',
          payload: {
            reminderType: 'REMINDER_FORMAL',
            fee: safeFee,
            enqueueStatus: outcome.status,
          },
        },
      })
      .catch(() => undefined)

    return false
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
        actorType: resolveActorType('SYSTEM'),
        ...aiOriginColumns(),
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
