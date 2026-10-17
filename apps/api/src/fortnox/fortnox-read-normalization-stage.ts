import { BadRequestException, ConflictException } from '@nestjs/common'
import type { FortnoxReadRun, Prisma } from '@prisma/client'
import { z } from 'zod'
import { CheckpointContextSchema, checkpointDigest } from './fortnox-read-checkpoint-context'
import { kallkonton } from './fortnox-read-provenance'
import {
  type readCheckpointSourceHeader,
  readCheckpointSourceMappingPage,
  readCheckpointSourceExportPage,
} from './fortnox-read-source-capture'

type Tx = Prisma.TransactionClient
type SourceHeader = Awaited<ReturnType<typeof readCheckpointSourceHeader>>
type MappingItem = z.infer<typeof CheckpointContextSchema.shape.mappings.element>
type ExportItem = z.infer<typeof CheckpointContextSchema.shape.ownExports.element>
type Kind = 'MAPPINGS' | 'OWN_EXPORTS'
type NormalizedItems =
  | { kind: 'MAPPINGS'; items: MappingItem[] }
  | { kind: 'OWN_EXPORTS'; items: ExportItem[] }

export type NormalizationPosition = {
  expectedKind: Kind
  expectedAfterOrdinal: bigint
}
export type NormalizedPagePosition = { kind: Kind; afterOrdinal: bigint }
export type NormalizationProgress = {
  stageId: string
  status: 'NORMALIZING' | 'NORMALIZED'
  mappingCount: number
  exportCount: number
  mappingsDone: number
  exportsDone: number
  next: NormalizationPosition | null
}
export type NormalizationPageReceipt = {
  stageId: string
  pageId: string
  kind: Kind
  afterOrdinal: bigint
  itemCount: number
  digest: string
}
export type NormalizationPage = NormalizationPageReceipt & NormalizedItems
export type NormalizePageResult =
  | { kind: 'SAVED'; receipt: NormalizationPageReceipt }
  | { kind: 'INVALID_SOURCE' }

