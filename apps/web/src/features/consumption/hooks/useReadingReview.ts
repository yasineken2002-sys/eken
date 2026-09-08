import { useQuery } from '@tanstack/react-query'
import type { ReadingReviewSnapshot } from '@eken/shared'
import { get } from '@/lib/api'

export function useReadingReview() {
  return useQuery({
    // Invalideras av befintlig registrering: ['readings']. Skild från listans filter.
    queryKey: ['readings', 'review'],
    queryFn: () => get<ReadingReviewSnapshot>('/consumption/reading-review'),
  })
}
