import { ConflictException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma, type FortnoxReadRun } from '@prisma/client'
import { checkpointDigest } from './fortnox-read-checkpoint-context'
import { CheckpointContextDigest } from './fortnox-read-context-digest'
import {
  CONTEXT_KINDS,
  CONTEXT_PAGE_SIZE,
  ContextManifestSchema,
  checkedContextHeader,
  checkedContextPage,
  contextBindingDigest,
  contextInitialRoot,
  contextExtendRoot,
  contextPageDigest,
  contextHeaderDigest,
  type ContextHeader,
  type ContextKind,
  type ContextManifest,
} from './fortnox-read-context-format'
import type {
  NormalizationPage,
  readCompletedNormalizationStage,
} from './fortnox-read-normalization-stage'
import type { readCheckpointSourceHeader } from './fortnox-read-source-capture'

type Tx = Prisma.TransactionClient
type SourceHeader = Awaited<ReturnType<typeof readCheckpointSourceHeader>>
type CompletedStage = Awaited<ReturnType<typeof readCompletedNormalizationStage>>
export type NormalizedContextReceipt = {
  snapshotId: string
  runId: string
  sourceDigest: string
  headerDigest: string
  mappingCount: number
  exportCount: number
  mappingPageCount: number
  exportPageCount: number
}
export type NormalizedContextBinding = {
  organizationId: string
  runId: string
  sourceCaptureId: string
  stageId: string
  requestHash: string
  input: ContextManifest['input']
  connection: ContextManifest['connection']
  counts: Record<ContextKind, number>
}
type Descriptor = {
  sourcePageId: string
  contextPageId: string
  kind: ContextKind
  afterOrdinal: string
  page: number
  itemCount: number
  stageDigest: string
  contextDigest: string
}
export type NormalizedContextPlan = {
  id: string
  organizationId: string
  runId: string
  manifest: ContextManifest
  digest: string
  descriptors: Descriptor[]
}
export const invalidNormalizedContext = () =>
  new ConflictException('Det normaliserade läsunderlaget är ofullständigt eller ogiltigt')

/** Anropas endast efter SourceRunService:s run/source- och NORMALIZED-kontroll. */
export function normalizedContextBinding(
  run: FortnoxReadRun,
  source: SourceHeader,
  stage: CompletedStage,
): NormalizedContextBinding {
  if (
    run.workVersion !== 2 ||
    run.id !== source.id ||
    run.organizationId !== source.organizationId ||
    run.sourceCaptureId !== source.id ||
    stage.id !== run.id ||
    stage.runId !== run.id ||
    stage.organizationId !== run.organizationId ||
    stage.sourceCaptureId !== source.id ||
    stage.status !== 'NORMALIZED' ||
    stage.requestHash !== source.requestHash ||
    run.requestHash !== source.requestHash ||
    stage.mappingCount !== source.mappingCount ||
    stage.exportCount !== source.exportCount
  )
    throw invalidNormalizedContext()
  return {
    organizationId: run.organizationId,
    runId: run.id,
    sourceCaptureId: source.id,
    stageId: stage.id,
    requestHash: source.requestHash,
    input: source.input,
    connection: {
      id: source.connectionId,
      generation: source.connectionGeneration,
      databaseNumber: source.fortnoxDatabaseNumber,
      orgNumber: source.fortnoxOrgNumber,
    },
    counts: { MAPPINGS: stage.mappingCount, OWN_EXPORTS: stage.exportCount },
  }
}

export function assertSameNormalizedContextBinding(
  actual: NormalizedContextBinding,
  expected: NormalizedContextBinding,
): void {
  if (checkpointDigest(actual) !== checkpointDigest(expected)) throw invalidNormalizedContext()
}

function checkHeaderBinding(header: ContextHeader, binding: NormalizedContextBinding): void {
  if (
    header.organizationId !== binding.organizationId ||
    header.runId !== binding.runId ||
    checkpointDigest(header.manifest.input) !== checkpointDigest(binding.input) ||
    checkpointDigest(header.manifest.connection) !== checkpointDigest(binding.connection) ||
    header.manifest.collections.MAPPINGS.itemCount !== binding.counts.MAPPINGS ||
    header.manifest.collections.OWN_EXPORTS.itemCount !== binding.counts.OWN_EXPORTS
  )
    throw invalidNormalizedContext()
}

export async function findNormalizedContextHeader(
  tx: Tx,
  binding: NormalizedContextBinding,
): Promise<ContextHeader | null> {
  const row = await tx.fortnoxReadContextSnapshot.findUnique({
    where: { runId: binding.runId, organizationId: binding.organizationId },
  })
  if (!row) return null
  const header = checkedContextHeader(row)
  checkHeaderBinding(header, binding)
  return header
}

