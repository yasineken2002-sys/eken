import { z } from 'zod'

/** JournalEntrySource utan Prisma i webben; kontraktsprovet binder hela mängden. */
export const JOURNAL_SOURCES = [
  'MANUAL',
  'AI',
  'INVOICE',
  'PAYMENT',
  'LEASE',
  'RENT_NOTICE',
  'MISC_CHARGE',
  'SUPPLIER_INVOICE',
] as const

const queryInteger = (value: unknown): unknown =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.exec(value)?.[0] === value ? Number(value) : value

const civilDate = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    'Ogiltigt datum',
  )

/**
 * GET /accounting/journal-page. Datum är inkluderande verifikationsdatum, inte
 * tidsstämplar. Saknade fält förblir saknade; controllern väljer sidan 0/100.
 */
export const journalPageQuerySchema = z
  .object({
    offset: z.preprocess(queryInteger, z.number().int().min(0).max(2147483647)).optional(),
    limit: z.preprocess(queryInteger, z.number().int().min(1).max(200)).optional(),
    from: civilDate.optional(),
    to: civilDate.optional(),
    source: z.enum(JOURNAL_SOURCES).optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Från-datum får inte vara efter till-datum',
    path: ['to'],
  })
export type JournalPageQuery = z.infer<typeof journalPageQuerySchema>
