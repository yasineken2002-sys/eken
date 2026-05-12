import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PLAN_LIMITS, USAGE_WARNING_THRESHOLDS, getMonthStart } from '@eken/shared'
import type { SubscriptionPlan } from '@eken/shared'

/**
 * Daglig påminnelse-cron som kollar varje organisations AI-användning
 * och trial-status. Kör en gång per dygn kl 09:00 lokal tid.
 *
 * Tre uppgifter:
 *   1. Varna kunder vid 80%, 95%, 100% av månadens manuella anrop
 *   2. Trial-mejl dag 14 ("Hur går det?"), dag 25 ("Trial löper ut snart"),
 *      dag 29 ("Trial löper ut imorgon")
 *   3. Trial-utgång: dag 31 → status SUSPENDED, dag 90 → varning om radering
 *
 * Idempotens: varje mejl idempotency-keyas på (orgId, dag, typ). Mailservicen
 * skickar inte samma key två gånger ens om cronen råkar köras dubbelt.
 */
@Injectable()
export class AiUsageNotifierService {
  private readonly logger = new Logger(AiUsageNotifierService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 9 * * *')
  async dailyCheck(): Promise<void> {
    this.logger.log('Kör daglig AI-användnings + trial-kontroll')
    try {
      await Promise.all([this.checkAiUsage(), this.checkTrialStatus()])
    } catch (err) {
      this.logger.error('dailyCheck misslyckades', err as Error)
    }
  }

  /**
   * Kontrollera AI-användning för alla aktiva organisationer.
   * Mejlar OWNER + ADMIN vid varje tröskel som passeras denna månad.
   */
  private async checkAiUsage(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: { in: ['TRIAL', 'ACTIVE'] } },
      select: {
        id: true,
        name: true,
        subscriptionPlan: true,
        aiCreditsBalance: true,
        users: {
          where: { isActive: true, role: { in: ['OWNER', 'ADMIN'] } },
          select: { id: true, email: true, firstName: true },
        },
      },
    })

    const monthKey = new Date().toISOString().slice(0, 7) // YYYY-MM
    const monthStart = getMonthStart()

    for (const org of orgs) {
      const plan = org.subscriptionPlan as SubscriptionPlan
      const limit = PLAN_LIMITS[plan]
      if (!limit) continue

      const used = await this.prisma.aiUsageLog.count({
        where: {
          organizationId: org.id,
          isAutomated: false,
          createdAt: { gte: monthStart },
        },
      })
      const percentage = limit.monthlyAiCalls > 0 ? (used / limit.monthlyAiCalls) * 100 : 0

      for (const threshold of USAGE_WARNING_THRESHOLDS) {
        if (percentage < threshold) continue

        const idempotencyKey = `ai-usage-warning-${org.id}-${monthKey}-${threshold}`

        // In-app notification till alla owners/admins
        for (const user of org.users) {
          await this.notifications.create(
            org.id,
            user.id,
            'SYSTEM',
            this.warningTitle(threshold),
            this.warningMessage(threshold, used, limit.monthlyAiCalls, org.aiCreditsBalance),
          )

          await this.mail
            .enqueue({
              template: 'custom',
              priority: 'high',
              to: user.email,
              subject: this.warningSubject(threshold),
              props: {
                preview: this.warningTitle(threshold),
                tenantName: user.firstName,
                organizationName: org.name,
                whyReceived:
                  'Du fick det här mejlet eftersom du är admin för organisationen i Eveno.',
                bodyHtml: this.warningBody(
                  user.firstName,
                  threshold,
                  used,
                  limit.monthlyAiCalls,
                  org.aiCreditsBalance,
                ),
              },
              idempotencyKey: `${idempotencyKey}-${user.id}`,
            })
            .catch((err: unknown) =>
              this.logger.warn(
                `AI-varning ${threshold}% misslyckades för ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
        }
      }
    }
  }

  /**
   * Trial-status-flöde: dag 14/25/29-mejl, dag 31 → SUSPENDED, dag 90 → varning.
   */
  private async checkTrialStatus(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({
      where: {
        status: { in: ['TRIAL', 'SUSPENDED'] },
        trialEndsAt: { not: null },
      },
      select: {
        id: true,
        name: true,
        status: true,
        trialEndsAt: true,
        planStartedAt: true,
        suspendedAt: true,
        users: {
          where: { isActive: true, role: { in: ['OWNER', 'ADMIN'] } },
          select: { id: true, email: true, firstName: true },
        },
      },
    })

    const now = new Date()
    const day = (date: Date) => Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000))

    for (const org of orgs) {
      if (org.status === 'TRIAL' && org.trialEndsAt) {
        const daysIn = day(org.planStartedAt)
        const daysLeft = Math.ceil(
          (org.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
        )

        if (daysIn === 14) await this.sendTrialMail(org, 'day14', daysLeft)
        if (daysIn === 25) await this.sendTrialMail(org, 'day25', daysLeft)
        if (daysIn === 29) await this.sendTrialMail(org, 'day29', daysLeft)

        // Trial utgången → SUSPENDED
        if (org.trialEndsAt < now) {
          await this.prisma.organization.update({
            where: { id: org.id },
            data: { status: 'SUSPENDED', suspendedAt: now },
          })
          this.logger.log(`Org ${org.id} (${org.name}) trial utgången — satt till SUSPENDED`)
        }
      }

      if (org.status === 'SUSPENDED' && org.suspendedAt) {
        const daysSuspended = day(org.suspendedAt)
        if (daysSuspended === 60) await this.sendTrialMail(org, 'pre-deletion-warning', 0)
        // Dag 120: slutgiltig radering hanteras av separat (medveten manuell)
        // process — vi vill inte radera kunddata utan bekräftelse.
      }
    }
  }

  private async sendTrialMail(
    org: { id: string; name: string; users: { email: string; firstName: string; id: string }[] },
    stage: 'day14' | 'day25' | 'day29' | 'pre-deletion-warning',
    daysLeft: number,
  ): Promise<void> {
    const subjects: Record<typeof stage, string> = {
      day14: 'Hur går det med Eveno? Tips att komma igång',
      day25: `Din Eveno-trial löper ut om ${daysLeft} dagar — välj plan`,
      day29: 'Din Eveno-trial löper ut imorgon!',
      'pre-deletion-warning': 'Ditt Eveno-konto raderas snart',
    }
    const bodies: Record<typeof stage, (firstName: string) => string> = {
      day14: (n) => `
        <h1>Hej ${n}!</h1>
        <p>Halva trialen har gått. Vi hoppas du redan börjat se nyttan av Eveno.</p>
        <p>Här är tre saker som ofta sparar våra kunder mest tid:</p>
        <ul>
          <li><strong>Automatiska hyresaviseringar</strong> — Eveno skickar och bokför själv.</li>
          <li><strong>Kontraktsskanning</strong> — Ladda upp en PDF, AI:n läser av allt.</li>
          <li><strong>Bankavstämning</strong> — Importera SIE eller CSV, vi matchar betalningarna.</li>
        </ul>
        <p>Behöver du hjälp? Svara på det här mejlet eller boka demo.</p>
      `,
      day25: (n) => `
        <h1>Hej ${n}!</h1>
        <p>Din trial löper ut om <strong>${daysLeft} dagar</strong>.</p>
        <p>För att fortsätta använda Eveno utan avbrott, välj en plan i Inställningar → Plan och AI-användning.</p>
        <p>Vi har fem planer från 390 kr/mån (exkl moms) — välj den som matchar ditt antal hyresobjekt.</p>
      `,
      day29: (n) => `
        <h1>Hej ${n}!</h1>
        <p>Din trial löper ut <strong>imorgon</strong>.</p>
        <p>Logga in och välj en plan så fortsätter allt fungera oavbrutet. Ditt data finns kvar i 60 dagar även om du väntar.</p>
      `,
      'pre-deletion-warning': (n) => `
        <h1>Hej ${n}!</h1>
        <p>Det har gått 60 dagar sedan din trial löpte ut. Vi vill påminna om att kontot och allt data raderas slutgiltigt om 30 dagar.</p>
        <p>Om du vill behålla kontot, logga in och välj en plan. Vi sparar gärna allt som om inget hänt.</p>
      `,
    }
    for (const user of org.users) {
      await this.mail
        .enqueue({
          template: 'custom',
          priority: 'high',
          to: user.email,
          subject: subjects[stage],
          props: {
            preview: subjects[stage],
            tenantName: user.firstName,
            organizationName: org.name,
            whyReceived: 'Du fick det här mejlet eftersom du är admin för organisationen i Eveno.',
            bodyHtml: bodies[stage](user.firstName),
          },
          idempotencyKey: `trial-${stage}-${org.id}-${user.id}`,
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Trial-mejl (${stage}) misslyckades för ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
    }
  }

  private warningTitle(threshold: number): string {
    if (threshold >= 100) return 'AI-frågorna är slut — köp credits eller uppgradera'
    if (threshold >= 95) return 'Du har nästan slut på AI-frågor'
    return 'Du har använt 80% av dina AI-frågor denna månad'
  }
  private warningSubject(threshold: number): string {
    return this.warningTitle(threshold)
  }
  private warningMessage(threshold: number, used: number, limit: number, credits: number): string {
    if (threshold >= 100) {
      return credits > 0
        ? `Tak nått (${used}/${limit}). Vi använder dina ${credits} extra credits — köp fler eller uppgradera för att slippa avbrott.`
        : `Tak nått (${used}/${limit}). AI-frågor är pausade. Köp extra credits eller uppgradera din plan i Inställningar.`
    }
    return `Du har använt ${used} av ${limit} manuella AI-anrop denna månad (${Math.round((used / limit) * 100)}%).`
  }
  private warningBody(
    firstName: string,
    threshold: number,
    used: number,
    limit: number,
    credits: number,
  ): string {
    return `
      <h1>Hej ${firstName}!</h1>
      <p>${this.warningMessage(threshold, used, limit, credits)}</p>
      <p>Inställningar → <strong>Plan och AI-användning</strong> för att köpa fler credits eller välja en större plan.</p>
      <p>Automatiska AI-aktiviteter (rapporter, OCR, hyresgäst-AI) är fortfarande aktiva och ingår alltid i basplanen — de räknas inte mot detta tak.</p>
    `
  }
}
