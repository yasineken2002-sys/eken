import { z } from 'zod'
import { isDate, stable } from './fortnox-ledger-validation'
import { createHash } from 'node:crypto'

const day = z.string().refine(isDate)
const count = z.number().int().nonnegative().safe()
const account = z.number().int().min(1000).max(9999)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().regex(/^\d+\|[A-Za-z0-9]{1,10}\|\d+$/)
export const CheckpointInputSchema = z
  .object({
    financialYearId: z.number().int().positive().safe(),
    periodFrom: day,
    periodTo: day,
    costAccounts: z.array(account).min(1).max(200),
    financialYearStart: day.optional(),
    financialYearEnd: day.optional(),
  })
  .strict()
  .refine((v) => v.periodFrom <= v.periodTo)
export type StartCheckpointInput = z.infer<typeof CheckpointInputSchema>

const CoverageSchema = z
  .object({
    pages: count,
    totalPages: count,
    totalResources: count,
    itemsSeen: count,
  })
  .strict()
export const CheckpointCatalogSchema = z
  .object({
    version: z.literal(1),
    companyDatabaseNumber: z.number().int().positive().safe(),
    financialYear: z
      .object({
        id: z.number().int().positive().safe(),
        fromDate: day,
        toDate: day,
        accountingMethod: z.string().nullable(),
      })
      .strict(),
    accounts: z
      .array(
        z
          .object({
            number: account,
            active: z.boolean().nullable(),
            balanceBroughtForwardOre: z.number().int().safe().nullable(),
          })
          .strict(),
      )
      .max(200),
    dimensions: z.array(
      z
        .object({
          type: z.enum(['COST_CENTER', 'PROJECT']),
          code: z.string().min(1),
        })
        .strict(),
    ),
    coverage: z
      .object({
        costCenters: CoverageSchema,
        projects: CoverageSchema.optional(),
      })
      .strict(),
  })
  .strict()
export type CheckpointCatalog = z.infer<typeof CheckpointCatalogSchema>

export const CheckpointContextSchema = z
  .object({
    version: z.literal(1),
    input: CheckpointInputSchema,
    mappings: z.array(
      z
        .object({
          type: z.enum(['COST_CENTER', 'PROJECT']),
          code: z.string(),
          propertyId: z.string(),
          propertyName: z.string(),
        })
        .strict(),
    ),
    ownExports: z.array(
      z
        .object({
          voucher: key,
          journalEntryId: z.string(),
          revision: z.number().int().safe().nullable(),
          perMal: z.array(
            z
              .object({
                account,
                sources: z.array(account),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()

export const ManifestEntriesSchema = z.array(z.object({ key, digest: hash }).strict()).max(100)
export const CheckpointReadPageSchema = z
  .object({
    afterKey: key.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
export const NormalizedVoucherSchema = z
  .object({
    key,
    date: day,
    headerDimensionPresent: z.boolean(),
    reference: z
      .object({ type: z.string().nullable(), number: z.string().nullable() })
      .strict()
      .nullable(),
    rows: z
      .array(
        z
          .object({
            index1: z.number().int().positive().safe(),
            account,
            debitOre: count,
            creditOre: count,
            costCenter: z.string().nullable(),
            project: z.string().nullable(),
            removed: z.boolean(),
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .refine((v) => v.rows.every((r, index) => r.index1 === index + 1))

export function checkpointDigest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

export function canonicalCheckpointInput(input: unknown): StartCheckpointInput {
  const parsed = CheckpointInputSchema.parse(input)
  return { ...parsed, costAccounts: [...new Set(parsed.costAccounts)].sort((a, b) => a - b) }
}