export function assertNormalizedContextHeader(
  header: ContextHeader | null,
  expected: Pick<ContextHeader, 'id' | 'digest'>,
  sourceDigest: string,
): asserts header is ContextHeader {
  if (
    !header ||
    header.id !== expected.id ||
    header.digest !== expected.digest ||
    header.manifest.sourceDigest !== sourceDigest
  )
    throw invalidNormalizedContext()
}

/**
 * Endast serverns lokala andra pass. Payloaden släpps per sida; planen behåller
 * metadata per sida. Stage-hashar och ContextPage-hashar är olika format.
 */
export class NormalizedContextPlanBuilder {
  private readonly header: Omit<NormalizedContextPlan, 'digest'>
  private readonly bindingDigest: string
  private readonly stream: CheckpointContextDigest
  private readonly seen: Record<ContextKind, number> = { MAPPINGS: 0, OWN_EXPORTS: 0 }
  private readonly sourceIds = new Set<string>()
  private phase: ContextKind = 'MAPPINGS'
  private closed = false

  constructor(
    private readonly binding: NormalizedContextBinding,
    sourceDigest: string,
  ) {
    this.stream = new CheckpointContextDigest(binding.input)
    const manifest: ContextManifest = {
      version: 1,
      input: binding.input,
      connection: binding.connection,
      sourceDigest,
      collections: {
        MAPPINGS: {
          itemCount: binding.counts.MAPPINGS,
          pageCount: Math.ceil(binding.counts.MAPPINGS / CONTEXT_PAGE_SIZE),
          root: '0'.repeat(64),
        },
        OWN_EXPORTS: {
          itemCount: binding.counts.OWN_EXPORTS,
          pageCount: Math.ceil(binding.counts.OWN_EXPORTS / CONTEXT_PAGE_SIZE),
          root: '0'.repeat(64),
        },
      },
    }
    ContextManifestSchema.parse(manifest)
    this.header = {
      id: randomUUID(),
      organizationId: binding.organizationId,
      runId: binding.runId,
      manifest,
      descriptors: [],
    }
    this.bindingDigest = contextBindingDigest(this.header)
    for (const kind of CONTEXT_KINDS)
      manifest.collections[kind].root = contextInitialRoot(this.bindingDigest, kind)
  }

  append(page: NormalizationPage): void {
    if (this.closed) throw invalidNormalizedContext()
    try {
      const kind = page.kind
      if (
        !CONTEXT_KINDS.includes(kind) ||
        (this.phase === 'OWN_EXPORTS' && kind === 'MAPPINGS') ||
        (kind === 'OWN_EXPORTS' && this.seen.MAPPINGS !== this.binding.counts.MAPPINGS) ||
        page.stageId !== this.binding.stageId ||
        this.sourceIds.has(page.pageId) ||
        page.afterOrdinal !== BigInt(this.seen[kind]) ||
        page.itemCount !== page.items.length ||
        page.itemCount !==
          Math.min(CONTEXT_PAGE_SIZE, this.binding.counts[kind] - this.seen[kind]) ||
        page.itemCount < 1
      )
        throw invalidNormalizedContext()
      this.stream.append(kind, page.items)
      const number = Number(page.afterOrdinal / BigInt(CONTEXT_PAGE_SIZE)) + 1
      const digest = contextPageDigest(this.bindingDigest, kind, number, page.items)
      this.header.descriptors.push({
        sourcePageId: page.pageId,
        contextPageId: randomUUID(),
        kind,
        afterOrdinal: page.afterOrdinal.toString(),
        page: number,
        itemCount: page.itemCount,
        stageDigest: page.digest,
        contextDigest: digest,
      })
      const collection = this.header.manifest.collections[kind]
      collection.root = contextExtendRoot(collection.root, number, page.itemCount, digest)
      this.sourceIds.add(page.pageId)
      this.seen[kind] += page.itemCount
      this.phase = kind
    } catch (error) {
      this.closed = true
      throw error
    }
  }

  finish(): NormalizedContextPlan {
    if (this.closed) throw invalidNormalizedContext()
    this.closed = true
    if (
      CONTEXT_KINDS.some((kind) => this.seen[kind] !== this.binding.counts[kind]) ||
      this.stream.digest() !== this.header.manifest.sourceDigest
    )
      throw invalidNormalizedContext()
    ContextManifestSchema.parse(this.header.manifest)
    return { ...this.header, digest: contextHeaderDigest(this.header) }
  }
}

