import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { PLAN_LIMITS, getMonthStart, getNextResetAt } from '@eken/shared'
import type { SubscriptionPlan } from '@eken/shared'

/**
 * Plan-baserad AI-anropsräknare. Ersätter den tidigare kostnadsbaserade
 * SEK-budgeten med en räknare på MANUELLA AI-anrop per kalendermånad.
 *
 * Räknaren omfattar ENDAST anrop med isAutomated=false (admin via AiPage
 * eller chat). Automatiska anrop — morning insights, OCR, kontrakts-
 * skanning, hyresgäst-AI, bankavstämning — räknas inte alls och kan
 * aldrig blockeras av denna service. Det är ett medvetet beslut:
 * automatik är en del av baspriset och får inte stoppas av prisstrul.
 *
 * Workflow innan varje manuellt AI-anrop:
 *   1. Hämta org.subscriptionPlan + aiCreditsBalance
 *   2. Räkna manuella anrop denna månad
 *   3. Om över PLAN_LIMITS[plan].monthlyAiCalls:
 *      - Om aiCreditsBalance > 0: tillåt och dra 1 credit
 *      - Annars: kasta BadRequestException
 */
@Injectable()
export class AiQuotaService {
  private readonly logger = new Logger(AiQuotaService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kasta BadRequestException om organisationen nått sitt månadstak och inte
   * har några credits kvar. Anropas FÖRE varje manuellt AI-anrop.
   *
   * Om taket är nått men credits finns: drar 1 credit och tillåter anropet.
   * Returnerar { creditUsed: true } i så fall så att callsiten kan logga.
   */
  async checkQuota(organizationId: string): Promise<{ creditUsed: boolean }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        subscriptionPlan: true,
        aiCreditsBalance: true,
        status: true,
      },
    })
    if (!org) {
      throw new BadRequestException('Organisationen kunde inte hittas.')
    }

    if (org.status === 'SUSPENDED' || org.status === 'CANCELLED') {
      throw new BadRequestException(
        'Ditt konto är pausat. Kontakta supporten för att återaktivera.',
      )
    }

    const plan = org.subscriptionPlan as SubscriptionPlan
    const limit = PLAN_LIMITS[plan]
    if (!limit) {
      throw new BadRequestException('Ogiltig plan-konfiguration. Kontakta supporten.')
    }

    const used = await this.countManualCallsThisMonth(organizationId)

    if (used < limit.monthlyAiCalls) {
      return { creditUsed: false }
    }

    // Över taket — försök använda en credit
    if (org.aiCreditsBalance > 0) {
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { aiCreditsBalance: { decrement: 1 } },
      })
      this.logger.log(
        `Org ${organizationId} över tak (${used}/${limit.monthlyAiCalls}) — drog 1 credit (saldo nu ${org.aiCreditsBalance - 1})`,
      )
      return { creditUsed: true }
    }

    this.logger.warn(
      `Org ${organizationId} blockerad: ${used} manuella anrop, tak ${limit.monthlyAiCalls}, 0 credits`,
    )
    throw new BadRequestException(
      'Du har använt alla AI-frågor för denna månad. Köp extra credits eller uppgradera din plan i Inställningar.',
    )
  }

  /**
   * Aktuell status för UI. Visar inte automatiska anrop — bara manuella.
   */
  async getStatus(organizationId: string) {
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
    if (!org) {
      throw new BadRequestException('Organisationen kunde inte hittas.')
    }

    const plan = org.subscriptionPlan as SubscriptionPlan
    const limit = PLAN_LIMITS[plan]
    const used = await this.countManualCallsThisMonth(organizationId)
    const percentage = limit.monthlyAiCalls > 0 ? (used / limit.monthlyAiCalls) * 100 : 0

    return {
      plan,
      planName: limit.name,
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

  /** Endast manuella anrop denna kalendermånad. */
  private async countManualCallsThisMonth(organizationId: string): Promise<number> {
    return this.prisma.aiUsageLog.count({
      where: {
        organizationId,
        isAutomated: false,
        createdAt: { gte: getMonthStart() },
      },
    })
  }
}
