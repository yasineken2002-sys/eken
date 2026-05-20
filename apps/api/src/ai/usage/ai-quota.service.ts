import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { PLAN_LIMITS, getMonthStart, getNextResetAt } from '@eken/shared'
import type { SubscriptionPlan } from '@eken/shared'

// ─── Daglig kostnadsbroms (SEK) ──────────────────────────────────────────────
// Skyddar mot runaway-spending: AI-hallucinerade loop-anrop, missbruk eller
// buggiga klienter som spammar requests. Limiten är medvetet GENERÖS — normala
// användare ligger på 1–5 kr/dag, tunga användare 10–20 kr/dag. Att slå i taket
// betyder nästan alltid missbruk eller automation som gått snett.
//
// Org-capen (ORG_DAILY_LIMIT_SEK) gäller alla AI-anrop som passerar denna
// service (manuella chat + stream + analysis). User-capen
// (USER_DAILY_LIMIT_SEK) gäller endast MANUELLA anrop per användare.
const ORG_DAILY_LIMIT_SEK = 200
const USER_DAILY_LIMIT_SEK = 50

function getDayStart(): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start
}

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

    // Org-wide daily cost cap — körs FÖRE plan-räknaren så vi snabbt
    // stoppar runaway-spending oavsett om det är manuellt eller automatiskt.
    await this.checkOrgDailyCostCap(organizationId)

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

  /**
   * Org-wide daily cost cap. Räknar SUMMAN av costSek för alla AiUsageLog-rader
   * (manuella + automatiska) inom innevarande dygn. Kastar BadRequestException
   * om summan passerat ORG_DAILY_LIMIT_SEK.
   *
   * Anropas internt från checkQuota() så alla manuella entry-points (chat,
   * stream, analysis) automatiskt skyddas. Kan även anropas direkt från
   * automatiska jobb som vill respektera capen.
   */
  async checkOrgDailyCostCap(organizationId: string): Promise<void> {
    const result = await this.prisma.aiUsageLog.aggregate({
      where: {
        organizationId,
        createdAt: { gte: getDayStart() },
      },
      _sum: { costSek: true },
    })
    const orgSpend = Number(result._sum.costSek ?? 0)
    if (orgSpend > ORG_DAILY_LIMIT_SEK) {
      this.logger.warn(
        `Org ${organizationId} blockerad av daglig kostnadscap: ${orgSpend.toFixed(2)} kr > ${ORG_DAILY_LIMIT_SEK} kr`,
      )
      throw new BadRequestException(
        `Organisationens AI-budget för dagen (${orgSpend.toFixed(2)} kr av ${ORG_DAILY_LIMIT_SEK} kr) är uppnådd. Försök igen imorgon.`,
      )
    }
  }

  /**
   * Per-användare daglig kostnadscap. Räknar SUMMAN av costSek för endast
   * MANUELLA anrop (isAutomated=false) från denna user i denna org idag.
   * Kastar BadRequestException om summan passerat USER_DAILY_LIMIT_SEK.
   *
   * Anropas från ai-assistant.controller.ts (streamChat) och
   * ai-assistant.service.ts (chat). Automatiska jobb räknas inte mot
   * användarens cap.
   */
  async checkUserDailyCostCap(organizationId: string, userId: string): Promise<void> {
    const result = await this.prisma.aiUsageLog.aggregate({
      where: {
        organizationId,
        userId,
        isAutomated: false,
        createdAt: { gte: getDayStart() },
      },
      _sum: { costSek: true },
    })
    const userSpend = Number(result._sum.costSek ?? 0)
    if (userSpend > USER_DAILY_LIMIT_SEK) {
      this.logger.warn(
        `User ${userId} (org ${organizationId}) blockerad av daglig kostnadscap: ${userSpend.toFixed(2)} kr > ${USER_DAILY_LIMIT_SEK} kr`,
      )
      throw new BadRequestException(
        `AI-budget för dagen (${userSpend.toFixed(2)} kr av ${USER_DAILY_LIMIT_SEK} kr) är uppnådd. Försök igen imorgon eller kontakta admin för höjd gräns.`,
      )
    }
  }
}