/** Efter låst scope/fence; ingen ekonomisk normalisering eller livekälla här. */
export async function copyNormalizedContextPages(
  tx: Tx,
  binding: NormalizedContextBinding,
  plan: NormalizedContextPlan,
): Promise<void> {
  const expectedPages = CONTEXT_KINDS.reduce(
    (n, kind) => n + Math.ceil(binding.counts[kind] / CONTEXT_PAGE_SIZE),
    0,
  )
  const manifest = ContextManifestSchema.parse(plan.manifest)
  if (
    plan.organizationId !== binding.organizationId ||
    plan.runId !== binding.runId ||
    plan.digest !== contextHeaderDigest(plan) ||
    plan.descriptors.length !== expectedPages ||
    checkpointDigest(manifest.input) !== checkpointDigest(binding.input) ||
    checkpointDigest(manifest.connection) !== checkpointDigest(binding.connection) ||
    CONTEXT_KINDS.some((kind) => manifest.collections[kind].itemCount !== binding.counts[kind])
  )
    throw invalidNormalizedContext()
  await tx.$executeRaw`SET CONSTRAINTS "fortnox_context_snapshot_must_be_sealed" DEFERRED`
  await tx.fortnoxReadContextSnapshot.create({
    data: {
      id: plan.id,
      organizationId: binding.organizationId,
      runId: binding.runId,
      manifest: manifest as Prisma.InputJsonValue,
      digest: plan.digest,
    },
    select: { id: true },
  })
  let copied = 0
  if (plan.descriptors.length > 0) {
    copied = await tx.$executeRaw`INSERT INTO "FortnoxReadContextPage"
      ("id", "organizationId", "snapshotId", "kind", "page", "itemCount", "digest", "items")
      SELECT d."contextPageId", ${binding.organizationId}, ${plan.id}, p."kind", d."page", p."itemCount", d."contextDigest", p."items"
      FROM jsonb_to_recordset(${JSON.stringify(plan.descriptors)}::jsonb) AS d(
        "sourcePageId" text, "contextPageId" text, "kind" text, "afterOrdinal" bigint,
        "page" integer, "itemCount" integer, "stageDigest" text, "contextDigest" text)
      JOIN "FortnoxReadNormalizationPage" p ON p."id" = d."sourcePageId"
        AND p."organizationId" = ${binding.organizationId} AND p."stageId" = ${binding.stageId}
        AND p."kind"::text = d."kind" AND p."afterOrdinal" = d."afterOrdinal"
        AND p."itemCount" = d."itemCount" AND p."digest" = d."stageDigest"
        AND d."page" = p."afterOrdinal" / 100 + 1
      ORDER BY p."kind", p."afterOrdinal"`
  }
  if (copied !== expectedPages) throw invalidNormalizedContext()
}

/** Caller kontrollerar färsk lease både före denna seal och efter IMMEDIATE. */
export async function sealNormalizedContext(
  tx: Tx,
  binding: NormalizedContextBinding,
  plan: NormalizedContextPlan,
  now: Date,
): Promise<ContextHeader> {
  const row = await tx.fortnoxReadContextSnapshot.update({
    where: { id: plan.id, organizationId: binding.organizationId },
    // Prisma Date skriver UTC till det befintliga TIMESTAMP(3)-fältet.
    data: { sealedAt: now },
  })
  await tx.$executeRaw`SET CONSTRAINTS "fortnox_context_snapshot_must_be_sealed" IMMEDIATE`
  const header = checkedContextHeader(row)
  checkHeaderBinding(header, binding)
  assertNormalizedContextHeader(header, plan, plan.manifest.sourceDigest)
  return header
}

export async function readNormalizedContextPage(
  tx: Tx,
  header: ContextHeader,
  kind: ContextKind,
  page: number,
) {
  const row = await tx.fortnoxReadContextPage.findUnique({
    where: {
      snapshotId_kind_page: { snapshotId: header.id, kind, page },
      organizationId: header.organizationId,
    },
  })
  return checkedContextPage(row, header, kind, page)
}

export function normalizedContextReceipt(header: ContextHeader): NormalizedContextReceipt {
  const collections = header.manifest.collections
  return {
    snapshotId: header.id,
    runId: header.runId,
    sourceDigest: header.manifest.sourceDigest,
    headerDigest: header.digest,
    mappingCount: collections.MAPPINGS.itemCount,
    exportCount: collections.OWN_EXPORTS.itemCount,
    mappingPageCount: collections.MAPPINGS.pageCount,
    exportPageCount: collections.OWN_EXPORTS.pageCount,
  }
}
