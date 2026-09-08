import { post } from '@/lib/api'
import type { ReadingReviewDecision, SaveReadingReviewInput } from '@eken/shared'
export function saveReadingReview(dto: SaveReadingReviewInput): Promise<ReadingReviewDecision> {
  return post<ReadingReviewDecision>('/consumption/reading-review/decisions', dto)
}
