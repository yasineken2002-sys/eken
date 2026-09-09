import { createHash } from 'node:crypto'
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { Prisma } from '@prisma/client'
import { readingReviewQueue, READING_REVIEW_FOLLOW_UP_SCHEDULE } from '@eken/shared'
import type { ReadingReviewFollowUpStatus, UpdateReadingReviewFollowUpInput } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { forEachOrgSafely, runCronSafely } from '../common/cron/cron-safety'
import { loadReadingReview } from './reading-review.query'
import {
  loadReadingReviewFollowUp,
  presentReadingReviewFollowUp as present,
  READING_REVIEW_FOLLOW_UP_STATUS_SELECT,
} from './reading-review-follow-up.query'

const CRON_NAME = 'consumption-review-follow-up'
const STATUS_SELECT = {
  ...READING_REVIEW_FOLLOW_UP_STATUS_SELECT,
  consumptionReviewFollowUpRevision: true,
} satisfies Prisma.OrganizationSelect

type State = Prisma.OrganizationGetPayload<{ select: typeof STATUS_SELECT }>

export function followUpNotificationId(
  orgId: string,
  userId: string,
  at: Date,
  kind: 'queue' | 'error',
) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(at)
  return (
    'reading-review-' +
    createHash('sha256')
      .update(JSON.stringify([orgId, userId, day, kind]))
      .digest('hex')
  )
}

@Injectable()
export class ReadingReviewFollowUpService {
  private readonly logger = new Logger(ReadingReviewFollowUpService.name)
  constructor(
    private readonly prisma: PrismaService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  async getStatus(organizationId: string): Promise<ReadingReviewFollowUpStatus> {
    return loadReadingReviewFollowUp(organizationId, this.prisma)
  }

  async update(organizationId: string, userId: string, dto: UpdateReadingReviewFollowUpInput) {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockState(tx, organizationId)
      const actor = await tx.user.findFirst({
        where: { id: userId, organizationId, isActive: true, role: 'OWNER' },
        select: { id: true },
      })
      if (!actor)
        throw new ForbiddenException(
          'Endast organisationens ägare får ändra automatisk uppföljning.',
        )
      // Återförsök på samma PATCH får inte återställa kontrollhistoriken.
      if (row.consumptionReviewFollowUpEnabled === dto.enabled) return present(row)
      return present(
        await tx.organization.update({
          where: { id: organizationId },
          data: {
            consumptionReviewFollowUpEnabled: dto.enabled,
            consumptionReviewFollowUpRevision: { increment: 1 },
            ...(dto.enabled
              ? {
                  consumptionReviewFollowUpEnabledAt: new Date(),
                  consumptionReviewFollowUpCheckedAt: null,
                  consumptionReviewFollowUpErrorAt: null,
                }
              : {}),
          },
          select: STATUS_SELECT,
        }),
      )
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  @Cron(
    `${READING_REVIEW_FOLLOW_UP_SCHEDULE.minute} ${READING_REVIEW_FOLLOW_UP_SCHEDULE.hour} * * *`,
    { timeZone: READING_REVIEW_FOLLOW_UP_SCHEDULE.timeZone, name: CRON_NAME },
  )
  async followUpDaily() {
    // KLASSIFICERING: B — Notification.id är @id över hash(org, user, Stockholmsdag, typ).
    // createMany(skipDuplicates) och status skrivs i samma transaktion. Inga externa anrop.
    await runCronSafely(
      CRON_NAME,
      async () => {
        const organizations = await this.prisma.organization.findMany({
          where: { consumptionReviewFollowUpEnabled: true },
          select: { id: true },
        })
        await forEachOrgSafely(
          CRON_NAME,
          organizations,
          async (org) => {
            await this.checkOrganization(org.id)
          },
          {
            logger: this.logger,
            sink: this.cronErrors,
            orgIdOf: (org) => org.id,
          },
        )
      },
      { logger: this.logger, sink: this.cronErrors },
    )
  }

  async checkOrganization(organizationId: string): Promise<void> {
    const startedAt = new Date()
    const state = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: STATUS_SELECT,
    })
    if (!state?.consumptionReviewFollowUpEnabled) return
    const revision = state.consumptionReviewFollowUpRevision
    try {
      // Läs hela underlaget FÖRE köfiltret. Inget LLM-anrop och ingen domänskrivning.
      const report = await loadReadingReview(organizationId, this.prisma)
      const count = readingReviewQueue(report.findings, 'TO_ASSESS').counts.TO_ASSESS
      await this.record(organizationId, revision, startedAt, { kind: 'queue', count })
    } catch (error) {
      try {
        await this.record(organizationId, revision, startedAt, { kind: 'error' })
      } catch (noticeError) {
        // Om även DB-skrivningen faller finns ingen användarnotis. Sänkan och
        // den synligt försenade tidsstämpeln är då de kvarvarande signalerna.
        await this.cronErrors.report(CRON_NAME, noticeError, {
          organizationId,
          detail: { stage: 'failure-status' },
        })
      }
      throw error // forEachOrgSafely registrerar grundfelet och fortsätter med nästa org.
    }
  }

