import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../../common/prisma/prisma.service'
import { AiUsageService } from './ai-usage.service'

@Injectable()
export class AiQuotaService {
  private readonly logger = new Logger(AiQuotaService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Hämta organisationens månads-budget i SEK. Bygger på Organization.plan
   * (default standard-tier 100 SEK, OWNER-tier 1 000 SEK).
   *
   * Konfigurerbart via env för enkel justering utan migration:
   *   AI_QUOTA_STANDARD_SEK (default 100)
   *   AI_QUOTA_OWNER_SEK (default 1000)
   */
  async getMonthlyBudgetSek(organizationId: string): Promise<number> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { plan: true },
    })
    if (!org) return 0

    const ownerBudget = Number(this.config.get<string | number>('AI_QUOTA_OWNER_SEK', 1000))
    const standardBudget = Number(this.config.get<string | number>('AI_QUOTA_STANDARD_SEK', 100))

    // PlatformPlan-enum: TRIAL, BASIC, STANDARD, PREMIUM. PREMIUM-kunder
    // får "owner-tier" budget, övriga standard.
    return org.plan === 'PREMIUM' ? ownerBudget : standardBudget
  }

  /**
   * Kasta BadRequestException om månadens kostnad överskrider budgeten.
   * Anropas innan varje AI-anrop. Hård gräns — när taket nås blockeras
   * alla AI-anrop tills nästa månadsskifte.
   */
  async checkQuota(organizationId: string): Promise<void> {
    const [used, budget] = await Promise.all([
      this.usage.getMonthlyCostSek(organizationId),
      this.getMonthlyBudgetSek(organizationId),
    ])

    if (budget <= 0) {
      // Defensivt: om budgeten på något sätt är 0 (saknad org) blockeras allt.
      throw new BadRequestException('AI-kvoten är inte konfigurerad. Kontakta administratören.')
    }

    if (used >= budget) {
      this.logger.warn(
        `AI-kvota överskriden för org ${organizationId}: ${used.toFixed(2)} / ${budget.toFixed(2)} SEK`,
      )
      throw new BadRequestException(
        `AI-kvoten för innevarande månad är förbrukad (${used.toFixed(0)} av ${budget.toFixed(0)} kr). Kontakta supporten för att höja kvoten.`,
      )
    }
  }

  /**
   * Returnerar status så UI:t kan visa "85 av 100 kr använt denna månad".
   */
  async getStatus(organizationId: string) {
    const [used, budget] = await Promise.all([
      this.usage.getMonthlyCostSek(organizationId),
      this.getMonthlyBudgetSek(organizationId),
    ])
    return {
      usedSek: used,
      budgetSek: budget,
      remainingSek: Math.max(0, budget - used),
      percentUsed: budget > 0 ? Math.round((used / budget) * 100) : 0,
      blocked: used >= budget,
    }
  }
}
