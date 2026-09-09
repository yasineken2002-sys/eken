import { NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { ReadingReviewFollowUpStatus } from '@eken/shared'

export const READING_REVIEW_FOLLOW_UP_STATUS_SELECT = {
  consumptionReviewFollowUpEnabled: true,
  consumptionReviewFollowUpEnabledAt: true,
  consumptionReviewFollowUpCheckedAt: true,
  consumptionReviewFollowUpErrorAt: true,
} satisfies Prisma.OrganizationSelect

export function presentReadingReviewFollowUp(
  row: Prisma.OrganizationGetPayload<{ select: typeof READING_REVIEW_FOLLOW_UP_STATUS_SELECT }>,
): ReadingReviewFollowUpStatus {
  return {
    enabled: row.consumptionReviewFollowUpEnabled,
    enabledAt: row.consumptionReviewFollowUpEnabledAt?.toISOString() ?? null,
    lastCheckedAt: row.consumptionReviewFollowUpCheckedAt?.toISOString() ?? null,
    lastFailedAt: row.consumptionReviewFollowUpErrorAt?.toISOString() ?? null,
  }
}

/** Samma smala, sessionsbundna läsning för HTTP och assistenten. Ingen historikanalys. */
export async function loadReadingReviewFollowUp(
  organizationId: string,
  db: Pick<Prisma.TransactionClient, 'organization'>,
): Promise<ReadingReviewFollowUpStatus> {
  const row = await db.organization.findUnique({
    where: { id: organizationId },
    select: READING_REVIEW_FOLLOW_UP_STATUS_SELECT,
  })
  if (!row) throw new NotFoundException('Organisationen finns inte.')
  return presentReadingReviewFollowUp(row)
}
