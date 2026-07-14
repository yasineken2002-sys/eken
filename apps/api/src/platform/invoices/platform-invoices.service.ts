import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../common/prisma/prisma.service'
import { runCronSafely, forEachOrgSafely } from '../../common/cron/cron-safety'
import { allocatePlatformInvoiceNumber } from './platform-invoice-number'
import { MailService } from '../../mail/mail.service'
import { PdfService } from '../../invoices/pdf.service'
import { PdfQueue } from '../../pdf-jobs/pdf.queue'
import {
  PLATFORM_COMPANY,
  generatePlatformOcr,
  PLAN_LIMITS,
  type SubscriptionPlan,
} from '@eken/shared'
import {
  generatePlatformInvoiceHtml,
  type PlatformInvoicePdfData,
} from './templates/platform-invoice-pdf.template'

type PlatformInvoiceStatus = 'DRAFT' | 'SENT' | 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
type PlatformInvoiceType = 'PLAN_FEE' | 'AI_CREDITS' | 'OTHER'
type PaymentMethod = 'BANKGIRO' | 'SWISH' | 'MANUAL'

const VAT_RATE = 25 // Plattformsfakturor: 25% moms (SaaS-tjänst)

export interface CreatePlatformInvoiceInput {
  organizationId: string
  type: PlatformInvoiceType
  amountNetSek: number
  description?: string
  dueDate?: string | Date
  planPeriodStart?: string | Date
  planPeriodEnd?: string | Date
  notes?: string
}

export interface MarkPaidInput {
  paidAt?: string | Date
  paymentMethod: PaymentMethod
  paymentReference?: string
}

export interface GenerationResult {
  created: number
  sent: number
  failed: number
  skipped: number
  /** Människoläsbara felrader för UI:t (skapande- och send-fel). */
  failures: string[]
}

const MONTHS_SV = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
]

/**
 * Lanseringsdatum för autonom fakturering. Organisationer skapade FÖRE
 * detta datum hade aldrig något trial→betald-flöde och får därför en
 * engångs grandfather-förlängning (+30 dagar) innan de pausas, så att
 * de hinner få de nya varningsmejlen. Konton skapade efter datumet följer
 * det normala flödet direkt.
 */
const GRANDFATHER_CUTOFF = new Date('2026-05-15T00:00:00.000Z')

function escapeMailText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Avgör om en P2002 kommer från PERIOD-idempotens-indexet
 * (platform_invoice_unique_period på organizationId+type+planPeriodStart) — dvs
 * en BENIGN race där två samtidiga körningar skapar fakturan för samma org+period
 * (en vinner, den andra ska tyst hoppas över). All ANNAN P2002 — särskilt en
 * kollision på invoiceNumber-unikheten (ett nummer-race) — får ALDRIG behandlas
 * som benign: den ska larma, inte tyst maskeras som "fakturan fanns redan".
 *
 * err.meta.target-formen är EMPIRISKT verifierad mot dev-Postgres (Prisma
 * 5.19): BÅDA indexen rapporteras som en KOLUMN-ARRAY —
 * periodindexet ["organizationId","type","planPeriodStart"], invoiceNumber
 * ["invoiceNumber"]. Sträng-grenen (indexnamn) behålls som defensiv fallback ifall
 * Prisma/drivern skulle byta form. Default (okänd/saknad target) = INTE benign →
 * fail-safe: hellre ett larm än en tyst försvunnen faktura. (Jämför
 * isActiveUnitConflict i leases.service.ts som hanterar sträng-formen.)
 */
function isPeriodIdempotencyConflict(err: Prisma.PrismaClientKnownRequestError): boolean {
  const target = (err.meta as { target?: unknown } | undefined)?.target
  // Verkligt fall: kolumn-array som innehåller planPeriodStart (periodindexets
  // särskiljande kolumn; invoiceNumber-arrayen saknar den → INTE benign).
  if (Array.isArray(target)) return target.includes('planPeriodStart')
  // Defensiv fallback: om target någon gång rapporteras som indexnamn-sträng.
  if (typeof target === 'string') return target.includes('platform_invoice_unique_period')
  return false
}

@Injectable()
export class PlatformInvoicesService {
  private readonly logger = new Logger(PlatformInvoicesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly pdf: PdfService,
    private readonly config: ConfigService,
    private readonly pdfQueue: PdfQueue,
  ) {}

  /**
   * Auto-send: när true mailas PLAN_FEE-fakturor direkt efter att de skapats
   * i månadscron/backfill. När false skapas de bara som DRAFT (gamla
   * beteendet) så att en operatör kan granska innan utskick. Default true;
   * sätt AUTO_SEND_PLATFORM_INVOICES=false i prod tills flödet är rökt-testat.
   */
  private get autoSendEnabled(): boolean {
    return this.config.get<string>('AUTO_SEND_PLATFORM_INVOICES', 'true') !== 'false'
  }

  /** Antal extra dagar efter trialEndsAt innan konvertering/suspension. */
  private get trialGracePeriodDays(): number {
    const raw = Number(this.config.get<string>('TRIAL_GRACE_PERIOD_DAYS', '3'))
    return Number.isFinite(raw) && raw >= 0 ? raw : 3
  }

  /** Bas-URL till kund-webben (plan-väljaren) i trial-mejlen. Återanvänder
   *  APP_URL som redan pekar på kund-webben i alla miljöer. */
  private get webAppUrl(): string {
    return this.config.get<string>('APP_URL', 'https://eken-web.vercel.app')
  }

  // ─── Lista och stats ──────────────────────────────────────────────────────

