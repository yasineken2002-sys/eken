import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  readingReviewFollowUpState,
  readingReviewFollowUpTime,
  nextReadingReviewFollowUp,
  READING_REVIEW_FOLLOW_UP_SCHEDULE,
  READING_REVIEW_FOLLOW_UP_MAX_AGE_HOURS,
  READING_REVIEW_FOLLOW_UP_STATE_LABELS,
} from '@eken/shared'
import { loadReadingReviewFollowUp } from '../../consumption/reading-review-follow-up.query'

export const ConsumptionFollowUpToolSchema = z.object({}).strict()

export async function getConsumptionFollowUp(
  db: Pick<Prisma.TransactionClient, 'organization'>,
  organizationId: string,
  role: string,
  input: Record<string, unknown>,
) {
  if (!['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'].includes(role))
    throw new ForbiddenException('Din roll får inte läsa förbrukningsuppföljningen.')
  if (!ConsumptionFollowUpToolSchema.safeParse(input).success)
    throw new BadRequestException('Statusläsningen tar inga parametrar.')

  const status = await loadReadingReviewFollowUp(organizationId, db)
  const observedAt = new Date()
  const state = readingReviewFollowUpState(status, observedAt.getTime())
  const nextPlannedAt = status.enabled ? nextReadingReviewFollowUp(observedAt).toISOString() : null
  const localTime = (value: string | null) => (value ? readingReviewFollowUpTime(value) : null)
  return {
    success: true,
    message: READING_REVIEW_FOLLOW_UP_STATE_LABELS[state],
    data: {
      status,
      state,
      observedAt: observedAt.toISOString(),
      schedule: { ...READING_REVIEW_FOLLOW_UP_SCHEDULE, editable: false },
      manualRunAvailableForAnyRole: false,
      nextPlannedAt,
      overdueAfterHours: READING_REVIEW_FOLLOW_UP_MAX_AGE_HOURS,
      display: {
        observedAt: localTime(observedAt.toISOString()),
        lastEnabledAt: localTime(status.enabledAt),
        lastSuccessfulCheckAt: localTime(status.lastCheckedAt),
        lastFailedCheckAt: localTime(status.lastFailedAt),
        nextPlannedCheckAt: localTime(nextPlannedAt),
      },
      humanPath: {
        route: '/consumption?tab=review',
        tab: 'Granskning',
        canChangeSetting: role === 'OWNER',
        canAssistantChangeSetting: false,
        canRunNow: false,
        canChangeSchedule: false,
        settingRole: { role: 'OWNER', label: 'Ägare' },
      },
      limitations: {
        provesReadingCorrectness: false,
        approvesBilling: false,
        provesNotificationDelivery: false,
        includesCurrentReviewQueue: false,
        includesFailureCause: false,
        includesHistoricalFindingCount: false,
        includesDisabledAt: false,
        includesRunningState: false,
        collectsNewReadings: false,
      },
    },
  }
}
