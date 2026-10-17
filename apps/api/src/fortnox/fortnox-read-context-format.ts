import { ConflictException } from '@nestjs/common'
import type { FortnoxReadContextPage, FortnoxReadContextSnapshot } from '@prisma/client'
import { z } from 'zod'
import {
  checkpointDigest,
  CheckpointContextSchema,
  CheckpointInputSchema,
} from './fortnox-read-checkpoint-context'

// Samma befintliga format för v1 och v2. Körnings-/leasebindning hör till
// respektive caller; ingen ny hashversion eller omordning införs här.
export const CONTEXT_PAGE_SIZE = 100
export const CONTEXT_KINDS = ['MAPPINGS', 'OWN_EXPORTS'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]
const count = z.number().int().nonnegative().safe()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const collection = z
  .object({ itemCount: count, pageCount: count, root: hash })
  .strict()
  .refine((v) => v.pageCount === Math.ceil(v.itemCount / CONTEXT_PAGE_SIZE))
export const ContextManifestSchema = z
  .object({
    version: z.literal(1),
    input: CheckpointInputSchema,
    sourceDigest: hash,
    connection: z
      .object({
        id: z.string(),
        generation: count,
        databaseNumber: z.number().int().positive().safe(),
        orgNumber: z.string().nullable(),
      })
      .strict(),
    collections: z.object({ MAPPINGS: collection, OWN_EXPORTS: collection }).strict(),
  })
  .strict()
export type ContextManifest = z.infer<typeof ContextManifestSchema>
export type ContextHeader = Omit<FortnoxReadContextSnapshot, 'manifest'> & {
  manifest: ContextManifest
}
type Context = z.infer<typeof CheckpointContextSchema>
export type ContextItems = Context['mappings'] | Context['ownExports']

export function contextBindingDigest(
  header: Pick<ContextHeader, 'id' | 'organizationId' | 'runId' | 'manifest'>,
) {
  const { version, input, sourceDigest, connection } = header.manifest
  return checkpointDigest({
    snapshotId: header.id,
    organizationId: header.organizationId,
    runId: header.runId,
    version,
    input,
    sourceDigest,
    connection,
  })
}

export function contextInitialRoot(binding: string, kind: ContextKind) {
  return checkpointDigest({ version: 1, binding, kind })
}

export function contextExtendRoot(
  previousRoot: string,
  page: number,
  itemCount: number,
  digest: string,
) {
  return checkpointDigest({ previousRoot, page, itemCount, digest })
}

export function contextPageDigest(
  binding: string,
  kind: ContextKind,
  page: number,
  items: ContextItems,
) {
  return checkpointDigest({ version: 1, binding, kind, page, itemCount: items.length, items })
}

export function contextHeaderDigest(
  header: Pick<ContextHeader, 'id' | 'organizationId' | 'runId' | 'manifest'>,
) {
  return checkpointDigest({
    id: header.id,
    organizationId: header.organizationId,
    runId: header.runId,
    manifest: header.manifest,
  })
}

const invalid = () =>
  new ConflictException('Det frysta läsunderlaget är ofullständigt eller ogiltigt')

export function checkedContextHeader(row: FortnoxReadContextSnapshot): ContextHeader {
  const parsed = ContextManifestSchema.safeParse(row.manifest)
  if (!parsed.success || !row.sealedAt) throw invalid()
  const header = { ...row, manifest: parsed.data }
  if (row.digest !== contextHeaderDigest(header)) throw invalid()
  return header
}

export function checkedContextPage(
  row: FortnoxReadContextPage | null,
  header: ContextHeader,
  kind: ContextKind,
  page: number,
): { items: ContextItems; digest: string } {
  const schema =
    kind === 'MAPPINGS'
      ? CheckpointContextSchema.shape.mappings
      : CheckpointContextSchema.shape.ownExports
  const parsed = schema.safeParse(row?.items)
  const expected = Math.min(
    CONTEXT_PAGE_SIZE,
    header.manifest.collections[kind].itemCount - (page - 1) * CONTEXT_PAGE_SIZE,
  )
  if (
    !row ||
    !parsed.success ||
    expected < 1 ||
    row.itemCount !== expected ||
    parsed.data.length !== expected ||
    row.organizationId !== header.organizationId ||
    row.snapshotId !== header.id ||
    row.kind !== kind ||
    row.page !== page ||
    row.digest !== contextPageDigest(contextBindingDigest(header), kind, page, parsed.data)
  )
    throw invalid()
  return { items: parsed.data, digest: row.digest }
}
