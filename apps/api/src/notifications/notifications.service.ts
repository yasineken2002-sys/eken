import type { OnModuleInit } from '@nestjs/common'
import { Injectable, Logger } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { Cron, CronExpression } from '@nestjs/schedule'
import type { Notification, NotificationType, Prisma } from '@prisma/client'
import { formatCurrency, DEFAULT_BRAND_COLOR } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { invoiceOutstanding } from '../invoices/invoice-debt'
import { runCronSafely } from '../common/cron/cron-safety'
import { MailService } from '../mail/mail.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { AiAssistantService } from '../ai/ai-assistant.service'
import { MonthlyReportService } from './monthly-report.service'
import { SAFE_CUSTOMER_SELECT } from '../customers/customers.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { LockService } from '../common/redis/lock.service'
import { CRON_LOCK_TTL_SEC } from '../common/redis/cron-lock'
import { resolveActorType, aiOriginColumns } from '../common/ai-origin/ai-origin.context'

type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: {
    tenant: { select: typeof SAFE_TENANT_SELECT }
    customer: { select: typeof SAFE_CUSTOMER_SELECT }
    organization: true
    payments: { select: { amount: true } }
    creditNotes: { select: { total: true } }
  }
}>

// Strukturerad referens till entiteten en notis handlar om. Frontend mappar
// `relatedEntityType` → Route och använder `relatedEntityId` för att öppna
// rätt detaljvy. `link` behålls för bakåtkompatibilitet med äldre rader.
export type RelatedEntityType =
  | 'MAINTENANCE_TICKET'
  | 'INVOICE'
  | 'LEASE'
  | 'TENANT'
  | 'DEPOSIT'
  | 'RENT_INCREASE'
  | 'TERMINATION_REQUEST'

export interface NotificationTarget {
  link?: string
  relatedEntityType?: RelatedEntityType
  relatedEntityId?: string
}

function buildTargetPatch(target: NotificationTarget | undefined): {
  link?: string
  relatedEntityType?: string
  relatedEntityId?: string
} {
  if (!target) return {}
  const out: { link?: string; relatedEntityType?: string; relatedEntityId?: string } = {}
  if (target.link) out.link = target.link
  if (target.relatedEntityType) out.relatedEntityType = target.relatedEntityType
  if (target.relatedEntityId) out.relatedEntityId = target.relatedEntityId
  return out
}

// Roller som tar emot AI-rapporter (morgonrapport + veckosammanfattning).
// VIEWER exkluderas — observatörsroll utan dagligt arbete i systemet.
const REPORT_RECIPIENT_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT'] as const

