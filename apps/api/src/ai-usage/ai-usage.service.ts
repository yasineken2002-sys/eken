import { BadRequestException, Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { PLAN_LIMITS, getMonthStart, getNextResetAt, CREDIT_PACKAGES } from '@eken/shared'
import type { SubscriptionPlan } from '@eken/shared'

/**
 * Service för admin-frontend (Plan & AI-användning-sidan).
 * Aggregerar månadens manuella AI-anrop, balanser och historik.
 */
@Injectable()
export class AiUsagePageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aktuell statusbild för progress-bar + KPI-kort.
   */
  async current(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        subscriptionPlan: true,
        aiCreditsBalance: true,
        trialEndsAt: true,
        status: true,
        planStartedAt: true,
        planMonthlyFee: true,
      },
    })
    if (!org) throw new BadRequestException('Organisationen kunde inte hittas')

    const plan = org.subscriptionPlan as SubscriptionPlan
    const limit = PLAN_LIMITS[plan]

    const used = await this.prisma.aiUsageLog.count({
      where: {
        organizationId,
        isAutomated: false,
        createdAt: { gte: getMonthStart() },
      },
    })

    const percentage = limit.monthlyAiCalls > 0 ? (used / limit.monthlyAiCalls) * 100 : 0

    return {
      plan,
      planName: limit.name,
      planDescription: limit.description,
      status: org.status,
      used,
      limit: limit.monthlyAiCalls,
      percentage: Math.round(percentage * 100) / 100,
      resetsAt: getNextResetAt().toISOString(),
      creditsBalance: org.aiCreditsBalance,
      trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
      planStartedAt: org.planStartedAt.toISOString(),
      monthlyFee: Number(org.planMonthlyFee),
      maxObjects: limit.maxObjects,
    }
  }

  /**
   * Daglig användningshistorik för Recharts-graf. Returnerar manuella +
   * automatiska anrop separat så att UI kan visa två linjer.
   */
  async history(organizationId: string, days: number) {
    const safe = Math.min(180, Math.max(1, days))
    const from = new Date()
    from.setDate(from.getDate() - safe)
    from.setHours(0, 0, 0, 0)

    const rows = await this.prisma.aiUsageLog.findMany({
      where: { organizationId, createdAt: { gte: from } },
      select: {
        createdAt: true,
        isAutomated: true,
        costUsd: true,
      },
    })

    const buckets = new Map<
      string,
      { manualCalls: number; automatedCalls: number; costUsd: number }
    >()
    for (let d = 0; d < safe; d++) {
      const date = new Date(from.getTime() + d * 24 * 60 * 60 * 1000)
      buckets.set(date.toISOString().slice(0, 10), {
        manualCalls: 0,
        automatedCalls: 0,
        costUsd: 0,
      })
    }
    for (const row of rows) {
      const key = row.createdAt.toISOString().slice(0, 10)
      const bucket = buckets.get(key)
      if (!bucket) continue
      if (row.isAutomated) bucket.automatedCalls += 1
      else bucket.manualCalls += 1
      bucket.costUsd += Number(row.costUsd)
    }

    return Array.from(buckets.entries())
      .map(([date, v]) => ({
        date,
        manualCalls: v.manualCalls,
        automatedCalls: v.automatedCalls,
        costUsd: Math.round(v.costUsd * 10000) / 10000,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  /**
   * Skapar en pending plattformsfaktura för köp av extra AI-credits.
   * Yasin markerar betald manuellt i plattforms-admin, och då läggs
   * crediten till på organisationen.
   *
   * Returnerar faktura-referensen + det förväntade beloppet inkl moms
   * så att UI kan visa bekräftelse + fakturanummer.
   */
  async buyCredits(organizationId: string, amount: number) {
    const pkg = CREDIT_PACKAGES.find((p) => p.amount === amount)
    if (!pkg) {
      throw new BadRequestException(
        'Ogiltigt antal credits. Välj något av paketen 100, 500 eller 1 000.',
      )
    }

    const grossSek = Math.round(pkg.priceSek * 1.25 * 100) / 100
    const invoiceNumber = await this.nextCreditInvoiceNumber()

    // Beskrivningen MÅSTE börja med "<antal> " — PlatformInvoicesService.markPaid
    // läser av credits-antalet från denna prefix när Yasin markerar fakturan
    // som betald.
    const invoice = await this.prisma.platformInvoice.create({
      data: {
        organizationId,
        invoiceNumber,
        amount: grossSek,
        status: 'SENT',
        type: 'AI_CREDITS',
        description: `${pkg.amount} extra AI-credits (${pkg.priceSek} kr exkl moms)`,
        dueDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        sentAt: new Date(),
      },
    })

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountNetSek: pkg.priceSek,
      amountGrossSek: grossSek,
      credits: pkg.amount,
      dueDate: invoice.dueDate.toISOString(),
      status: invoice.status,
    }
  }

  /** Genererar ett kort fakturanummer av formen CR-YYYYMM-XXXX. */
  private async nextCreditInvoiceNumber(): Promise<string> {
    const now = new Date()
    const prefix = `CR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    const lastForMonth = await this.prisma.platformInvoice.findFirst({
      where: { invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: 'desc' },
      select: { invoiceNumber: true },
    })
    let next = 1
    if (lastForMonth) {
      const match = lastForMonth.invoiceNumber.match(/-(\d+)$/)
      if (match) next = Number(match[1]) + 1
    }
    return `${prefix}-${String(next).padStart(4, '0')}`
  }
}
