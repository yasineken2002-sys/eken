import { z } from 'zod'
import { ReadingReviewFilterSchema } from '@eken/shared'

export const REVIEW_PAGE_DEFAULT = 10
export const REVIEW_PAGE_MAX = 20

// Verktygsschemat är rådgivande; denna grind gäller även direkta anrop.
export const ConsumptionReviewToolSchema = z
  .object({
    reviewFilter: ReadingReviewFilterSchema.default('ALL'),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(REVIEW_PAGE_MAX).default(REVIEW_PAGE_DEFAULT),
    snapshot: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((input) => input.offset === 0 || input.snapshot !== undefined, {
    message: 'Nästa sida kräver snapshot från föregående svar.',
  })