  async list(params: {
    status?: PlatformInvoiceStatus
    type?: PlatformInvoiceType
    organizationId?: string
    page?: number
    pageSize?: number
  }) {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50))
    const skip = (page - 1) * pageSize

    const where: Prisma.PlatformInvoiceWhereInput = {}
    if (params.status) {
      // Behandla SENT och PENDING som synonymer i filtreringen så att
      // gamla credit-fakturor (PENDING) syns i SENT-fliken.
      if (params.status === 'SENT' || params.status === 'PENDING') {
        where.status = { in: ['SENT', 'PENDING'] }
      } else {
        where.status = params.status
      }
    }
    if (params.type) where.type = params.type
    if (params.organizationId) where.organizationId = params.organizationId

    const [total, rows] = await Promise.all([
      this.prisma.platformInvoice.count({ where }),
      this.prisma.platformInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          organization: { select: { id: true, name: true, email: true, billingEmail: true } },
        },
      }),
    ])

    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => this.map(r)),
    }
  }

  async findOne(id: string) {
    const row = await this.prisma.platformInvoice.findUnique({
      where: { id },
      include: {
        organization: { select: { id: true, name: true, email: true, billingEmail: true } },
      },
    })
    if (!row) throw new NotFoundException('Fakturan hittades inte')
    return this.map(row)
  }

  /**
   * Översiktsstatistik som visas högst upp på Fakturor-sidan.
   * Period: innevarande kalendermånad.
   */
  async stats() {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [invoicedThisMonth, paidThisMonth, outstanding, overdueCount, mrr] = await Promise.all([
      this.prisma.platformInvoice.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: monthStart }, status: { not: 'VOID' } },
      }),
      this.prisma.platformInvoice.aggregate({
        _sum: { amount: true },
        where: { paidAt: { gte: monthStart }, status: 'PAID' },
      }),
      this.prisma.platformInvoice.aggregate({
        _sum: { amount: true },
        where: { status: { in: ['SENT', 'PENDING', 'OVERDUE'] } },
      }),
      this.prisma.platformInvoice.count({ where: { status: 'OVERDUE' } }),
      this.prisma.organization.aggregate({
        _sum: { planMonthlyFee: true },
        where: { status: 'ACTIVE' },
      }),
    ])

    return {
      invoicedThisMonthSek: Number(invoicedThisMonth._sum.amount ?? 0),
      paidThisMonthSek: Number(paidThisMonth._sum.amount ?? 0),
      outstandingSek: Number(outstanding._sum.amount ?? 0),
      overdueCount,
      mrrSek: Number(mrr._sum.planMonthlyFee ?? 0),
    }
  }

  // ─── Skapa / uppdatera / radera ──────────────────────────────────────────

  async create(input: CreatePlatformInvoiceInput) {
    const org = await this.prisma.organization.findUnique({ where: { id: input.organizationId } })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    if (input.amountNetSek <= 0) throw new BadRequestException('Beloppet måste vara > 0')

    const amountGross = roundSek(input.amountNetSek * (1 + VAT_RATE / 100))
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : new Date(Date.now() + PLATFORM_COMPANY.paymentTermsDays * 24 * 60 * 60 * 1000)

    // Nummer-allokering + insert i EN transaktion: allocatePlatformInvoiceNumber
    // gör en atomär increment-UPSERT som tar Postgres row-lock på scope-raden, så
    // två samtidiga faktureringar aldrig delar ut samma nummer (tidigare
    // count()+1 UTANFÖR någon tx → race → P2002 på invoiceNumber-unikheten).
    const row = await this.prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocatePlatformInvoiceNumber(tx, input.type)
      return tx.platformInvoice.create({
        data: {
          organizationId: input.organizationId,
          invoiceNumber,
          amount: amountGross,
          status: 'DRAFT',
          type: input.type,
          ...(input.description ? { description: input.description } : {}),
          dueDate,
          ...(input.planPeriodStart ? { planPeriodStart: new Date(input.planPeriodStart) } : {}),
          ...(input.planPeriodEnd ? { planPeriodEnd: new Date(input.planPeriodEnd) } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
        include: {
          organization: { select: { id: true, name: true, email: true, billingEmail: true } },
        },
      })
    })
    return this.map(row)
  }

  async update(id: string, patch: Partial<CreatePlatformInvoiceInput>) {
    const existing = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Fakturan hittades inte')
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException('Endast DRAFT-fakturor kan redigeras')
    }

    const data: Prisma.PlatformInvoiceUpdateInput = {}
    if (patch.amountNetSek !== undefined) {
      if (patch.amountNetSek <= 0) throw new BadRequestException('Beloppet måste vara > 0')
      data.amount = roundSek(patch.amountNetSek * (1 + VAT_RATE / 100))
    }
    if (patch.description !== undefined) data.description = patch.description
    if (patch.dueDate !== undefined) data.dueDate = new Date(patch.dueDate)
    if (patch.planPeriodStart !== undefined) data.planPeriodStart = new Date(patch.planPeriodStart)
    if (patch.planPeriodEnd !== undefined) data.planPeriodEnd = new Date(patch.planPeriodEnd)
    if (patch.notes !== undefined) data.notes = patch.notes
    if (patch.type !== undefined) data.type = patch.type

    const row = await this.prisma.platformInvoice.update({
      where: { id },
      data,
      include: {
        organization: { select: { id: true, name: true, email: true, billingEmail: true } },
      },
    })
    return this.map(row)
  }

  // Soft-delete (LAGBROTT 1, BFL 1999:1078): plattformsfakturor är räkenskaps-
  // information och raderas aldrig hårt. Ett utkast makuleras (status VOID) med
  // spårbar makuleringstidpunkt (behandlingshistorik, BFL 5 kap 11 §).
  async remove(id: string) {
    const existing = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Fakturan hittades inte')
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException('Endast DRAFT-fakturor kan makuleras')
    }
    await this.prisma.platformInvoice.update({
      where: { id },
      data: { status: 'VOID', voidedAt: new Date(), voidedReason: 'draft_voided' },
    })
    return { id }
  }

  // ─── PDF + skicka ─────────────────────────────────────────────────────────

  async generatePdf(id: string): Promise<Buffer> {
    const row = await this.prisma.platformInvoice.findUnique({
      where: { id },
      include: { organization: true },
    })
    if (!row) throw new NotFoundException('Fakturan hittades inte')

    const data: PlatformInvoicePdfData = this.buildPdfData(row)
    const html = generatePlatformInvoiceHtml(data)
    return this.pdf.generateFromHtml(html)
  }

  /**
   * Mailar fakturan till kundens billingEmail (fallback: organization.email).
   * Bifogar PDF, sätter sentAt + status SENT.
   */
  /**
   * Validerar plattformsfakturan och köar utskicket. PDF-rendering + mejl
   * sker i PdfWorker (processSendJob) så HTTP-svaret returneras direkt (202).
   */
  async send(id: string): Promise<{ jobId: string }> {
    const row = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!row) throw new NotFoundException('Fakturan hittades inte')
    if (row.status === 'PAID' || row.status === 'VOID') {
      throw new BadRequestException('Kan inte skicka en betald eller makulerad faktura')
    }
    const jobId = await this.pdfQueue.enqueue({
      kind: 'platform-invoice-send',
      platformInvoiceId: id,
    })
    return { jobId }
  }

  /**
   * Renderar plattformsfaktura-PDF, köar mejlet och sätter status SENT.
   * Anropas av PdfWorker. Mejlet har en idempotencyKey så en Bull-retry inte
   * ger dubbelmejl; vid fel sparas lastSendError och felet kastas vidare.
   */
  async processSendJob(id: string): Promise<void> {
    const row = await this.prisma.platformInvoice.findUnique({
      where: { id },
      include: { organization: true },
    })
    if (!row) throw new NotFoundException('Fakturan hittades inte')
    if (row.status === 'PAID' || row.status === 'VOID') {
      this.logger.warn(`[pdf] hoppar över platform-invoice-send för ${id} — status ${row.status}`)
      return
    }

    const recipient = row.organization.billingEmail ?? row.organization.email

    try {
      const pdfBuffer = await this.generatePdf(id)
      const amountGross = Number(row.amount)
      const amountNet = roundSek(amountGross / (1 + VAT_RATE / 100))
      const periodLabel = this.periodLabel(row.planPeriodStart, row.planPeriodEnd)

      await this.mail.enqueue({
        template: 'custom',
        priority: 'high',
        to: recipient,
        subject: `Faktura ${row.invoiceNumber} från ${PLATFORM_COMPANY.brandName}`,
        props: {
          preview: `Faktura ${row.invoiceNumber} – ${amountGross.toFixed(2)} kr`,
          tenantName: row.organization.name,
          organizationName: PLATFORM_COMPANY.legalName,
          whyReceived: `Du fick det här mejlet för att ${row.organization.name} har ett abonnemang hos ${PLATFORM_COMPANY.brandName}.`,
          bodyHtml: `
          <h1 style="color:#111827;font-size:22px;margin:0 0 16px;">Faktura ${row.invoiceNumber}</h1>
          <p>Tack för att ni använder ${PLATFORM_COMPANY.brandName}. Här kommer er faktura${
            periodLabel ? ` för <strong>${periodLabel}</strong>` : ''
          }.</p>
          <table style="border-collapse:collapse;margin:16px 0;font-size:14px;">
            <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">Belopp exkl moms</td><td style="padding:4px 0;">${amountNet.toFixed(2)} kr</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">Moms ${VAT_RATE}%</td><td style="padding:4px 0;">${(amountGross - amountNet).toFixed(2)} kr</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B7280;"><strong>Att betala</strong></td><td style="padding:4px 0;"><strong>${amountGross.toFixed(2)} kr</strong></td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">Förfallodatum</td><td style="padding:4px 0;">${row.dueDate.toISOString().slice(0, 10)}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">Bankgiro</td><td style="padding:4px 0;">${PLATFORM_COMPANY.bankgiro}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">OCR</td><td style="padding:4px 0;font-family:monospace;">${generatePlatformOcr(row.invoiceNumber)}</td></tr>
          </table>
          <p>Komplett faktura finns bifogad som PDF.</p>
          <p>Frågor? Svara på det här mejlet så hjälper vi dig.</p>
        `,
        },
        attachments: [
          {
            filename: `${row.invoiceNumber}.pdf`,
            content: pdfBuffer,
          },
        ],
        idempotencyKey: `platform-invoice-send-${row.id}`,
      })

      await this.prisma.platformInvoice.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date(), lastSendError: null },
      })
    } catch (err) {
      // Misslyckat utskick raderar inte fakturan — den ligger kvar som
      // DRAFT med felet sparat så den kan skickas om från admin-UI.
      const msg = err instanceof Error ? err.message : String(err)
      await this.prisma.platformInvoice
        .update({ where: { id }, data: { lastSendError: msg.slice(0, 500) } })
        .catch(() => undefined)
      throw err
    }
  }

  // ─── Markera betald ──────────────────────────────────────────────────────

  /**
   * Sätter status till PAID och uppdaterar betalningsmetadata. För
   * AI_CREDITS-fakturor läggs credits-saldot till på organisationen
   * (om beskrivningen specificerar antal credits).
   */
  async markPaid(id: string, input: MarkPaidInput) {
    const row = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!row) throw new NotFoundException('Fakturan hittades inte')
    if (row.status === 'PAID') throw new BadRequestException('Fakturan är redan betald')
    if (row.status === 'VOID')
      throw new BadRequestException('Kan inte markera en makulerad faktura som betald')

    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date()

    const updated = await this.prisma.$transaction(async (tx) => {
      const inv = await tx.platformInvoice.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt,
          paymentMethod: input.paymentMethod,
          ...(input.paymentReference ? { paymentReference: input.paymentReference } : {}),
        },
        include: {
          organization: { select: { id: true, name: true, email: true, billingEmail: true } },
        },
      })

      // Om AI_CREDITS: extrahera antal credits från description (vi sparar
      // alltid antalet i beskrivningen vid skapande av buy-credits) och
      // lägg till på organisationen.
      if (inv.type === 'AI_CREDITS') {
        const credits = this.extractCredits(inv.description)
        if (credits > 0) {
          await tx.organization.update({
            where: { id: inv.organizationId },
            data: { aiCreditsBalance: { increment: credits } },
          })
          this.logger.log(
            `AI_CREDITS-faktura ${inv.invoiceNumber} markerad betald — la till ${credits} credits på org ${inv.organizationId}`,
          )
        }
      }

      // Om organisationen är PAST_DUE → återställ till ACTIVE när
      // utestående fakturor är borta.
      const otherUnpaid = await tx.platformInvoice.count({
        where: {
          organizationId: inv.organizationId,
          status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
        },
      })
      if (otherUnpaid === 0) {
        await tx.organization.updateMany({
          where: { id: inv.organizationId, status: { in: ['PAST_DUE', 'SUSPENDED'] } },
          data: { status: 'ACTIVE', suspendedAt: null },
        })
      }

      return inv
    })

    return this.map(updated)
  }

  async voidInvoice(id: string) {
    const row = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!row) throw new NotFoundException('Fakturan hittades inte')
    if (row.status === 'PAID') throw new BadRequestException('Kan inte makulera en betald faktura')
    const updated = await this.prisma.platformInvoice.update({
      where: { id },
      data: { status: 'VOID', voidedAt: new Date(), voidedReason: 'manual_void' },
      include: {
        organization: { select: { id: true, name: true, email: true, billingEmail: true } },
      },
    })
    return this.map(updated)
  }

  // ─── Cron: månadsskapande ──────────────────────────────────────────────────

  /**
   * MÅNADS-cron: 1:a varje månad kl 08:00. T5 B1c — cron-vägen lindas i
   * runCronSafely med level:'fatal': MÅNADS-cadence, så en transient DB-blipp på
   * org-listans findMany = hela månadens plattformsfakturor uteblir och nästa
   * försök dröjer ~30 dagar → högsta larmnivå. Den manuella createMonthlyInvoices()
   * (admin "kör nu" via controllern) lämnas ORÖRD så att UI:t ser felet direkt.
   * Per-org-isoleringen + idempotensen sitter i generateInvoicesForPeriod och
   * delas därför av båda vägarna.
   */
  @Cron('0 8 1 * *')
  async createMonthlyInvoicesCron(): Promise<void> {
    await runCronSafely('platform-invoices-monthly', () => this.createMonthlyInvoices(), {
      logger: this.logger,
      level: 'fatal',
    })
  }

  /**
   * Genererar (och auto-skickar om AUTO_SEND_PLATFORM_INVOICES != false)
   * PLAN_FEE-fakturor för föregående kalendermånad. Anropas av månads-cronen
   * ovan OCH manuellt av admin (controller "cron/monthly") — den manuella vägen
   * kastar vidare så UI:t ser eventuella fel direkt.
   */
  async createMonthlyInvoices(): Promise<GenerationResult> {
    const now = new Date()
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    this.logger.log(
      `Månadscron: period ${periodStart.toISOString().slice(0, 10)} – ${periodEnd
        .toISOString()
        .slice(0, 10)}, auto-send=${this.autoSendEnabled}`,
    )
    const result = await this.generateInvoicesForPeriod(periodStart, periodEnd)
    this.logger.log(
      `Månadscron klar: ${result.created} skapade, ${result.sent} skickade, ${result.skipped} hoppade, ${result.failed} misslyckade`,
    )
    return result
  }

  /**
   * Backfill av en specifik (missad) månad. year/month (month 1-12) måste
   * peka på en period som redan passerat. Samma kärnlogik som månadscron.
   */
  async backfillForPeriod(year: number, month: number): Promise<GenerationResult> {
    const { periodStart, periodEnd } = this.resolvePeriod(year, month)
    this.logger.log(
      `Backfill: period ${periodStart.toISOString().slice(0, 10)} – ${periodEnd
        .toISOString()
        .slice(0, 10)}, auto-send=${this.autoSendEnabled}`,
    )
    const result = await this.generateInvoicesForPeriod(periodStart, periodEnd)
    this.logger.log(
      `Backfill klar: ${result.created} skapade, ${result.sent} skickade, ${result.skipped} hoppade, ${result.failed} misslyckade`,
    )
    return result
  }

  /**
   * Torrkörning för UI-bekräftelsen: vilka organisationer skulle faktureras
   * för en period, hur många har redan en faktura, och förväntat belopp.
   * Utan year/month används föregående kalendermånad.
   */
  async previewForPeriod(year?: number, month?: number) {
    const { periodStart, periodEnd, label } = this.resolvePeriod(year, month, true)
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE', planMonthlyFee: { gt: 0 }, excludeFromBilling: false },
      select: { id: true, name: true, subscriptionPlan: true, planMonthlyFee: true },
      orderBy: { name: 'asc' },
    })
    const existing = await this.prisma.platformInvoice.findMany({
      where: { type: 'PLAN_FEE', planPeriodStart: periodStart },
      select: { organizationId: true },
    })
    const invoicedIds = new Set(existing.map((e) => e.organizationId))

    let eligible = 0
    let alreadyInvoiced = 0
    let expectedNetTotal = 0
    const orgList = orgs.map((o) => {
      const has = invoicedIds.has(o.id)
      if (has) alreadyInvoiced += 1
      else {
        eligible += 1
        expectedNetTotal += Number(o.planMonthlyFee)
      }
      return {
        id: o.id,
        name: o.name,
        plan: o.subscriptionPlan,
        planMonthlyFee: Number(o.planMonthlyFee),
        alreadyHasInvoice: has,
      }
    })

    return {
      period: {
        start: periodStart.toISOString().slice(0, 10),
        end: periodEnd.toISOString().slice(0, 10),
        label,
      },
      eligible,
      alreadyInvoiced,
      expectedNetTotal: roundSek(expectedNetTotal),
      expectedGrossTotal: roundSek(expectedNetTotal * (1 + VAT_RATE / 100)),
      autoSend: this.autoSendEnabled,
      orgs: orgList,
    }
  }

  /**
   * Kärnlogiken bakom månadscron och backfill. Per organisation:
   *  1. App-nivå idempotens-koll (snabb väg) — hoppa om faktura finns
   *  2. Skapa fakturan (Prisma P2002 från det partiella unika indexet
   *     fångas och behandlas som "skipped" — skyddar mot races)
   *  3. Om auto-send på: maila direkt; ett misslyckat utskick lämnar
   *     fakturan som DRAFT med lastSendError satt (blockerar inte resten)
   *
   * excludeFromBilling-orgs och inaktiva/0-avgift-orgs filtreras bort.
   */
  private async generateInvoicesForPeriod(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<GenerationResult> {
    const periodTag = periodStart.toISOString().slice(0, 7)
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE', planMonthlyFee: { gt: 0 }, excludeFromBilling: false },
      select: { id: true, name: true, planMonthlyFee: true },
    })

    const summary: GenerationResult = { created: 0, sent: 0, failed: 0, skipped: 0, failures: [] }

    // T5 B1c — per-org-isolering + idempotens PER ORG inne i callbacken (inte
    // bara ett try runt hela loopen). Ett org-fel isoleras (nästa org körs) och
    // LARMAR via Sentry (org-tagg). Idempotensen (findFirst + P2002-fångst)
    // ligger kvar per org: körs generateInvoicesForPeriod två gånger hittar
    // andra körningen fakturan och hoppar (skipped) → ingen dubbelfaktura.
    // summary muteras in-place och returneras nedan (delas av cron + backfill).
    await forEachOrgSafely(
      'platform-invoices-monthly',
      orgs,
      async (org) => {
        // 1+2) Idempotens-koll OCH skapande i SAMMA try. findFirst MÅSTE ligga
        //   inne i try:et: kastar det (transient DB-blipp — precis det T5 B1
        //   skyddar mot) räknas org:en som `failed` + får en UI-rad, exakt som
        //   ett create-fel. Låg findFirst utanför → org:en isolerades av
        //   forEachOrgSafely men FÖLL UR summary (failed/failures nämnde den
        //   aldrig) → GenerationResult under-rapporterade tyst (created+sent+
        //   skipped+failed summerade inte till antal orgar) och admin-"kör nu"
        //   fick 200 med en org bortglömd. Kontraktet ska vara identiskt.
        let invoiceNumber: string
        let invoiceId: string
        try {
          // App-nivå idempotens (snabb väg): finns redan en PLAN_FEE för perioden
          // → hoppa. Dubbelt skydd med det partiella unika DB-indexet (P2002
          // nedan) som täcker samtidiga races mellan findFirst och create.
          const existing = await this.prisma.platformInvoice.findFirst({
            where: { organizationId: org.id, type: 'PLAN_FEE', planPeriodStart: periodStart },
            select: { id: true },
          })
          if (existing) {
            summary.skipped += 1
            return
          }

          const inv = await this.create({
            organizationId: org.id,
            type: 'PLAN_FEE',
            amountNetSek: Number(org.planMonthlyFee),
            planPeriodStart: periodStart,
            planPeriodEnd: periodEnd,
            description: `Eveno månadsavgift ${periodTag}`,
          })
          invoiceNumber = inv.invoiceNumber
          invoiceId = inv.id
          summary.created += 1
        } catch (err) {
          // BENIGN skip ENDAST om P2002 kommer från PERIOD-idempotens-indexet
          // (samtidig körning skapade fakturan för samma org+period) → idempotent,
          // inget larm, ingen dubbelfaktura. isPeriodIdempotencyConflict kollar
          // err.meta.target så att en P2002 på invoiceNumber-unikheten (ett
          // nummer-race) INTE tyst maskeras som "fakturan fanns redan". Med den
          // atomiska nummer-sekvensen (allocatePlatformInvoiceNumber) är ett
          // nummer-race i praktiken omöjligt, men disambigueringen är fail-safe:
          // om en invoiceNumber-P2002 ändå sker faller den igenom till failed +
          // larm nedan i stället för att en faktura tyst försvinner.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002' &&
            isPeriodIdempotencyConflict(err)
          ) {
            summary.skipped += 1
            this.logger.log(`${org.name}: faktura för ${periodTag} finns redan (race), hoppar över`)
            return
          }
          // Allt annat (inkl en icke-period-P2002 som invoiceNumber-kollisionen,
          // eller ett fel i idempotens-kollen): räkna som failed + UI-rad OCH kasta
          // vidare så forEachOrgSafely isolerar org:en (nästa org körs) + larmar.
          summary.failed += 1
          const msg = err instanceof Error ? err.message : String(err)
          summary.failures.push(`${org.name}: fakturering misslyckades — ${msg}`)
          throw err
        }

        // 3) Auto-send av → lämna som DRAFT (gamla beteendet).
        if (!this.autoSendEnabled) {
          this.logger.log(`${invoiceNumber}: skapad (auto-send av — lämnas som DRAFT)`)
          return
        }

        // 4) Skicka. Ett utskicksfel lämnar en GILTIG DRAFT-faktura med
        //    lastSendError satt (se send/processSendJob) → best-effort: vi kastar
        //    INTE (fakturan finns, skickas om från admin-UI), bara UI-rad + warn.
        try {
          await this.send(invoiceId)
          summary.sent += 1
          this.logger.log(`${invoiceNumber}: skapad + skickad`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          summary.failures.push(`${invoiceNumber}: skapad men utskick misslyckades — ${msg}`)
          this.logger.warn(`${invoiceNumber}: skapad men send misslyckades: ${msg}`)
        }
      },
      { logger: this.logger, orgIdOf: (o) => o.id },
    )

    return summary
  }

  /**
   * Härleder period-fönstret för en given (year, month). month är 1-12.
   * Utan argument (eller med allowDefault) används föregående kalendermånad.
   * Validerar att perioden ligger i det förflutna och inte före 2025.
   */
  private resolvePeriod(
    year?: number,
    month?: number,
    allowDefault = false,
  ): { periodStart: Date; periodEnd: Date; label: string } {
    const now = new Date()
    let y: number
    let m0: number // 0-indexerad månad
    if (year === undefined || month === undefined) {
      if (!allowDefault) throw new BadRequestException('year och month krävs')
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      y = prev.getFullYear()
      m0 = prev.getMonth()
    } else {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new BadRequestException('month måste vara 1-12')
      }
      if (!Number.isInteger(year) || year < 2025) {
        throw new BadRequestException('year måste vara 2025 eller senare')
      }
      y = year
      m0 = month - 1
    }
    const periodStart = new Date(y, m0, 1)
    const periodEnd = new Date(y, m0 + 1, 0, 23, 59, 59, 999)
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    if (periodStart >= thisMonthStart) {
      throw new BadRequestException('Kan inte fakturera innevarande eller framtida månad')
    }
    return {
      periodStart,
      periodEnd,
      label: `${MONTHS_SV[m0]} ${y}`,
    }
  }

  // ─── Cron: påminnelser + status-eskalering ────────────────────────────────

  /**
   * Daglig påminnelse-cron. Tre stegs eskalering:
   *  - 7 dagar förfallen: skicka påminnelse (sätt status OVERDUE)
   *  - 14 dagar förfallen: sätt org.status = PAST_DUE
   *  - 30 dagar förfallen: sätt org.status = SUSPENDED
   */
  @Cron('0 9 * * *')
  async sendRemindersAndEscalate(): Promise<void> {
    // T5 B1c — cron-only (ingen manuell controller-väg). Linda hela kroppen i
    // runCronSafely: en DB-blipp på reminder-findMany eller på bulk-eskaleringen
    // (updateMany) larmar nu via Sentry i stället för tyst död. Daglig cadence →
    // standard-larmnivå. Per-invoice-påminnelserna isoleras dessutom med
    // forEachOrgSafely (ett fel stoppar inte resten + Sentry per org).
    await runCronSafely(
      'platform-invoices-reminders-escalate',
      async () => {
        const now = new Date()
        const day = 24 * 60 * 60 * 1000

        // 1) Påminnelser efter 7 dagar (sätter OVERDUE och mailar). Mail-fel
        //    sväljs redan lokalt (.catch); det som kan kasta är status-updaten →
        //    forEachOrgSafely isolerar per invoice + larmar Sentry (org-tagg).
        const sevenDaysAgo = new Date(now.getTime() - 7 * day)
        const reminderCandidates = await this.prisma.platformInvoice.findMany({
          where: {
            status: { in: ['SENT', 'PENDING'] },
            dueDate: { lt: sevenDaysAgo },
          },
          include: {
            organization: { select: { id: true, name: true, email: true, billingEmail: true } },
          },
        })

        await forEachOrgSafely(
          'platform-invoices-reminders',
          reminderCandidates,
          async (inv) => {
            const recipient = inv.organization.billingEmail ?? inv.organization.email
            await this.mail
              .enqueue({
                template: 'custom',
                priority: 'high',
                to: recipient,
                subject: `Påminnelse: faktura ${inv.invoiceNumber} förfallen`,
                props: {
                  preview: `Faktura ${inv.invoiceNumber} är förfallen sedan ${inv.dueDate.toISOString().slice(0, 10)}`,
                  tenantName: inv.organization.name,
                  organizationName: PLATFORM_COMPANY.legalName,
                  whyReceived: `Du fick det här mejlet eftersom ${inv.organization.name} har en obetald faktura hos ${PLATFORM_COMPANY.brandName}.`,
                  bodyHtml: `
                <h1 style="color:#111827;font-size:22px;margin:0 0 16px;">Påminnelse – faktura ${inv.invoiceNumber}</h1>
                <p>Vi har ännu inte mottagit betalning för faktura <strong>${inv.invoiceNumber}</strong> som förföll <strong>${inv.dueDate.toISOString().slice(0, 10)}</strong>.</p>
                <p>Vänligen betala snarast med OCR <code>${generatePlatformOcr(inv.invoiceNumber)}</code> till bankgiro ${PLATFORM_COMPANY.bankgiro}.</p>
                <p>Har ni redan betalt – tack, ignorera detta mejl. Frågor? Svara på det här mejlet.</p>
              `,
                },
                idempotencyKey: `platform-invoice-reminder-${inv.id}-${Math.floor((now.getTime() - inv.dueDate.getTime()) / day)}`,
              })
              .catch(() => undefined)

            await this.prisma.platformInvoice.update({
              where: { id: inv.id },
              data: {
                status: 'OVERDUE',
                reminderCount: { increment: 1 },
                lastReminderAt: now,
              },
            })
          },
          { logger: this.logger, orgIdOf: (inv) => inv.organizationId },
        )

        // 2) 14 dagar förfallen → PAST_DUE (atomär bulk)
        const fourteenDaysAgo = new Date(now.getTime() - 14 * day)
        const fourteenOverdue = await this.prisma.platformInvoice.findMany({
          where: { status: 'OVERDUE', dueDate: { lt: fourteenDaysAgo } },
          select: { organizationId: true },
        })
        if (fourteenOverdue.length > 0) {
          await this.prisma.organization.updateMany({
            where: {
              id: { in: fourteenOverdue.map((i) => i.organizationId) },
              status: 'ACTIVE',
            },
            data: { status: 'PAST_DUE' },
          })
        }

        // 3) 30 dagar förfallen → SUSPENDED (atomär bulk)
        const thirtyDaysAgo = new Date(now.getTime() - 30 * day)
        const thirtyOverdue = await this.prisma.platformInvoice.findMany({
          where: { status: 'OVERDUE', dueDate: { lt: thirtyDaysAgo } },
          select: { organizationId: true },
        })
        if (thirtyOverdue.length > 0) {
          await this.prisma.organization.updateMany({
            where: {
              id: { in: thirtyOverdue.map((i) => i.organizationId) },
              status: { in: ['ACTIVE', 'PAST_DUE'] },
            },
            data: { status: 'SUSPENDED', suspendedAt: now },
          })
        }

        this.logger.log(
          `Påminnelse-cron: ${reminderCandidates.length} påminnelser, ${fourteenOverdue.length} PAST_DUE, ${thirtyOverdue.length} SUSPENDED`,
        )
      },
      { logger: this.logger },
    )
  }

  // ─── Cron: trial-livscykel ────────────────────────────────────────────────

  /**
   * DAGLIG trial-konverterings-cron kl 07:00 (en timme före månadsfaktura-cron).
   * T5 B1c — cron-vägen lindas i runCronSafely (DAGLIG cadence → standard-
   * larmnivå, INTE fatal): en transient DB-blipp på org-listans findMany larmar
   * via Sentry i stället för tyst död. Den manuella convertExpiredTrials()
   * (admin "kör nu" via controllern) lämnas ORÖRD så UI:t ser felet. Per-org-
   * isoleringen sitter i convertExpiredTrials och delas av båda vägarna.
   */
  @Cron('0 7 * * *')
  async convertExpiredTrialsCron(): Promise<void> {
    await runCronSafely('platform-invoices-convert-trials', () => this.convertExpiredTrials(), {
      logger: this.logger,
    })
  }

  /**
   * För varje organisation vars trial gått ut (utöver TRIAL_GRACE_PERIOD_DAYS):
   *  • Grandfather: konton skapade före lanseringen ({@link GRANDFATHER_CUTOFF})
   *    får en engångsförlängning på 30 dagar så de hinner få varningsmejlen
   *    innan de pausas (de hade aldrig något konverteringsflöde tidigare).
   *  • CASE A — plan vald (subscriptionPlan != TRIAL): → ACTIVE, sätt
   *    planMonthlyFee från PLAN_LIMITS, maila välkomstmejl.
   *  • CASE B — ingen plan vald: → SUSPENDED, maila "trial slut"-mejl.
   *
   * Anropas av daglig cron ovan OCH manuellt av admin (controller
   * "cron/trials/convert") — den manuella vägen kastar vidare vid outer-fel.
   */
  async convertExpiredTrials(): Promise<{
    converted: number
    suspended: number
    grandfathered: number
    failed: number
  }> {
    const now = new Date()
    const cutoff = new Date(now.getTime() - this.trialGracePeriodDays * 24 * 60 * 60 * 1000)

    const expired = await this.prisma.organization.findMany({
      where: { status: 'TRIAL', trialEndsAt: { not: null, lt: cutoff } },
      select: {
        id: true,
        name: true,
        email: true,
        billingEmail: true,
        subscriptionPlan: true,
        trialEndsAt: true,
        createdAt: true,
        users: {
          where: { role: 'OWNER' },
          select: { firstName: true, email: true },
          take: 1,
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    const summary = { converted: 0, suspended: 0, grandfathered: 0, failed: 0 }

    // T5 B1c — per-org-isolering: ett org-fel isoleras (nästa org körs) + larmar
    // via Sentry (org-tagg); failed räknas från helperns fel-lista. Idempotent
    // per org: grandfather sätter trialEndsAt > cutoff, CASE A sätter status
    // ACTIVE och CASE B sätter SUSPENDED → nästa körning plockar inte upp samma
    // org igen (where-filtret kräver status TRIAL + trialEndsAt < cutoff). Inget
    // lokalt try/catch — oväntade kast bubblar till forEachOrgSafely.
    const failures = await forEachOrgSafely(
      'platform-invoices-convert-trials',
      expired,
      async (org) => {
        // Grandfather (engångs): pre-lansering-konto vars trial inte redan
        // skjutits förbi cutoff:en. Förlängningen sätter trialEndsAt > cutoff
        // vilket gör villkoret falskt vid nästa körning → idempotent.
        if (
          org.createdAt < GRANDFATHER_CUTOFF &&
          (org.trialEndsAt ?? new Date(0)) <= GRANDFATHER_CUTOFF
        ) {
          const newEnd = new Date(GRANDFATHER_CUTOFF.getTime() + 30 * 24 * 60 * 60 * 1000)
          await this.prisma.organization.update({
            where: { id: org.id },
            data: { trialEndsAt: newEnd },
          })
          summary.grandfathered += 1
          this.logger.log(
            `Grandfather: ${org.name} trial förlängd till ${newEnd.toISOString().slice(0, 10)}`,
          )
          return
        }

        const owner = org.users[0]
        const recipient = org.billingEmail ?? owner?.email ?? org.email
        const firstName = owner?.firstName ?? 'där'

        if (org.subscriptionPlan !== 'TRIAL') {
          // CASE A — kunden valde en plan under trial
          const plan = org.subscriptionPlan as SubscriptionPlan
          const fee = PLAN_LIMITS[plan].monthlyFee
          const planName = PLAN_LIMITS[plan].name
          await this.prisma.organization.update({
            where: { id: org.id },
            data: { status: 'ACTIVE', planStartedAt: now, planMonthlyFee: fee },
          })
          const nextMonth = MONTHS_SV[new Date(now.getFullYear(), now.getMonth() + 1, 1).getMonth()]
          await this.enqueueTrialMail(
            recipient,
            org.name,
            'Välkommen som betalande kund hos Eveno',
            `
              <h1 style="color:#111827;font-size:22px;margin:0 0 16px;">Välkommen som kund!</h1>
              <p>Hej ${escapeMailText(firstName)},</p>
              <p>Din provperiod har gått ut och din plan <strong>${planName}</strong> är nu aktiv.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px;">
                <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">Din månadsavgift</td><td style="padding:4px 0;">${fee} kr/mån exkl moms</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#6B7280;">Första faktura skickas</td><td style="padding:4px 0;">1:a ${nextMonth}</td></tr>
              </table>
              <p>Tack för att du valde ${PLATFORM_COMPANY.brandName}!</p>
            `,
            `platform-trial-converted-${org.id}`,
          )
          summary.converted += 1
          this.logger.log(`Konverterade ${org.name} → ACTIVE plan ${plan} (${fee} kr)`)
        } else {
          // CASE B — ingen plan vald, pausa kontot
          await this.prisma.organization.update({
            where: { id: org.id },
            data: { status: 'SUSPENDED', suspendedAt: now },
          })
          await this.enqueueTrialMail(
            recipient,
            org.name,
            'Din provperiod har gått ut',
            `
              <h1 style="color:#111827;font-size:22px;margin:0 0 16px;">Din provperiod har gått ut</h1>
              <p>Hej ${escapeMailText(firstName)},</p>
              <p>Din 30-dagars provperiod hos ${PLATFORM_COMPANY.brandName} har gått ut. För att fortsätta använda ${PLATFORM_COMPANY.brandName} behöver du välja en plan.</p>
              <p style="margin:20px 0;">
                <a href="${this.webAppUrl}/settings" style="background:${PLATFORM_COMPANY.primaryColor};color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Välj plan</a>
              </p>
              <p>Ditt konto är nu pausat. Din data är säker och återställs så fort du väljer en plan.</p>
            `,
            `platform-trial-expired-${org.id}`,
          )
          summary.suspended += 1
          this.logger.log(`Suspenderade ${org.name} — trial slut utan planval`)
        }
      },
      { logger: this.logger, orgIdOf: (o) => o.id },
    )
    summary.failed = failures.length

    this.logger.log(
      `Trial-cron klar: ${summary.converted} konverterade, ${summary.suspended} suspenderade, ${summary.grandfathered} grandfathered, ${summary.failed} fel`,
    )
    return summary
  }

  /**
   * Daglig varningskedja kl 09:00 för trials som snart går ut. Steg 7/3/1
   * dagar kvar. lastTrialReminderDays används som idempotensnyckel så att
   * samma (eller ett mindre brådskande) steg aldrig mailas dubbelt.
   */
  @Cron('0 9 * * *')
  async sendTrialEndingReminders(): Promise<{ sent: number }> {
    const now = new Date()
    const day = 24 * 60 * 60 * 1000
    const in7Days = new Date(now.getTime() + 7 * day)

    const candidates = await this.prisma.organization.findMany({
      where: { status: 'TRIAL', trialEndsAt: { not: null, gt: now, lt: in7Days } },
      select: {
        id: true,
        name: true,
        email: true,
        billingEmail: true,
        trialEndsAt: true,
        lastTrialReminderDays: true,
        users: {
          where: { role: 'OWNER' },
          select: { firstName: true, email: true },
          take: 1,
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    let sent = 0
    for (const org of candidates) {
      const trialEndsAt = org.trialEndsAt as Date
      const daysLeft = Math.ceil((trialEndsAt.getTime() - now.getTime()) / day)
      const step = daysLeft <= 1 ? 1 : daysLeft <= 3 ? 3 : 7
      // Hoppa om vi redan skickat detta steg eller ett mer brådskande
      // (mindre) steg (steg går 7 → 3 → 1, dvs avtagande).
      if (org.lastTrialReminderDays !== null && org.lastTrialReminderDays <= step) continue

      const owner = org.users[0]
      const recipient = org.billingEmail ?? owner?.email ?? org.email
      const firstName = owner?.firstName ?? 'där'
      const subject =
        step === 1
          ? 'Sista dagen av din provperiod'
          : step === 3
            ? '3 dagar kvar av din provperiod'
            : 'Din provperiod går ut om en vecka — välj plan nu'
      const lead =
        step === 1
          ? 'Detta är sista dagen av din provperiod.'
          : `Din provperiod hos ${PLATFORM_COMPANY.brandName} går ut om ${daysLeft} ${
              daysLeft === 1 ? 'dag' : 'dagar'
            }.`

      try {
        await this.enqueueTrialMail(
          recipient,
          org.name,
          subject,
          `
            <h1 style="color:#111827;font-size:22px;margin:0 0 16px;">${escapeMailText(subject)}</h1>
            <p>Hej ${escapeMailText(firstName)},</p>
            <p>${lead} Välj en plan nu så fortsätter allt fungera utan avbrott.</p>
            <p style="margin:20px 0;">
              <a href="${this.webAppUrl}/settings" style="background:${PLATFORM_COMPANY.primaryColor};color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Välj plan</a>
            </p>
            <p>Frågor? Svara på det här mejlet så hjälper vi dig.</p>
          `,
          `platform-trial-reminder-${org.id}-step${step}`,
        )
        await this.prisma.organization.update({
          where: { id: org.id },
          data: { lastTrialReminderDays: step },
        })
        sent += 1
      } catch (err) {
        this.logger.warn(
          `Trial-påminnelse misslyckades för ${org.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    this.logger.log(`Trial-påminnelser: ${sent} skickade`)
    return { sent }
  }

  /** Gemensam wrapper för trial-mejl via 'custom'-templaten (samma
   *  mönster som send() och påminnelse-cron). */
  private async enqueueTrialMail(
    to: string,
    orgName: string,
    subject: string,
    bodyHtml: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.mail
      .enqueue({
        template: 'custom',
        priority: 'high',
        to,
        subject,
        props: {
          preview: subject,
          tenantName: orgName,
          organizationName: PLATFORM_COMPANY.legalName,
          whyReceived: `Du fick det här mejlet eftersom ${orgName} har ett konto hos ${PLATFORM_COMPANY.brandName}.`,
          bodyHtml,
        },
        idempotencyKey,
      })
      .catch((err) => {
        this.logger.warn(
          `enqueueTrialMail misslyckades (${idempotencyKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
  }

  // ─── Hjälpfunktioner ──────────────────────────────────────────────────────

  private buildPdfData(row: {
    invoiceNumber: string
    type: PlatformInvoiceType
    amount: Prisma.Decimal
    description: string | null
    dueDate: Date
    planPeriodStart: Date | null
    planPeriodEnd: Date | null
    createdAt: Date
    organization: {
      name: string
      orgNumber: string | null
      email: string
      street: string
      city: string
      postalCode: string
      country: string
    }
  }): PlatformInvoicePdfData {
    const amountGross = Number(row.amount)
    const amountNet = roundSek(amountGross / (1 + VAT_RATE / 100))
    const vatAmount = roundSek(amountGross - amountNet)
    return {
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.createdAt,
      dueDate: row.dueDate,
      type: row.type,
      description: row.description,
      planPeriodStart: row.planPeriodStart,
      planPeriodEnd: row.planPeriodEnd,
      amountNetSek: amountNet,
      vatRate: VAT_RATE,
      vatAmountSek: vatAmount,
      amountGrossSek: amountGross,
      ocrNumber: generatePlatformOcr(row.invoiceNumber),
      customer: {
        name: row.organization.name,
        orgNumber: row.organization.orgNumber,
        email: row.organization.email,
        street: row.organization.street,
        postalCode: row.organization.postalCode,
        city: row.organization.city,
        country: row.organization.country,
      },
    }
  }

  private extractCredits(description: string | null): number {
    if (!description) return 0
    const match = description.match(/^\s*(\d+)\s+/) // "100 extra AI-credits..."
    return match ? Number(match[1]) : 0
  }

  private periodLabel(start: Date | null, end: Date | null): string {
    if (!start || !end) return ''
    return `${start.toISOString().slice(0, 7)}`
  }

  private map(r: {
    id: string
    organizationId: string
    invoiceNumber: string
    amount: Prisma.Decimal
    status: string
    type: string
    description: string | null
    dueDate: Date
    planPeriodStart: Date | null
    planPeriodEnd: Date | null
    sentAt: Date | null
    paidAt: Date | null
    paymentMethod: string | null
    paymentReference: string | null
    notes: string | null
    reminderCount: number
    lastReminderAt: Date | null
    createdAt: Date
    updatedAt: Date
    organization: { id: string; name: string; email: string; billingEmail: string | null }
  }) {
    const amountGross = Number(r.amount)
    const amountNet = roundSek(amountGross / (1 + VAT_RATE / 100))
    return {
      id: r.id,
      organizationId: r.organizationId,
      organization: r.organization,
      invoiceNumber: r.invoiceNumber,
      amountNetSek: amountNet,
      amountGrossSek: amountGross,
      vatRate: VAT_RATE,
      status: r.status,
      type: r.type,
      description: r.description,
      dueDate: r.dueDate.toISOString(),
      planPeriodStart: r.planPeriodStart?.toISOString() ?? null,
      planPeriodEnd: r.planPeriodEnd?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      paymentMethod: r.paymentMethod,
      paymentReference: r.paymentReference,
      notes: r.notes,
      reminderCount: r.reminderCount,
      lastReminderAt: r.lastReminderAt?.toISOString() ?? null,
      ocrNumber: generatePlatformOcr(r.invoiceNumber),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }
  }
}

function roundSek(n: number): number {
  return Math.round(n * 100) / 100
}
