import { get, patch } from '@/lib/api'
import type { ReadingReviewFollowUpStatus, UpdateReadingReviewFollowUpInput } from '@eken/shared'

export function getReadingReviewFollowUp(): Promise<ReadingReviewFollowUpStatus> {
  return get<ReadingReviewFollowUpStatus>('/consumption/reading-review/follow-up')
}
export function updateReadingReviewFollowUp(
  dto: UpdateReadingReviewFollowUpInput,
): Promise<ReadingReviewFollowUpStatus> {
  return patch<ReadingReviewFollowUpStatus>('/consumption/reading-review/follow-up', dto)
}