// ISO-8601-veckonyckel för en lokal datumsträng "YYYY-MM-DD". Returnerar både
// nyckeln ("YYYY-Www", basen för veckorapportens idempotency) och veckonumret.
function isoWeek(ymd: string): { key: string; week: number } {
  const parts = ymd.split('-')
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])))
  // Flytta till veckans torsdag — ISO-veckan ägs av det år torsdagen ligger i.
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { key: `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, week }
}

/**
 * TTL för cron-låsen.
 *
 * Måste vara längre än jobbets värsta körtid: dör processen mitt i ligger låset
 * kvar tills TTL löper ut, men tar TTL slut MEDAN jobbet kör kan en andra replik
 * ta låset och då skyddar det ingenting.
 *
 * ── INVARIANTEN: jobbets körtid  <  TTL  <  cron-intervallet ────────────────
 *
 * Båda olikheterna måste hålla, och de fäller åt olika håll:
 *
 *   TTL för KORT  → låset löper ut medan jobbet kör. En andra replik tar det,
 *                   och låset skyddar ingenting. Det felet byggde vi bort.
 *
 *   TTL för LÅNGT → ett lås som blir kvar efter en krasch överlever till NÄSTA
 *                   schemalagda körning, som då hoppas över. Är TTL längre än
 *                   intervallet blir jobbet permanent avstängt, tyst.
 *
 * Den andra halvan är ny med `runIfUnlocked`. `runWithLock` väntade och körde
 * ändå — den kunde inte tystna, bara dubbelköra. Fail-closed betyder att
 * felmoden bytt riktning, och den nya är svårare att upptäcka: ett jobb som
 * slutat köra ser exakt ut som ett jobb utan något att göra.
 *
 * Uppmätta värden — BEVAKADE av `cron-lock-interval.spec.ts`, inte bara skrivna:
 *
 *   morning-insights   `0 7 * * 1-5`    intervall ≥ 24 h     TTL 30 min
 *   weekly-summary     `0 18 * * 0`     intervall  7 dygn    TTL 30 min
 *   monthly-report     `0 8 1 * *`      intervall ≥ 28 dygn  TTL 30 min
 *
 * 30 minuter är satt efter den ÖVRE halvan: jobben itererar organisationer med
 * ett AI-anrop per organisation. Marginalen nedåt är enorm — närmaste intervall
 * är 24 timmar, alltså 48 gånger TTL:n.
 */
// Flyttad till common/redis/cron-lock.ts — delas nu av sju låsta jobb.

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name)
  private aiService!: AiAssistantService

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private moduleRef: ModuleRef,
    private monthlyReport: MonthlyReportService,
    private locks: LockService,
    /**
     * #605 — VARAKTIG FELSÄNKA.
     *
     * De tre rapportjobben nedan har den farligaste formen: de fångar per org,
     * räknar upp `failed`, fortsätter, och loggar sedan en summering på
     * log-nivå. Körningen rapporterar "3 skickade, 2 misslyckade" och SER
     * LYCKAD UT — medan två hyresvärdar inte fått sin rapport och ingen får
     * veta det. Den lokala loggen försvinner med containern.
     *
     * Sänkan läggs BREDVID varje `logger.error`, aldrig i stället för. Full
     * detalj stannar lokalt; ErrorLog får felet plus organisationen, så en
     * utebliven rapport går att hitta i efterhand och kopplas till rätt kund.
     */
    private cronErrors: CronErrorSink,
  ) {}

  async onModuleInit(): Promise<void> {
    // Dynamic import breaks the TypeScript circular import chain:
    // notifications.service → ai-assistant.service → tool-executor.service → invoices.service → notifications.service
    const { AiAssistantService: AiSvc } = await import('../ai/ai-assistant.service')
    this.aiService = this.moduleRef.get<AiAssistantService>(AiSvc, { strict: false })
  }

  // ─── In-app notification CRUD ──────────────────────────────────────────────

  // `link` är legacy-fältet (URL-sträng). För nya notiser passas istället
  // `relatedEntityType` + `relatedEntityId` så att frontend kan resolva rätt
  // detaljvy via en typ→Route-mappning. `link` behålls bakåtkompatibelt
  // tills alla rader backfillats / cron-rensats.
  async create(
    organizationId: string,
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    target?: NotificationTarget,
  ): Promise<Notification> {
    return this.prisma.notification.create({
      data: {
        organizationId,
        userId,
        type,
        title,
        message,
        ...buildTargetPatch(target),
      },
    })
  }

  async createForAllOrgUsers(
    organizationId: string,
    type: NotificationType,
    title: string,
    message: string,
    target?: NotificationTarget,
  ): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true },
    })
    if (users.length === 0) return
    const patch = buildTargetPatch(target)
    await this.prisma.notification.createMany({
      data: users.map((u) => ({
        organizationId,
        userId: u.id,
        type,
        title,
        message,
        ...patch,
      })),
    })
  }

  async findAll(
    organizationId: string,
    userId: string,
    onlyUnread?: boolean,
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        organizationId,
        userId,
        ...(onlyUnread ? { read: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  }

  async markAsRead(id: string, userId: string): Promise<{ count: number }> {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true, readAt: new Date() },
    })
  }

  async markAllAsRead(organizationId: string, userId: string): Promise<{ count: number }> {
    return this.prisma.notification.updateMany({
      where: { organizationId, userId, read: false },
      data: { read: true, readAt: new Date() },
    })
  }

  async getUnreadCount(organizationId: string, userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { organizationId, userId, read: false },
    })
  }

  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // Notification deleteMany på ett tidsfönster (createdAt < gräns) — att
  // radera redan raderade rader är per definition en no-op, count blir bara
  // 0.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('0 2 * * *')
  async deleteOld(): Promise<void> {
    // #605 batch 2 — C-FORMEN. Jobbet hade ingen felhantering alls: ett kast
    // lämnade @Cron-metoden till @nestjs/schedule, som loggar i containern och
    // inget mer. Här fanns alltså ingen logg att lägga sänkan BREDVID (till
    // skillnad från rapportjobben i samma fil) — felhanteringen läggs till.
    await runCronSafely('notifications-delete-old', () => this.deleteOldUnsafe(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  private async deleteOldUnsafe(): Promise<void> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    this.logger.log(`Deleted ${result.count} old notifications`)
  }

  // ─── Email cron jobs ───────────────────────────────────────────────────────

  // H2: den tidigare `sendOverdueReminders()` (icke org-scopad, `include:
  // { tenant: true }` utan SAFE_TENANT_SELECT) är borttagen. Den var
  // @deprecated, saknade anropare och var en latent cross-tenant- och
  // credential-läckaväg. Det aktiva flödet är PaymentReminderService.
  // processOverdueReminders (tiered) + sendOverdueRemindersForOrg (manuellt,
  // org-scopat) nedan.

  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // Invoice updateMany sätter status=OVERDUE på rader som ännu inte är det;
  // en andra körning skriver samma värde på samma mängd, alltså en no-op
  // utan sidoeffekt.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async markOverdueInvoices(): Promise<void> {
    // T5 B1b — atomär bulk (en updateMany = commit-eller-rollback), ingen per-item;
    // bara runCronSafely så en DB-blipp larmar via Sentry istället för tyst död.
    await runCronSafely(
      'mark-overdue-invoices',
      async () => {
        const now = new Date()
        const result = await this.prisma.invoice.updateMany({
          // #517 — kreditnotor undantas. De skapas som DRAFT och kan därför
          // inte träffas av `status: 'SENT'` i dag, men villkoret står här
          // ändå: skickas en kreditnota någon gång ut som dokument hade den
          // annars flippats till OVERDUE av sitt eget utfärdandedatum och
          // därmed hamnat i kravtrappan, som grindar på just OVERDUE.
          where: { status: 'SENT', dueDate: { lt: now }, isCreditNote: false },
          data: { status: 'OVERDUE' },
        })
        this.logger.log(`Marked ${result.count} invoices as OVERDUE`)
      },
      { logger: this.logger },
    )
  }

  // Inkasso PR 1 — förfalloövervakning för hyresavier. Speglar
  // markOverdueInvoices: en utskickad (SENT), obetald avi vars dueDate passerat
  // flippas till OVERDUE. PENGANEUTRALT — ingen påminnelse, ingen avgift, ingen
  // krona rörs (det börjar i PR 2). Endast SENT eskaleras: en avi som aldrig
  // nått hyresgästen (PENDING/FAILED) startar ingen kravtrappa. Kravtrappan
  // (collectionStage) berörs inte här — den ligger kvar på NONE tills PR 2.
  //
  // Bulk-updateMany utan org-loop är tenant-säkert: varje rad flippas enbart på
  // sin EGEN dueDate, ingen organisations data läses eller korsas. PAID/CANCELLED
  // rörs aldrig (filtret kräver status = SENT).
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // RentNotice updateMany sätter status=OVERDUE på rader som ännu inte är
  // det; en andra körning skriver samma värde på samma mängd, alltså en
  // no-op utan sidoeffekt.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async markOverdueRentNotices(): Promise<void> {
    // T5 B1b — atomär bulk (samma som markOverdueInvoices); bara runCronSafely.
    await runCronSafely(
      'mark-overdue-rent-notices',
      async () => {
        const now = new Date()
        const result = await this.prisma.rentNotice.updateMany({
          where: { status: 'SENT', dueDate: { lt: now } },
          data: { status: 'OVERDUE' },
        })
        this.logger.log(`Marked ${result.count} rent notices as OVERDUE`)
      },
      { logger: this.logger },
    )
  }

  async sendOverdueRemindersForOrg(organizationId: string): Promise<void> {
    const invoices: InvoiceWithRelations[] = await this.prisma.invoice.findMany({
      // ── #352: DEPOSITIONER PÅMINNS INTE HÄRIFRÅN ──────────────────────────
      //
      // En depositionsfaktura är en riktig fordran (1510 D / 2890 K, #348) men
      // en ENGÅNGSBETALNING vid kontraktsstart, inte en löpande skuldrelation.
      // Kravtrappan är byggd för det senare, och en obetald deposition ska
      // hanteras som ett eget spår — inte matas in i hyresmaskineriet.
      //
      // `markOverdueInvoices` (statusflippen) är MEDVETET ORÖRD: den är
      // penganeutral och bär depositionens SYNLIGHET, som #348 uttryckligen
      // fastställde ska finnas kvar. Synlighet och automatisk eskalering med
      // ekonomiska konsekvenser är två skilda saker. (FAR-granskat, #352.)
      where: { organizationId, status: 'OVERDUE', type: { not: 'DEPOSIT' } },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
        organization: true,
        // #329 — utan allokeringarna går restskulden inte att räkna. `where`
        // orört: exakt samma fakturor påminns.
        payments: { select: { amount: true } },
        creditNotes: { select: { total: true } },
      },
    })

    // Idempotensfönstret är dagen (lokal serverdag). Samma dedup som den
    // borttagna sendOverdueReminders() hade (PR #27, H2) — den org-scopade
    // varianten ärvde aldrig skyddet (#28).
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(startOfDay)
    endOfDay.setDate(endOfDay.getDate() + 1)

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const invoice of invoices) {
      const party = invoice.tenant ?? invoice.customer
      if (!party?.email) continue

      // Idempotency-guard: hoppa över om en påminnelse redan loggats för denna
      // faktura idag (dubbelklick, retry, dubbel cron-fire vid multi-replica)
      // → undviker dubbla påminnelsemejl för samma faktura.
      const alreadySent = await this.prisma.invoiceEvent.findFirst({
        where: {
          invoiceId: invoice.id,
          type: 'REMINDER_SENT',
          createdAt: { gte: startOfDay, lt: endOfDay },
        },
        select: { id: true },
      })
      if (alreadySent) {
        skipped++
        continue
      }

      try {
        const tenantName = this.resolveTenantName(invoice)
        await this.mail.sendOverdueReminder({
          to: party.email,
          organizationId,
          tenantName,
          invoiceNumber: invoice.invoiceNumber,
          // #329 — RESTSKULDEN. Den här manuella vägen (POST från
          // notifications-controllern) skickade ursprungsbeloppet precis som
          // den tierade cronen gjorde. Samma brev, samma mottagare, samma fel.
          total: invoiceOutstanding(invoice),
          dueDate: invoice.dueDate,
          organizationName: invoice.organization.name,
          accentColor: invoice.organization.invoiceColor ?? DEFAULT_BRAND_COLOR,
        })

        // Logga REMINDER_SENT EFTER lyckat utskick → dedup-fönstret stängs för
        // dagen. Append-only InvoiceEvent (samma mönster som det borttagna).
        await this.prisma.invoiceEvent.create({
          data: {
            invoiceId: invoice.id,
            type: 'REMINDER_SENT',
            actorType: resolveActorType('SYSTEM'),
            ...aiOriginColumns(),
            actorLabel: 'Automatisk påminnelse',
            payload: {},
          },
        })
        sent++
      } catch (err) {
        this.logger.error(`Failed to send reminder for invoice ${invoice.id}: ${String(err)}`)
        failed++
      }
    }

    this.logger.log(
      `Overdue reminders (org ${organizationId}): ${sent} sent, ${failed} failed, ${skipped} skipped`,
    )
  }

  @Cron('0 7 * * 1-5', {
    timeZone: 'Europe/Stockholm',
    name: 'morning-insights',
  })
  async sendMorningInsights(): Promise<void> {
    const result = await this.locks.runIfUnlocked(
      'cron:morning-insights',
      () => this.sendMorningInsightsUnsafe(),
      { ttlSec: CRON_LOCK_TTL_SEC },
    )
    if (!result.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig". Säg det —
      // och säg hur gammalt låset var, så ett normalt överhopp går att skilja
      // från ett hängt lås som stängt av jobbet.
      this.logger.log(
        `[cron:morning-insights] Morgonrapporten kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${result.heldForSec ?? '?'} s av ${CRON_LOCK_TTL_SEC} s.`,
      )
    }
  }

  private async sendMorningInsightsUnsafe(): Promise<void> {
    const organizations = await this.prisma.organization.findMany({
      include: {
        users: {
          where: { role: { in: [...REPORT_RECIPIENT_ROLES] }, isActive: true },
        },
      },
    })

    const now = new Date()
    const today = now.toLocaleDateString('sv-SE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    // Stabil dagsnyckel i lokal tid — basen för idempotency på både sentinel
    // och Resend. Använder sv-SE → "YYYY-MM-DD".
    const dayKey = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const org of organizations) {
      if (org.users.length === 0) continue

      // Atomic sentinel-lås: skriv markeringen FÖRE mejlen skickas, med ett
      // deterministiskt id (organizationId + dag). Lyckas insert → vi äger
      // dagens utskick. Faller på unique-violation (P2002) → en annan replica
      // / cron-fire har redan tagit jobbet, hoppa över. Detta löser race
      // condition mellan check-then-act i föregående version.
      const sentinelId = `morning-insights-${org.id}-${dayKey}`
      const markerUserId = org.users[0]?.id
      if (!markerUserId) continue

      try {
        await this.prisma.notification.create({
          data: {
            id: sentinelId,
            organizationId: org.id,
            userId: markerUserId,
            type: 'SYSTEM',
            title: 'MORNING_INSIGHTS_SENT',
            message: today,
            read: true,
            readAt: now,
          },
        })
      } catch (err) {
        // P2002: unique constraint på id → annan process har redan låst dagen.
        const code = (err as { code?: string }).code
        if (code === 'P2002') {
          skipped++
          continue
        }
        this.logger.error(`Sentinel-lås misslyckades för org ${org.id}: ${String(err)}`)
        await this.cronErrors.report('morning-insights', err, {
          organizationId: org.id,
          detail: { steg: 'sentinel-lås' },
        })
        failed++
        continue
      }

      try {
        const insights = await this.aiService.generateDailyInsights(org.id)
        if (!insights) continue

        for (const user of org.users) {
          // In-app-notis skapas FÖRE mejlet och oavsett e-postadress —
          // användare utan e-post ska ändå se rapporten i appen, och ett
          // misslyckat mejlutskick ska inte hindra notisen.
          await this.createReportNotification(
            org.id,
            user.id,
            'MORNING_INSIGHT',
            'Din morgonrapport är här',
            insights,
          )

          if (!user.email) continue
          try {
            await this.mail.sendMorningInsights({
              to: user.email,
              organizationId: org.id,
              firstName: user.firstName,
              insights,
              today,
              organizationName: org.name,
              accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
              // Stabil nyckel per (org, user, dag) — Bull-jobId dedupar dubbla
              // enqueues, och Resend dedupar dubbla worker-körningar (24h-fönster).
              idempotencyKey: `morning-insights-${org.id}-${user.id}-${dayKey}`,
            })
            sent++
          } catch (err) {
            this.logger.error(`Morning insights email failed for ${user.email}: ${String(err)}`)
            await this.cronErrors.report('morning-insights', err, {
              organizationId: org.id,
              detail: { steg: 'mejlutskick', userId: user.id },
            })
            failed++
          }
        }
      } catch (err) {
        this.logger.error(`Morning insights generation failed for org ${org.id}: ${String(err)}`)
        await this.cronErrors.report('morning-insights', err, {
          organizationId: org.id,
          detail: { steg: 'generering' },
        })
        failed++
      }
    }

    this.logger.log(`Morning insights: ${sent} sent, ${failed} failed, ${skipped} skipped`)
  }

  @Cron('0 18 * * 0', {
    timeZone: 'Europe/Stockholm',
    name: 'weekly-summary',
  })
  async sendWeeklySummary(): Promise<void> {
    const result = await this.locks.runIfUnlocked(
      'cron:weekly-summary',
      () => this.sendWeeklySummaryUnsafe(),
      { ttlSec: CRON_LOCK_TTL_SEC },
    )
    if (!result.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig". Säg det —
      // och säg hur gammalt låset var, så ett normalt överhopp går att skilja
      // från ett hängt lås som stängt av jobbet.
      this.logger.log(
        `[cron:weekly-summary] Veckosammanfattningen kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${result.heldForSec ?? '?'} s av ${CRON_LOCK_TTL_SEC} s.`,
      )
    }
  }

  private async sendWeeklySummaryUnsafe(): Promise<void> {
    const organizations = await this.prisma.organization.findMany({
      include: {
        users: {
          where: { role: { in: [...REPORT_RECIPIENT_ROLES] }, isActive: true },
        },
      },
    })

    const now = new Date()
    // Veckonyckel i svensk tid — samma princip som morgonrapportens dayKey.
    const stockholmYmd = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })
    const { key: weekKey, week } = isoWeek(stockholmYmd)
    const weekLabel = `vecka ${week}`

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const org of organizations) {
      if (org.users.length === 0) continue

      // Atomiskt sentinel-lås per (org, ISO-vecka) — identiskt mönster med
      // morgonrapporten men med veckokadens. SYSTEM/read:true, separat från
      // de användarsynliga WEEKLY_SUMMARY-notiserna nedan.
      const sentinelId = `weekly-summary-${org.id}-${weekKey}`
      const markerUserId = org.users[0]?.id
      if (!markerUserId) continue

      try {
        await this.prisma.notification.create({
          data: {
            id: sentinelId,
            organizationId: org.id,
            userId: markerUserId,
            type: 'SYSTEM',
            title: 'WEEKLY_SUMMARY_SENT',
            message: weekLabel,
            read: true,
            readAt: now,
          },
        })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'P2002') {
          skipped++
          continue
        }
        this.logger.error(`Sentinel-lås (vecka) misslyckades för org ${org.id}: ${String(err)}`)
        await this.cronErrors.report('weekly-summary', err, {
          organizationId: org.id,
          detail: { steg: 'sentinel-lås' },
        })
        failed++
        continue
      }

      try {
        const summary = await this.aiService.generateWeeklySummary(org.id)
        if (!summary) continue

        for (const user of org.users) {
          // In-app-notis först, oavsett e-post (se sendMorningInsights).
          await this.createReportNotification(
            org.id,
            user.id,
            'WEEKLY_SUMMARY',
            'Din veckosammanfattning är här',
            summary,
          )

          if (!user.email) continue
          try {
            await this.mail.sendWeeklySummary({
              to: user.email,
              organizationId: org.id,
              firstName: user.firstName,
              summary,
              weekLabel,
              organizationName: org.name,
              accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
              idempotencyKey: `weekly-summary-${org.id}-${user.id}-${weekKey}`,
            })
            sent++
          } catch (err) {
            this.logger.error(`Weekly summary email failed for ${user.email}: ${String(err)}`)
            await this.cronErrors.report('weekly-summary', err, {
              organizationId: org.id,
              detail: { steg: 'mejlutskick', userId: user.id },
            })
            failed++
          }
        }
      } catch (err) {
        this.logger.error(`Weekly summary generation failed for org ${org.id}: ${String(err)}`)
        await this.cronErrors.report('weekly-summary', err, {
          organizationId: org.id,
          detail: { steg: 'generering' },
        })
        failed++
      }
    }

    this.logger.log(`Weekly summary: ${sent} sent, ${failed} failed, ${skipped} skipped`)
  }

  @Cron('0 8 1 * *', {
    timeZone: 'Europe/Stockholm',
    name: 'monthly-report',
  })
  async sendMonthlyReport(): Promise<void> {
    const result = await this.locks.runIfUnlocked(
      'cron:monthly-report',
      () => this.sendMonthlyReportUnsafe(),
      { ttlSec: CRON_LOCK_TTL_SEC },
    )
    if (!result.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig". Säg det —
      // och säg hur gammalt låset var, så ett normalt överhopp går att skilja
      // från ett hängt lås som stängt av jobbet.
      this.logger.log(
        `[cron:monthly-report] Månadsrapporten kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${result.heldForSec ?? '?'} s av ${CRON_LOCK_TTL_SEC} s.`,
      )
    }
  }

  private async sendMonthlyReportUnsafe(): Promise<void> {
    const organizations = await this.prisma.organization.findMany({
      include: {
        users: {
          where: { role: { in: [...REPORT_RECIPIENT_ROLES] }, isActive: true },
        },
      },
    })

    const now = new Date()
    // Rapportmånad = föregående månad (cron fyrar den 1:a kl 08:00).
    const reportMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const monthKey = `${reportMonth.getFullYear()}-${String(reportMonth.getMonth() + 1).padStart(2, '0')}`

    let sent = 0
    let failed = 0
    let skipped = 0

    for (const org of organizations) {
      if (org.users.length === 0) continue

      // Atomiskt sentinel-lås per (org, månad) — samma mönster som morgon-
      // och veckorapporten. SYSTEM/read:true, skilt från de användarsynliga
      // MONTHLY_REPORT-notiserna nedan.
      const sentinelId = `monthly-report-${org.id}-${monthKey}`
      const markerUserId = org.users[0]?.id
      if (!markerUserId) continue

      try {
        await this.prisma.notification.create({
          data: {
            id: sentinelId,
            organizationId: org.id,
            userId: markerUserId,
            type: 'SYSTEM',
            title: 'MONTHLY_REPORT_SENT',
            message: monthKey,
            read: true,
            readAt: now,
          },
        })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'P2002') {
          skipped++
          continue
        }
        this.logger.error(`Sentinel-lås (månad) misslyckades för org ${org.id}: ${String(err)}`)
        await this.cronErrors.report('monthly-report', err, {
          organizationId: org.id,
          detail: { steg: 'sentinel-lås' },
        })
        failed++
        continue
      }

      try {
        // PDF-generering + AI-insikter sker i MonthlyReportService. null =
        // organisationen saknar fastigheter — skicka inte en tom rapport.
        const result = await this.monthlyReport.generatePdf(org.id)
        if (!result) continue
        const { pdf, data } = result
        const filename = `manadsrapport-${monthKey}.pdf`
        const summaryLine = `Omsättning ${formatCurrency(data.summary.revenue.current)}, beläggning ${data.summary.occupancy.currentPct}%. Rapporten finns som PDF-bilaga i mejlet.`

        for (const user of org.users) {
          // In-app-notis först, oavsett e-post (se sendMorningInsights).
          await this.createReportNotification(
            org.id,
            user.id,
            'MONTHLY_REPORT',
            `Månadsrapport för ${data.header.monthLabel}`,
            summaryLine,
          )

          if (!user.email) continue
          try {
            await this.mail.sendMonthlyReport({
              to: user.email,
              organizationId: org.id,
              firstName: user.firstName,
              monthLabel: data.header.monthLabel,
              organizationName: org.name,
              pdf,
              filename,
              idempotencyKey: `monthly-report-${org.id}-${user.id}-${monthKey}`,
            })
            sent++
          } catch (err) {
            this.logger.error(`Monthly report email failed for ${user.email}: ${String(err)}`)
            await this.cronErrors.report('monthly-report', err, {
              organizationId: org.id,
              detail: { steg: 'mejlutskick', userId: user.id },
            })
            failed++
          }
        }
      } catch (err) {
        this.logger.error(`Monthly report generation failed for org ${org.id}: ${String(err)}`)
        await this.cronErrors.report('monthly-report', err, {
          organizationId: org.id,
          detail: { steg: 'generering' },
        })
        failed++
      }
    }

    this.logger.log(`Monthly report: ${sent} sent, ${failed} failed, ${skipped} skipped`)
  }

  /**
   * Skapar en användarsynlig notis för en AI-rapport (morgon/vecka/månad).
   * Skild från sentinel-låset (type SYSTEM, read:true) — denna är read:false
   * och dyker upp i NotificationBell. Sväljer egna fel: en misslyckad notis
   * ska aldrig stoppa resten av utskicket.
   */
  private async createReportNotification(
    organizationId: string,
    userId: string,
    type: 'MORNING_INSIGHT' | 'WEEKLY_SUMMARY' | 'MONTHLY_REPORT',
    title: string,
    body: string,
  ): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          organizationId,
          userId,
          type,
          title,
          message: body.trim(),
        },
      })
    } catch (err) {
      this.logger.error(`In-app-notis (${type}) misslyckades för user ${userId}: ${String(err)}`)
    }
  }

  private resolveTenantName(invoice: InvoiceWithRelations): string {
    const party = invoice.tenant ?? invoice.customer
    if (!party) return '–'
    if (party.type === 'INDIVIDUAL') {
      return `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim()
    }
    return party.companyName ?? party.email ?? '–'
  }
}
