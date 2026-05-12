import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { PLAN_LIMITS, PLAN_ORDER, getMonthStart } from '@eken/shared'
import type { SubscriptionPlan } from '@eken/shared'

const USD_TO_SEK = 10.5 // Statisk växelkurs för uppskattning; justera vid behov.

@Injectable()
export class PlatformAiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tabellrad per organisation: manuell anrop denna månad + plan-tak + AI-kostnad
   * + margin (plan-intäkt - AI-kost). Används av AI-användning-sidan i admin.
   */
  async list(filter: {
    overEightyPct?: boolean
    overOneHundredPct?: boolean
    trialEndingSoon?: boolean
    highCostUsd?: number
  }) {
    const monthStart = getMonthStart()
    const orgs = await this.prisma.organization.findMany({
      where: { status: { not: 'CANCELLED' } },
      select: {
        id: true,
        name: true,
        subscriptionPlan: true,
        status: true,
        trialEndsAt: true,
        aiCreditsBalance: true,
        planMonthlyFee: true,
      },
      orderBy: { name: 'asc' },
    })

    const usage = await this.prisma.aiUsageLog.groupBy({
      by: ['organizationId', 'isAutomated'],
      where: { createdAt: { gte: monthStart } },
      _count: { _all: true },
      _sum: { costUsd: true },
    })

    const usageMap = new Map<
      string,
      { manualCalls: number; automatedCalls: number; costUsd: number }
    >()
    for (const row of usage) {
      const entry = usageMap.get(row.organizationId) ?? {
        manualCalls: 0,
        automatedCalls: 0,
        costUsd: 0,
      }
      if (row.isAutomated) entry.automatedCalls += row._count._all
      else entry.manualCalls += row._count._all
      entry.costUsd += Number(row._sum.costUsd ?? 0)
      usageMap.set(row.organizationId, entry)
    }

    const now = Date.now()
    const rows = orgs.map((org) => {
      const plan = org.subscriptionPlan as SubscriptionPlan
      const limit = PLAN_LIMITS[plan]
      const u = usageMap.get(org.id) ?? { manualCalls: 0, automatedCalls: 0, costUsd: 0 }
      const percentage = limit.monthlyAiCalls > 0 ? (u.manualCalls / limit.monthlyAiCalls) * 100 : 0
      const aiCostSek = Math.round(u.costUsd * USD_TO_SEK * 100) / 100
      const revenueSek = Number(org.planMonthlyFee)
      const marginSek = Math.round((revenueSek - aiCostSek) * 100) / 100
      const trialDaysLeft = org.trialEndsAt
        ? Math.ceil((org.trialEndsAt.getTime() - now) / (24 * 60 * 60 * 1000))
        : null
      const status: 'ok' | 'warning' | 'over' =
        percentage >= 100 ? 'over' : percentage >= 80 ? 'warning' : 'ok'

      return {
        id: org.id,
        name: org.name,
        plan,
        planName: limit.name,
        orgStatus: org.status,
        manualCalls: u.manualCalls,
        automatedCalls: u.automatedCalls,
        limit: limit.monthlyAiCalls,
        percentage: Math.round(percentage * 10) / 10,
        aiCostUsd: Math.round(u.costUsd * 10000) / 10000,
        aiCostSek,
        revenueSek,
        marginSek,
        creditsBalance: org.aiCreditsBalance,
        trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
        trialDaysLeft,
        status,
      }
    })

    let filtered = rows
    if (filter.overEightyPct) filtered = filtered.filter((r) => r.percentage >= 80)
    if (filter.overOneHundredPct) filtered = filtered.filter((r) => r.percentage >= 100)
    if (filter.trialEndingSoon)
      filtered = filtered.filter(
        (r) => r.orgStatus === 'TRIAL' && r.trialDaysLeft !== null && r.trialDaysLeft <= 7,
      )
    if (filter.highCostUsd !== undefined && filter.highCostUsd > 0)
      filtered = filtered.filter((r) => r.aiCostUsd > filter.highCostUsd!)

    return filtered
  }

  /**
   * Aggregerade KPI-tal för 4 toppkort: kunder/plan, MRR, AI-kost, margin, över-80-tak.
   */
  async kpis() {
    const monthStart = getMonthStart()
    const [orgs, usage] = await Promise.all([
      this.prisma.organization.findMany({
        where: { status: { not: 'CANCELLED' } },
        select: { id: true, subscriptionPlan: true, planMonthlyFee: true, status: true },
      }),
      this.prisma.aiUsageLog.groupBy({
        by: ['organizationId', 'isAutomated'],
        where: { createdAt: { gte: monthStart } },
        _count: { _all: true },
        _sum: { costUsd: true },
      }),
    ])

    const usageMap = new Map<string, { manualCalls: number; costUsd: number }>()
    for (const row of usage) {
      const entry = usageMap.get(row.organizationId) ?? { manualCalls: 0, costUsd: 0 }
      if (!row.isAutomated) entry.manualCalls += row._count._all
      entry.costUsd += Number(row._sum.costUsd ?? 0)
      usageMap.set(row.organizationId, entry)
    }

    const perPlan: Record<string, number> = Object.fromEntries(PLAN_ORDER.map((p) => [p, 0]))
    let mrrSek = 0
    let totalCostUsd = 0
    let overThreshold = 0
    for (const org of orgs) {
      perPlan[org.subscriptionPlan] = (perPlan[org.subscriptionPlan] ?? 0) + 1
      if (org.status === 'ACTIVE') mrrSek += Number(org.planMonthlyFee)
      const u = usageMap.get(org.id)
      if (!u) continue
      totalCostUsd += u.costUsd
      const limit = PLAN_LIMITS[org.subscriptionPlan as SubscriptionPlan].monthlyAiCalls
      const pct = limit > 0 ? (u.manualCalls / limit) * 100 : 0
      if (pct >= 80) overThreshold += 1
    }

    return {
      perPlan,
      mrrSek: Math.round(mrrSek * 100) / 100,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      totalCostSek: Math.round(totalCostUsd * USD_TO_SEK * 100) / 100,
      marginSek: Math.round((mrrSek - totalCostUsd * USD_TO_SEK) * 100) / 100,
      orgsOverEightyPct: overThreshold,
      totalActiveOrgs: orgs.filter((o) => o.status === 'ACTIVE').length,
      totalTrialOrgs: orgs.filter((o) => o.status === 'TRIAL').length,
    }
  }

  /**
   * Lägg till credits manuellt (efter att Yasin markerat fakturan betald).
   */
  async addCredits(organizationId: string, amount: number, note?: string) {
    if (amount <= 0) throw new BadRequestException('Antal credits måste vara > 0')
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } })
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { aiCreditsBalance: { increment: amount } },
      select: { id: true, name: true, aiCreditsBalance: true },
    })

    return {
      organizationId: updated.id,
      organizationName: updated.name,
      previousBalance: org.aiCreditsBalance,
      addedCredits: amount,
      newBalance: updated.aiCreditsBalance,
      note: note ?? null,
    }
  }

  /**
   * Byt plan manuellt (för specialfall eller uppgraderingar utan UI-väg).
   */
  async changePlan(organizationId: string, plan: SubscriptionPlan) {
    const limit = PLAN_LIMITS[plan]
    if (!limit) throw new BadRequestException('Okänd plan')

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        subscriptionPlan: plan,
        planStartedAt: new Date(),
        planMonthlyFee: limit.monthlyFee,
        status: plan === 'TRIAL' ? 'TRIAL' : 'ACTIVE',
      },
      select: { id: true, subscriptionPlan: true, planMonthlyFee: true, status: true },
    })
    return updated
  }
}
