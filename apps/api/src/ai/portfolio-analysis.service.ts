import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import Anthropic from '@anthropic-ai/sdk'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiUsageService } from './usage/ai-usage.service'
import { AiQuotaService } from './usage/ai-quota.service'

const MODEL = 'claude-sonnet-4-6'

export interface PortfolioInsight {
  category: string
  finding: string
  severity: 'info' | 'warning' | 'critical'
  action?: string
}

export interface PortfolioAnalysis {
  summary: string
  insights: PortfolioInsight[]
  recommendations: string[]
  generatedAt: string
}

type AnalysisType = 'revenue' | 'occupancy' | 'risks' | 'full'

@Injectable()
export class PortfolioAnalysisService {
  private readonly logger = new Logger(PortfolioAnalysisService.name)
  private readonly anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })

  constructor(
    private prisma: PrismaService,
    private readonly usage: AiUsageService,
    private readonly quota: AiQuotaService,
  ) {}

  async analyzePortfolio(
    organizationId: string,
    analysisType: AnalysisType,
  ): Promise<PortfolioAnalysis> {
    await this.quota.checkQuota(organizationId)
    const now = new Date()
    const twelveMonthsAgo = new Date(now)
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12)
    const sixtyDaysFromNow = new Date(now)
    sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60)
    const thirtyDaysFromNow = new Date(now)
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30)

    const dataContext = await this.fetchData(
      organizationId,
      analysisType,
      twelveMonthsAgo,
      sixtyDaysFromNow,
      thirtyDaysFromNow,
    )

    const prompt = this.buildPrompt(analysisType, dataContext)

    const response = await this.anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })

    void this.usage
      .logUsage({
        organizationId,
        endpoint: 'analysis',
        model: MODEL,
        usage: response.usage,
      })
      .catch((err: unknown) => this.logger.warn('logUsage(analysis) failed', err))

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''

    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()

    try {
      const parsed: unknown = JSON.parse(cleaned)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>)['summary'] === 'string' &&
        Array.isArray((parsed as Record<string, unknown>)['insights']) &&
        Array.isArray((parsed as Record<string, unknown>)['recommendations'])
      ) {
        const result = parsed as PortfolioAnalysis
        result.generatedAt = now.toISOString()
        return result
      }
      throw new Error('Unexpected response shape')
    } catch (err) {
      this.logger.error('Portfolio analysis parse error:', err, cleaned)
      throw new BadRequestException('AI-analysen returnerade ett ogiltigt format. Försök igen.')
    }
  }

  private async fetchData(
    organizationId: string,
    analysisType: AnalysisType,
    twelveMonthsAgo: Date,
    sixtyDaysFromNow: Date,
    thirtyDaysFromNow: Date,
  ): Promise<string> {
    const sections: string[] = []

    if (analysisType === 'revenue' || analysisType === 'full') {
      const invoices = await this.prisma.invoice.findMany({
        where: {
          organizationId,
          issueDate: { gte: twelveMonthsAgo },
        },
        select: {
          status: true,
          total: true,
          issueDate: true,
          paidAt: true,
          tenant: { select: { firstName: true, lastName: true, companyName: true } },
        },
        orderBy: { issueDate: 'desc' },
      })

      const revenueByMonth: Record<string, { paid: number; overdue: number; sent: number }> = {}
      for (const inv of invoices) {
        const month = inv.issueDate.toISOString().substring(0, 7)
        if (!revenueByMonth[month]) revenueByMonth[month] = { paid: 0, overdue: 0, sent: 0 }
        const amount = Number(inv.total)
        if (inv.status === 'PAID') revenueByMonth[month].paid += amount
        else if (inv.status === 'OVERDUE') revenueByMonth[month].overdue += amount
        else if (inv.status === 'SENT') revenueByMonth[month].sent += amount
      }

      const totalPaid = invoices
        .filter((i) => i.status === 'PAID')
        .reduce((s, i) => s + Number(i.total), 0)
      const totalOverdue = invoices
        .filter((i) => i.status === 'OVERDUE')
        .reduce((s, i) => s + Number(i.total), 0)

      sections.push(
        `INTÄKTSDATA (senaste 12 månader):
Totalt betalt: ${totalPaid.toFixed(2)} SEK
Totalt förfallet: ${totalOverdue.toFixed(2)} SEK
Antal fakturor: ${invoices.length}
Månadsvis: ${JSON.stringify(revenueByMonth, null, 2)}`,
      )
    }

    if (analysisType === 'occupancy' || analysisType === 'full') {
      const units = await this.prisma.unit.findMany({
        where: { property: { organizationId } },
        select: { status: true, type: true, monthlyRent: true, name: true },
      })

      const unitStats = units.reduce(
        (acc, u) => {
          acc[u.status] = (acc[u.status] ?? 0) + 1
          return acc
        },
        {} as Record<string, number>,
      )

      const expiringLeases = await this.prisma.lease.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { lte: sixtyDaysFromNow, gte: new Date() },
        },
        select: {
          endDate: true,
          monthlyRent: true,
          tenant: { select: { firstName: true, lastName: true, companyName: true } },
          unit: { select: { name: true } },
        },
      })

      sections.push(
        `UTHYRNINGSDATA:
Enheter per status: ${JSON.stringify(unitStats)}
Totalt antal enheter: ${units.length}
Avtal som löper ut inom 60 dagar: ${expiringLeases.length}
${expiringLeases.map((l) => `- ${l.unit.name} (${l.tenant.companyName ?? `${l.tenant.firstName ?? ''} ${l.tenant.lastName ?? ''}`.trim()}): ${l.endDate?.toISOString().substring(0, 10) ?? 'löpande'}`).join('\n')}`,
      )
    }

    if (analysisType === 'risks' || analysisType === 'full') {
      const overdueInvoices = await this.prisma.invoice.findMany({
        where: { organizationId, status: 'OVERDUE' },
        select: {
          invoiceNumber: true,
          total: true,
          dueDate: true,
          tenant: { select: { firstName: true, lastName: true, companyName: true, email: true } },
          customer: { select: { firstName: true, lastName: true, companyName: true, email: true } },
        },
        orderBy: { dueDate: 'asc' },
        take: 20,
      })

      const expiringRiskLeases = await this.prisma.lease.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { lte: thirtyDaysFromNow, gte: new Date() },
        },
        select: {
          endDate: true,
          monthlyRent: true,
          tenant: { select: { firstName: true, lastName: true, companyName: true } },
          unit: { select: { name: true } },
        },
      })

      sections.push(
        `RISKDATA:
Förfallna fakturor (${overdueInvoices.length} st):
${overdueInvoices
  .map((i) => {
    const p = i.tenant ?? i.customer
    const partyName = p ? (p.companyName ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()) : '–'
    return `- Faktura ${i.invoiceNumber}: ${Number(i.total).toFixed(2)} SEK, förfallen ${i.dueDate.toISOString().substring(0, 10)}, mottagare: ${partyName}`
  })
  .join('\n')}

Avtal som löper ut inom 30 dagar (${expiringRiskLeases.length} st):
${expiringRiskLeases.map((l) => `- ${l.unit.name}: ${l.endDate?.toISOString().substring(0, 10) ?? 'löpande'}, hyra ${Number(l.monthlyRent).toFixed(0)} SEK/mån`).join('\n')}`,
      )
    }

    return sections.join('\n\n')
  }

  private buildPrompt(analysisType: AnalysisType, dataContext: string): string {
    const focusMap: Record<AnalysisType, string> = {
      revenue: 'Fokusera på intäktstrender, sena betalningar och tillväxtmöjligheter.',
      occupancy: 'Fokusera på lediga enheter, uthyrningsgrad och kommande avtalsförnyelser.',
      risks: 'Fokusera på förfallna betalningar, riskabla avtal och åtgärdspunkter.',
      full: 'Ge en heltäckande analys av portföljens hälsa ur alla perspektiv.',
    }

    return `Du är en expert på svensk fastighetsförvaltning. Analysera följande data och returnera ENDAST giltig JSON.

${focusMap[analysisType]}

DATA:
${dataContext}

Returnera EXAKT detta JSON-format (inget annat):
{
  "summary": "En kortfattad sammanfattning på svenska (2-3 meningar)",
  "insights": [
    {
      "category": "Kategorinamn",
      "finding": "Vad analysen visar",
      "severity": "info|warning|critical",
      "action": "Rekommenderad åtgärd (valfritt)"
    }
  ],
  "recommendations": [
    "Konkret rekommendation 1",
    "Konkret rekommendation 2"
  ],
  "generatedAt": ""
}`
  }
}
