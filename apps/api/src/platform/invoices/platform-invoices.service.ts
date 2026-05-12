import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../common/prisma/prisma.service'
import { MailService } from '../../mail/mail.service'
import { PdfService } from '../../invoices/pdf.service'
import { PLATFORM_COMPANY, generatePlatformOcr } from '@eken/shared'
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

@Injectable()
export class PlatformInvoicesService {
  private readonly logger = new Logger(PlatformInvoicesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly pdf: PdfService,
  ) {}

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
    const invoiceNumber = await this.nextInvoiceNumber(input.type)
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : new Date(Date.now() + PLATFORM_COMPANY.paymentTermsDays * 24 * 60 * 60 * 1000)

    const row = await this.prisma.platformInvoice.create({
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

  async remove(id: string) {
    const existing = await this.prisma.platformInvoice.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Fakturan hittades inte')
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException('Endast DRAFT-fakturor kan raderas')
    }
    await this.prisma.platformInvoice.delete({ where: { id } })
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
  async send(id: string): Promise<{ id: string; sentTo: string }> {
    const row = await this.prisma.platformInvoice.findUnique({
      where: { id },
      include: { organization: true },
    })
    if (!row) throw new NotFoundException('Fakturan hittades inte')
    if (row.status === 'PAID' || row.status === 'VOID') {
      throw new BadRequestException('Kan inte skicka en betald eller makulerad faktura')
    }

    const recipient = row.organization.billingEmail ?? row.organization.email
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

    const updated = await this.prisma.platformInvoice.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date() },
      select: { id: true },
    })

    return { id: updated.id, sentTo: recipient }
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
      data: { status: 'VOID' },
      include: {
        organization: { select: { id: true, name: true, email: true, billingEmail: true } },
      },
    })
    return this.map(updated)
  }

  // ─── Cron: månadsskapande ──────────────────────────────────────────────────

  /**
   * Skapar PLAN_FEE-fakturor 1:a varje månad kl 08:00 för alla ACTIVE-orgs.
   * Period = föregående månad (kalender).
   *
   * Idempotent: vi hoppar över org+period-kombinationer som redan har en
   * faktura med samma planPeriodStart.
   */
  @Cron('0 8 1 * *')
  async createMonthlyInvoices(): Promise<{ created: number; skipped: number }> {
    const now = new Date()
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)

    this.logger.log(
      `Kör månadscron för plattformsfakturor: period ${periodStart.toISOString().slice(0, 10)} – ${periodEnd.toISOString().slice(0, 10)}`,
    )

    const orgs = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE', planMonthlyFee: { gt: 0 } },
      select: { id: true, name: true, planMonthlyFee: true },
    })

    let created = 0
    let skipped = 0

    for (const org of orgs) {
      const existing = await this.prisma.platformInvoice.findFirst({
        where: {
          organizationId: org.id,
          type: 'PLAN_FEE',
          planPeriodStart: periodStart,
        },
        select: { id: true },
      })
      if (existing) {
        skipped += 1
        continue
      }

      try {
        await this.create({
          organizationId: org.id,
          type: 'PLAN_FEE',
          amountNetSek: Number(org.planMonthlyFee),
          planPeriodStart: periodStart,
          planPeriodEnd: periodEnd,
          description: `Eveno månadsavgift ${periodStart.toISOString().slice(0, 7)}`,
        })
        created += 1
      } catch (err) {
        this.logger.warn(
          `Kunde inte skapa månadsfaktura för ${org.name}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    this.logger.log(`Månadscron klar: ${created} fakturor skapade, ${skipped} hoppade över`)
    return { created, skipped }
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
    const now = new Date()
    const day = 24 * 60 * 60 * 1000

    // 1) Päminnelser efter 7 dagar (sätter OVERDUE och mailar)
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

    for (const inv of reminderCandidates) {
      try {
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
      } catch (err) {
        this.logger.warn(
          `Påminnelse misslyckades för ${inv.invoiceNumber}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 2) 14 dagar förfallen → PAST_DUE
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

    // 3) 30 dagar förfallen → SUSPENDED
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

  /**
   * Fakturanummer:
   *   PLT-YYYY-NNNNN  (PLAN_FEE / OTHER)
   *   CR-YYYYMM-NNNN  (AI_CREDITS — behåller äldre prefix för konsistens)
   */
  private async nextInvoiceNumber(type: PlatformInvoiceType): Promise<string> {
    const now = new Date()
    if (type === 'AI_CREDITS') {
      const prefix = `CR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
      const last = await this.prisma.platformInvoice.findFirst({
        where: { invoiceNumber: { startsWith: prefix } },
        orderBy: { invoiceNumber: 'desc' },
        select: { invoiceNumber: true },
      })
      const next = last ? Number(last.invoiceNumber.split('-').pop()) + 1 : 1
      return `${prefix}-${String(next).padStart(4, '0')}`
    }
    const prefix = `PLT-${now.getFullYear()}`
    const count = await this.prisma.platformInvoice.count({
      where: { invoiceNumber: { startsWith: `${prefix}-` } },
    })
    return `${prefix}-${String(count + 1).padStart(5, '0')}`
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