const PAGE_SIZE = 100
const MAX_COUNT = 2_147_483_647
const count = z.number().int().min(0).max(MAX_COUNT)
const identity = z.string().min(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const kind = z.enum(['MAPPINGS', 'OWN_EXPORTS'])
const after = z
  .bigint()
  .min(0n)
  .max(BigInt(MAX_COUNT))
  .refine((value) => value % BigInt(PAGE_SIZE) === 0n)
const positionSchema = z.object({ expectedKind: kind, expectedAfterOrdinal: after }).strict()
const readPositionSchema = z.object({ kind, afterOrdinal: after }).strict()
const stageSchema = z
  .object({
    id: identity,
    organizationId: identity,
    runId: identity,
    sourceCaptureId: identity,
    formatVersion: z.literal(1),
    requestHash: hash,
    mappingCount: count,
    exportCount: count,
    mappingsDone: count,
    exportsDone: count,
    status: z.enum(['NORMALIZING', 'NORMALIZED']),
    normalizedAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict()
const pageSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: identity,
    stageId: identity,
    kind,
    afterOrdinal: after,
    itemCount: z.number().int().min(1).max(PAGE_SIZE),
    digest: hash,
    items: z.unknown(),
  })
  .strict()
type Stage = z.infer<typeof stageSchema>
const invalid = () =>
  new ConflictException('Normaliseringsunderlaget är ofullständigt eller ogiltigt')
const wrongPosition = () => new ConflictException('Normaliseringspositionen är inte aktuell')

export function parseNormalizationPosition(input: unknown): NormalizationPosition {
  const parsed = positionSchema.safeParse(input)
  if (!parsed.success) throw new BadRequestException('Ogiltig normaliseringsposition')
  return parsed.data
}

export function parseNormalizedPagePosition(input: unknown): NormalizedPagePosition {
  const parsed = readPositionSchema.safeParse(input)
  if (!parsed.success) throw new BadRequestException('Ogiltig normaliseringsposition')
  return parsed.data
}

function checkedStage(value: unknown, run: FortnoxReadRun, source: SourceHeader): Stage {
  const parsed = stageSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  const row = parsed.data
  const complete = row.mappingsDone === row.mappingCount && row.exportsDone === row.exportCount
  if (
    row.id !== run.id ||
    row.runId !== run.id ||
    row.sourceCaptureId !== run.sourceCaptureId ||
    row.sourceCaptureId !== source.id ||
    row.organizationId !== run.organizationId ||
    row.organizationId !== source.organizationId ||
    row.requestHash !== run.requestHash ||
    row.requestHash !== source.requestHash ||
    row.mappingCount !== source.mappingCount ||
    row.exportCount !== source.exportCount ||
    row.mappingsDone > row.mappingCount ||
    row.exportsDone > row.exportCount ||
    (row.exportsDone > 0 && row.mappingsDone !== row.mappingCount) ||
    (row.mappingsDone < row.mappingCount && row.mappingsDone % PAGE_SIZE !== 0) ||
    (row.exportsDone < row.exportCount && row.exportsDone % PAGE_SIZE !== 0) ||
    (row.status === 'NORMALIZED') !== complete ||
    (row.normalizedAt !== null) !== complete
  )
    throw invalid()
  return row
}

function progress(stage: Stage): NormalizationProgress {
  const next: NormalizationPosition | null =
    stage.mappingsDone < stage.mappingCount
      ? { expectedKind: 'MAPPINGS', expectedAfterOrdinal: BigInt(stage.mappingsDone) }
      : stage.exportsDone < stage.exportCount
        ? { expectedKind: 'OWN_EXPORTS', expectedAfterOrdinal: BigInt(stage.exportsDone) }
        : null
  return {
    stageId: stage.id,
    status: stage.status,
    mappingCount: stage.mappingCount,
    exportCount: stage.exportCount,
    mappingsDone: stage.mappingsDone,
    exportsDone: stage.exportsDone,
    next,
  }
}

async function lockStage(tx: Tx, run: FortnoxReadRun): Promise<void> {
  // Anroparen håller redan connection→run. Ingen omvänd låsordning här.
  await tx.$queryRaw`SELECT "id" FROM "FortnoxReadNormalizationStage"
    WHERE "id" = ${run.id} AND "organizationId" = ${run.organizationId} FOR UPDATE`
}

async function readStage(tx: Tx, run: FortnoxReadRun, source: SourceHeader): Promise<Stage> {
  const row = await tx.fortnoxReadNormalizationStage.findUnique({
    where: { id: run.id, organizationId: run.organizationId },
  })
  return checkedStage(row, run, source)
}

/** Endast från SourceRunService.withLease, efter aktuell fence och binding. */
export async function prepareNormalizationStage(
  tx: Tx,
  run: FortnoxReadRun,
  source: SourceHeader,
  now: Date,
): Promise<NormalizationProgress> {
  await lockStage(tx, run)
  const existing = await tx.fortnoxReadNormalizationStage.findUnique({
    where: { id: run.id, organizationId: run.organizationId },
  })
  if (existing) return progress(checkedStage(existing, run, source))
  const empty = source.mappingCount === 0 && source.exportCount === 0
  await tx.fortnoxReadNormalizationStage.create({
    data: {
      id: run.id,
      organizationId: run.organizationId,
      runId: run.id,
      sourceCaptureId: source.id,
      requestHash: source.requestHash,
      mappingCount: source.mappingCount,
      exportCount: source.exportCount,
      status: empty ? 'NORMALIZED' : 'NORMALIZING',
      normalizedAt: empty ? now : null,
    },
    select: { id: true },
  })
  // Triggerns DB-tid och faktiska sparade metadata är sanningskällan.
  return progress(await readStage(tx, run, source))
}

function receipt(page: NormalizationPage): NormalizationPageReceipt {
  return {
    stageId: page.stageId,
    pageId: page.pageId,
    kind: page.kind,
    afterOrdinal: page.afterOrdinal,
    itemCount: page.itemCount,
    digest: page.digest,
  }
}

function pageDigest(
  stage: Stage,
  position: NormalizedPagePosition,
  items: NormalizedItems['items'],
): string {
  return checkpointDigest({
    version: 1,
    organizationId: stage.organizationId,
    runId: stage.runId,
    sourceCaptureId: stage.sourceCaptureId,
    stageId: stage.id,
    requestHash: stage.requestHash,
    kind: position.kind,
    afterOrdinal: position.afterOrdinal.toString(),
    itemCount: items.length,
    items,
  })
}

function checkedPage(
  value: unknown,
  stage: Stage,
  position: NormalizedPagePosition,
): NormalizationPage {
  const parsed = pageSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  const row = parsed.data
  const total = position.kind === 'MAPPINGS' ? stage.mappingCount : stage.exportCount
  const done = position.kind === 'MAPPINGS' ? stage.mappingsDone : stage.exportsDone
  if (
    row.organizationId !== stage.organizationId ||
    row.stageId !== stage.id ||
    row.kind !== position.kind ||
    row.afterOrdinal !== position.afterOrdinal ||
    row.afterOrdinal >= BigInt(total) ||
    row.afterOrdinal + BigInt(row.itemCount) > BigInt(done) ||
    BigInt(row.itemCount) !==
      (BigInt(total) - row.afterOrdinal < BigInt(PAGE_SIZE)
        ? BigInt(total) - row.afterOrdinal
        : BigInt(PAGE_SIZE))
  )
    throw invalid()
  const metadata: NormalizationPageReceipt = {
    stageId: row.stageId,
    pageId: row.id,
    kind: row.kind,
    afterOrdinal: row.afterOrdinal,
    itemCount: row.itemCount,
    digest: row.digest,
  }
  if (row.kind === 'MAPPINGS') {
    const items = CheckpointContextSchema.shape.mappings.max(PAGE_SIZE).safeParse(row.items)
    if (
      !items.success ||
      items.data.length !== row.itemCount ||
      pageDigest(stage, position, items.data) !== row.digest
    )
      throw invalid()
    return { ...metadata, kind: 'MAPPINGS', items: items.data }
  }
  const items = CheckpointContextSchema.shape.ownExports.max(PAGE_SIZE).safeParse(row.items)
  if (
    !items.success ||
    items.data.length !== row.itemCount ||
    pageDigest(stage, position, items.data) !== row.digest
  )
    throw invalid()
  return { ...metadata, kind: 'OWN_EXPORTS', items: items.data }
}

async function findPage(tx: Tx, stage: Stage, position: NormalizedPagePosition) {
  return tx.fortnoxReadNormalizationPage.findUnique({
    where: {
      stageId_kind_afterOrdinal: {
        stageId: stage.id,
        kind: position.kind,
        afterOrdinal: position.afterOrdinal,
      },
      organizationId: stage.organizationId,
    },
  })
}

/** Råkällans metadata-/DB-fel ligger utanför den snäva normalformsklassningen. */
async function normalizeSourcePage(
  tx: Tx,
  stage: Stage,
  position: NormalizedPagePosition,
): Promise<NormalizedItems | null> {
  if (position.kind === 'MAPPINGS') {
    const raw = await readCheckpointSourceMappingPage(
      tx,
      stage.organizationId,
      stage.sourceCaptureId,
      position.afterOrdinal,
    )
    const items: MappingItem[] = []
    for (const row of raw.items) {
      const parsed = CheckpointContextSchema.shape.mappings.element.safeParse({
        type: row.dimensionType,
        code: row.code,
        propertyId: row.propertyId,
        propertyName: row.propertyName,
      })
      if (!parsed.success) return null
      items.push(parsed.data)
    }
    return { kind: 'MAPPINGS', items }
  }
  const raw = await readCheckpointSourceExportPage(
    tx,
    stage.organizationId,
    stage.sourceCaptureId,
    position.afterOrdinal,
  )
  const items: ExportItem[] = []
  for (const row of raw.items) {
    let accounts: ReturnType<typeof kallkonton>
    try {
      accounts = kallkonton(row.accountSource)
    } catch (error) {
      // Nullrad/icke-itererbara lines är permanent ogiltig fryst rådata.
      // Inga databas-, metadata-, fence- eller andra programfel fångas här.
      if (error instanceof TypeError) return null
      throw error
    }
    const parsed = CheckpointContextSchema.shape.ownExports.element.safeParse({
      voucher: `${row.externalYear}|${row.externalSeries}|${row.externalNumber}`,
      journalEntryId: row.journalEntryId,
      revision: accounts.revision,
      perMal: [...accounts.perMal].map(([account, sources]) => ({ account, sources })),
    })
    if (!parsed.success) return null
    items.push(parsed.data)
  }
  return { kind: 'OWN_EXPORTS', items }
}

/** Servern härleder både källsida och normalform; caller lämnar bara avsedd position. */
export async function normalizeCheckpointPage(
  tx: Tx,
  run: FortnoxReadRun,
  source: SourceHeader,
  expected: NormalizationPosition,
): Promise<NormalizePageResult> {
  await lockStage(tx, run)
  const stage = await readStage(tx, run, source)
  const position = { kind: expected.expectedKind, afterOrdinal: expected.expectedAfterOrdinal }
  const previous = await findPage(tx, stage, position)
  if (previous) {
    const saved = checkedPage(previous, stage, position)
    const normalized = await normalizeSourcePage(tx, stage, position)
    // En tidigare godkänd sida måste fortfarande motsvara exakt sin frysta källa.
    // Avvikelse här är korrupt lagring, inte en ny INVALID_SOURCE-terminalisering.
    if (!normalized || pageDigest(stage, position, normalized.items) !== saved.digest)
      throw invalid()
    return { kind: 'SAVED', receipt: receipt(saved) }
  }
  const next = progress(stage).next
  if (
    !next ||
    next.expectedKind !== expected.expectedKind ||
    next.expectedAfterOrdinal !== expected.expectedAfterOrdinal
  )
    throw wrongPosition()

  const normalized = await normalizeSourcePage(tx, stage, position)
  if (!normalized) return { kind: 'INVALID_SOURCE' }
  const digest = pageDigest(stage, position, normalized.items)
  const saved = await tx.fortnoxReadNormalizationPage.create({
    data: {
      organizationId: stage.organizationId,
      stageId: stage.id,
      kind: position.kind,
      afterOrdinal: position.afterOrdinal,
      itemCount: normalized.items.length,
      digest,
      items: normalized.items,
    },
  })
  // AFTER INSERT gör framsteget i samma SQL-operation. Vi skriver aldrig cursor.
  const updated = await readStage(tx, run, source)
  if (
    updated.mappingsDone !==
      stage.mappingsDone + (position.kind === 'MAPPINGS' ? normalized.items.length : 0) ||
    updated.exportsDone !==
      stage.exportsDone + (position.kind === 'OWN_EXPORTS' ? normalized.items.length : 0)
  )
    throw invalid()
  return { kind: 'SAVED', receipt: receipt(checkedPage(saved, updated, position)) }
}

/** Exakt en sparad sida, strikt validerad; inget full-array- eller sourceDigest-löfte. */
export async function readNormalizationStagePage(
  tx: Tx,
  run: FortnoxReadRun,
  source: SourceHeader,
  position: NormalizedPagePosition,
): Promise<NormalizationPage> {
  await lockStage(tx, run)
  const stage = await readStage(tx, run, source)
  return checkedPage(await findPage(tx, stage, position), stage, position)
}
