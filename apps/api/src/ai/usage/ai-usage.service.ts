import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { calculateCost, type UsageInput } from './ai-pricing'

export type AiEndpoint =
  | 'chat'
  | 'stream'
  | 'analysis'
  | 'memory'
  | 'contract-scan'
  | 'inspection-analyze'
  | 'daily-insights'

export interface AnthropicUsageBlock {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logga ett Anthropic-anrop. Anropas av varje service som ringer Anthropic
   * direkt efter att svaret kommit. Beräknar kostnad i USD/SEK från modell
   * och tokens.
   *
   * Misslyckas tyst (loggas som warn) — vi vill ALDRIG att en bugg i
   * loggningen ska blockera AI-funktionalitet.
   */
  async logUsage(args: {
    organizationId: string
    userId?: string | null
    endpoint: AiEndpoint
    model: string
    usage: AnthropicUsageBlock | null | undefined
  }): Promise<void> {
    if (!args.usage) {
      this.logger.warn(
        `Saknad usage-blob för ${args.endpoint} (org=${args.organizationId}) — kan inte logga kostnad`,
      )
      return
    }

    const usageInput: UsageInput = {
      model: args.model,
      inputTokens: args.usage.input_tokens ?? 0,
      cacheReadTokens: args.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: args.usage.cache_creation_input_tokens ?? 0,
      outputTokens: args.usage.output_tokens ?? 0,
    }
    // Avbryt om SDK:n inte rapporterade några tokens (kan ske vid API-fel)
    if (
      usageInput.inputTokens === 0 &&
      usageInput.outputTokens === 0 &&
      usageInput.cacheReadTokens === 0 &&
      usageInput.cacheWriteTokens === 0
    ) {
      return
    }
    const cost = calculateCost(usageInput)

    try {
      await this.prisma.aiUsageLog.create({
        data: {
          organizationId: args.organizationId,
          userId: args.userId ?? null,
          endpoint: args.endpoint,
          model: args.model,
          inputTokens: cost.inputTokens,
          cacheReadTokens: cost.cacheReadTokens,
          cacheWriteTokens: cost.cacheWriteTokens,
          outputTokens: cost.outputTokens,
          costUsd: cost.costUsd,
          costSek: cost.costSek,
        },
      })
    } catch (err) {
      this.logger.warn(
        `Kunde inte spara AiUsageLog för ${args.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Returnerar månadens totala kostnad i SEK för en organisation.
   * Räknar från första dagen i innevarande månad.
   */
  async getMonthlyCostSek(organizationId: string): Promise<number> {
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)

    const result = await this.prisma.aiUsageLog.aggregate({
      where: { organizationId, createdAt: { gte: start } },
      _sum: { costSek: true },
    })

    return Number(result._sum.costSek ?? 0)
  }

  /**
   * Detaljerad kostnadsbreakdown för månadsrapport.
   */
  async getMonthlyBreakdown(organizationId: string) {
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)

    const [byEndpoint, byUser, totals] = await Promise.all([
      this.prisma.aiUsageLog.groupBy({
        by: ['endpoint'],
        where: { organizationId, createdAt: { gte: start } },
        _sum: { costSek: true, inputTokens: true, outputTokens: true },
        _count: { id: true },
      }),
      this.prisma.aiUsageLog.groupBy({
        by: ['userId'],
        where: { organizationId, createdAt: { gte: start } },
        _sum: { costSek: true },
        _count: { id: true },
      }),
      this.prisma.aiUsageLog.aggregate({
        where: { organizationId, createdAt: { gte: start } },
        _sum: { costSek: true, inputTokens: true, outputTokens: true },
        _count: { id: true },
      }),
    ])

    return {
      periodStart: start.toISOString(),
      total: {
        callCount: totals._count.id,
        costSek: Number(totals._sum.costSek ?? 0),
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
      },
      byEndpoint: byEndpoint.map((row) => ({
        endpoint: row.endpoint,
        callCount: row._count.id,
        costSek: Number(row._sum.costSek ?? 0),
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
      })),
      byUser: byUser.map((row) => ({
        userId: row.userId,
        callCount: row._count.id,
        costSek: Number(row._sum.costSek ?? 0),
      })),
    }
  }
}