  private async lockState(tx: Prisma.TransactionClient, organizationId: string): Promise<State> {
    // Samma radlås i av/på och slutskrivningen. Analysen ligger UTANFÖR låset.
    // En genomförd avstängning kan därför aldrig följas av en gammal notis.
    const rows = await tx.$queryRaw<State[]>`
      SELECT "consumptionReviewFollowUpEnabled", "consumptionReviewFollowUpEnabledAt",
             "consumptionReviewFollowUpCheckedAt", "consumptionReviewFollowUpErrorAt",
             "consumptionReviewFollowUpRevision"
      FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`
    if (!rows[0]) throw new NotFoundException('Organisationen finns inte.')
    return rows[0]
  }

  private async record(
    organizationId: string,
    revision: number,
    startedAt: Date,
    result: { kind: 'queue'; count: number } | { kind: 'error' },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const state = await this.lockState(tx, organizationId)
      if (
        !state.consumptionReviewFollowUpEnabled ||
        state.consumptionReviewFollowUpRevision !== revision
      )
        return
      // Ett långsammare gammalt försök får inte skriva över ett nyare utfall.
      const latest = Math.max(
        state.consumptionReviewFollowUpCheckedAt?.getTime() ?? 0,
        state.consumptionReviewFollowUpErrorAt?.getTime() ?? 0,
      )
      if (latest > startedAt.getTime()) return
      const checkedAt = new Date()
      if (result.kind === 'error' || result.count > 0) {
        const recipients = await tx.user.findMany({
          where: { organizationId, isActive: true, role: { in: ['OWNER', 'ADMIN', 'MANAGER'] } },
          select: { id: true },
        })
        await tx.notification.createMany({
          skipDuplicates: true,
          data: recipients.map((user) => ({
            id: followUpNotificationId(organizationId, user.id, checkedAt, result.kind),
            organizationId,
            userId: user.id,
            type: 'SYSTEM',
            title:
              result.kind === 'error'
                ? 'Automatisk avläsningskontroll misslyckades'
                : 'Avläsningar behöver bedömas',
            message:
              result.kind === 'error'
                ? 'Granskningskön kunde inte kontrolleras. Öppna Granskning och försök läsa underlaget igen. Nästa automatiska försök görs kl. 07.15 svensk tid.'
                : `${result.count} ${result.count === 1 ? 'varning' : 'varningar'} behövde bedömas vid den automatiska kontrollen. Öppna Granskning för det aktuella underlaget. En bedömning innebär inte att en avvikelse är åtgärdad.`,
            link: '/consumption?tab=review',
          })),
        })
      }
      await tx.organization.update({
        where: { id: organizationId },
        data:
          result.kind === 'error'
            ? { consumptionReviewFollowUpErrorAt: checkedAt }
            : {
                consumptionReviewFollowUpCheckedAt: checkedAt,
                consumptionReviewFollowUpErrorAt: null,
              },
      })
    }, PRISMA_DEFAULT_TX_LIMITS)
  }
}
