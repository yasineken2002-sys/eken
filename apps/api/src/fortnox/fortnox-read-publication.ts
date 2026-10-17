import { ConflictException } from '@nestjs/common'
import { Prisma, type FortnoxReadRun } from '@prisma/client'
import { checkpointDigest, CheckpointCatalogSchema } from './fortnox-read-checkpoint-context'
import { checkpointCatalogMatches } from './fortnox-read-catalog-contract'
import { readCheckpointSourceHeader } from './fortnox-read-source-capture'
import { readStoredCompletedNormalizationStage } from './fortnox-read-normalization-stage'
import {
  normalizedContextBinding,
  findNormalizedContextHeader,
  type NormalizedContextBinding,
} from './fortnox-read-normalized-context'
import {
  decodeLedgerPublication,
  PublicationFormatError,
  type DecodedPublication,
  type EncodedPublication,
} from './fortnox-read-publication-format'
import type { ReductionProof } from './fortnox-read-reduction'

type Tx = Prisma.TransactionClient
type SourceHeader = Awaited<ReturnType<typeof readCheckpointSourceHeader>>
export type PublicationReceipt = {
  id: string
  organizationId: string
  runId: string
  formatVersion: 1
  status: DecodedPublication['status']
  failureCode: DecodedPublication['failureCode']
  reason: DecodedPublication['reason']
  publishedAt: Date
  claimVersion: number
  resultDigest: string | null
  canonicalBytes: number | null
  publicationDigest: string
  proof: ReductionProof
}

type PublicationCoverage = {
  pageCount: bigint
  firstPage: number | null
  lastPage: number | null
  itemsSeen: bigint
  totalPages: number | null
  totalResources: number | null
  pagesValid: boolean
  voucherCount: bigint
  detailsComplete: boolean
}
type StoredPublicationEvidence = {
  stored: Parameters<typeof decodeLedgerPublication>[0]
  publishedAt: Date
  status: FortnoxReadRun['status']
  reason: string | null
  binding: NormalizedContextBinding
  proof: Omit<ReductionProof, 'manifestDigest' | 'detailDigest'>
  financialYear: { id: number; fromDate: string; toDate: string }
  storedFinancialYear: Prisma.JsonValue | null
}

const invalid = (): never => {
  throw new PublicationFormatError()
}
const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime())
const safeCount = (value: bigint): number => {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  return Number(value)
}

/** Only the specific existing storage validators are translated. Prisma,
 * network, timeout and unknown failures keep their original identity.
 */
function rethrowStorageFormat(error: unknown): never {
  if (
    error instanceof ConflictException &&
    [
      'Det frysta källunderlaget är ofullständigt eller ogiltigt',
      'Normaliseringsunderlaget är ofullständigt eller ogiltigt',
      'Det normaliserade läsunderlaget är ofullständigt eller ogiltigt',
      'Det frysta läsunderlaget är ofullständigt eller ogiltigt',
    ].includes(error.message)
  )
    invalid()
  throw error
}

/** The caller already holds connection -> run -> stage and an exact current
 * token/version fence. SQL repeats structural checks, not caller authorization.
 * Null parameters cast to jsonb remain SQL NULL for the overflow outcome.
 */
export async function insertLedgerPublication(
  tx: Tx,
  encoded: EncodedPublication,
): Promise<{ id: string; publishedAt: Date }> {
  const rows = await tx.$queryRaw<Array<{ id: string; publishedAt: Date }>>(Prisma.sql`
    INSERT INTO "FortnoxReadPublication"
      ("id", "organizationId", "runId", "formatVersion", "status", "failureCode", "reason",
       "binding", "proof", "resultDigest", "canonicalBytes", "publicationDigest",
       "financialYear", "summary", "rows", "coverage", "uncertainties")
    VALUES (${encoded.id}, ${encoded.organizationId}, ${encoded.runId}, ${encoded.formatVersion},
      ${encoded.status}::"FortnoxReadStatus", ${encoded.failureCode}, ${encoded.reason},
      ${encoded.bindingJson}::jsonb, ${encoded.proofJson}::jsonb, ${encoded.resultDigest},
      ${encoded.canonicalBytes === null ? null : BigInt(encoded.canonicalBytes)},
      ${encoded.publicationDigest}, ${encoded.financialYearJson}::jsonb,
      ${encoded.summaryJson}::jsonb, ${encoded.rowsJson}::jsonb,
      ${encoded.coverageJson}::jsonb, ${encoded.uncertaintiesJson}::jsonb)
    RETURNING "id", "publishedAt"`)
  if (rows.length !== 1 || rows[0]!.id !== encoded.id || !validDate(rows[0]!.publishedAt)) invalid()
  return rows[0]!
}

function checkHistoricalRun(
  run: FortnoxReadRun,
  source: SourceHeader,
  publication: {
    organizationId: string
    runId: string
    status: FortnoxReadRun['status']
    reason: string | null
    publishedAt: Date
  },
): void {
  // This is the actual terminal row, never a fake RUNNING copy. Historical
  // readers intentionally do not consult today's live connection or lease.
  if (
    run.id !== publication.runId ||
    run.organizationId !== publication.organizationId ||
    run.workVersion !== 2 ||
    run.phase !== 'READY_TO_REDUCE' ||
    run.status !== publication.status ||
    run.reason !== publication.reason ||
    !validDate(run.completedAt) ||
    run.completedAt.getTime() !== publication.publishedAt.getTime() ||
    !validDate(run.checkpointUpdatedAt) ||
    run.checkpointUpdatedAt < run.completedAt ||
    !Number.isSafeInteger(run.claimVersion) ||
    run.claimVersion < 1 ||
    run.claimVersion > 2_147_483_647 ||
    run.claimToken !== null ||
    run.leaseUntil !== null ||
    run.nextAttemptAt !== null ||
    run.sourceCaptureId !== run.id ||
    source.id !== run.id ||
    source.organizationId !== run.organizationId ||
    run.connectionId !== source.connectionId ||
    run.connectionGeneration !== source.connectionGeneration ||
    run.fortnoxDatabaseNumber !== source.fortnoxDatabaseNumber ||
    run.fortnoxOrgNumber !== source.fortnoxOrgNumber ||
    run.requestHash !== source.requestHash ||
    run.financialYearId !== source.input.financialYearId ||
    !validDate(run.periodFrom) ||
    !validDate(run.periodTo) ||
    run.periodFrom.toISOString().slice(0, 10) !== source.input.periodFrom ||
    run.periodTo.toISOString().slice(0, 10) !== source.input.periodTo ||
    checkpointDigest(run.costAccounts) !== checkpointDigest(source.input.costAccounts) ||
    run.frozenContext !== null ||
    run.summary !== null ||
    run.rows !== null ||
    run.coverage === null ||
    typeof run.coverage !== 'object' ||
    Array.isArray(run.coverage) ||
    Object.keys(run.coverage).length !== 0 ||
    !Array.isArray(run.uncertainties) ||
    run.uncertainties.length !== 0 ||
    !Number.isSafeInteger(run.nextManifestPage) ||
    run.nextManifestPage < 2 ||
    !validDate(source.createdAt) ||
    !validDate(source.sealedAt)
  )
    invalid()
}

async function readCoverage(tx: Tx, run: FortnoxReadRun): Promise<PublicationCoverage> {
  // Metadata only, once per receipt. SUM counts duplicate appearances while
  // the checkpoint count counts distinct keys. No manifest/detail body is read.
  const rows = await tx.$queryRaw<PublicationCoverage[]>(Prisma.sql`
    SELECT m.*, v."voucherCount", v."detailsComplete"
    FROM (
      SELECT count(*)::bigint AS "pageCount", min("page") AS "firstPage", max("page") AS "lastPage",
        coalesce(sum("itemCount"), 0)::bigint AS "itemsSeen",
        min("totalPages") AS "totalPages", min("totalResources") AS "totalResources",
        coalesce(bool_and("itemCount" BETWEEN 0 AND 100 AND "page" >= 1
          AND "totalPages" >= 0 AND "totalResources" >= 0
          AND (CASE WHEN "totalPages" = 0 THEN "page" = 1 AND "totalResources" = 0 AND "itemCount" = 0
               ELSE "page" <= "totalPages" END)), false)
          AND min("totalPages") = max("totalPages")
          AND min("totalResources") = max("totalResources") AS "pagesValid"
      FROM "FortnoxReadManifestPage"
      WHERE "organizationId" = ${run.organizationId} AND "runId" = ${run.id}
    ) m CROSS JOIN (
      SELECT count(*)::bigint AS "voucherCount",
        coalesce(bool_and("validated" IS NOT NULL AND "detailDigest" IS NOT NULL AND "observedAt" IS NOT NULL), true) AS "detailsComplete"
      FROM "FortnoxReadVoucherCheckpoint"
      WHERE "organizationId" = ${run.organizationId} AND "runId" = ${run.id}
    ) v`)
  const c = rows[0]
  if (
    rows.length !== 1 ||
    !c ||
    c.pagesValid !== true ||
    c.detailsComplete !== true ||
    c.firstPage !== 1 ||
    c.lastPage !== run.nextManifestPage - 1 ||
    !Number.isSafeInteger(c.totalPages) ||
    c.totalPages === null ||
    c.totalPages < 0 ||
    !Number.isSafeInteger(c.totalResources) ||
    c.totalResources === null ||
    c.totalResources < 0 ||
    safeCount(c.pageCount) !== Math.max(1, c.totalPages) ||
    c.lastPage !== Math.max(1, c.totalPages) ||
    safeCount(c.voucherCount) !== c.totalResources
  )
    invalid()
  safeCount(c.itemsSeen)
  return c
}

/** Read in a new scoped RepeatableRead TX after commit. No row locks, no
 * active-connection requirement, no writes or terminal-run resurrection.
 * Expensive JSON validation/hash happens after this short read transaction.
 */
export async function readStoredLedgerPublication(
  tx: Tx,
  organizationId: string,
  runId: string,
): Promise<StoredPublicationEvidence | null> {
  try {
    const row = await tx.fortnoxReadPublication.findUnique({ where: { runId, organizationId } })
    if (!row) return null
    if (row.organizationId !== organizationId || row.runId !== runId || !validDate(row.publishedAt))
      invalid()
    const canonicalBytes = row.canonicalBytes === null ? null : safeCount(row.canonicalBytes)
    const run = await tx.fortnoxReadRun.findUnique({ where: { id: runId, organizationId } })
    if (!run || !run.sourceCaptureId) invalid()
    const source = await readCheckpointSourceHeader(tx, organizationId, run.sourceCaptureId)
    checkHistoricalRun(run, source, row)
    const stage = await readStoredCompletedNormalizationStage(tx, run, source)
    const binding = normalizedContextBinding(run, source, stage)
    const header = await findNormalizedContextHeader(tx, binding)
    if (!header || !validDate(header.createdAt) || !validDate(header.sealedAt)) invalid()
    const catalog = CheckpointCatalogSchema.safeParse(run.catalog)
    if (
      !catalog.success ||
      !validDate(run.financialYearStart) ||
      !validDate(run.financialYearEnd) ||
      catalog.data.financialYear.fromDate !== run.financialYearStart.toISOString().slice(0, 10) ||
      catalog.data.financialYear.toDate !== run.financialYearEnd.toISOString().slice(0, 10) ||
      !checkpointCatalogMatches(
        binding.input,
        binding.connection.databaseNumber,
        false,
        catalog.data,
      )
    )
      invalid()
    const counts = await readCoverage(tx, run)
    return {
      stored: {
        formatVersion: row.formatVersion,
        id: row.id,
        organizationId: row.organizationId,
        runId: row.runId,
        status: row.status,
        failureCode: row.failureCode,
        reason: row.reason,
        binding: row.binding,
        proof: row.proof,
        resultDigest: row.resultDigest,
        canonicalBytes,
        publicationDigest: row.publicationDigest,
        financialYear: row.financialYear,
        summary: row.summary,
        rows: row.rows,
        coverage: row.coverage,
        uncertainties: row.uncertainties,
      },
      publishedAt: row.publishedAt,
      status: run.status,
      reason: run.reason,
      binding,
      proof: {
        version: 1,
        organizationId,
        runId,
        sourceCaptureId: source.id,
        snapshotId: header.id,
        snapshotDigest: header.digest,
        sourceDigest: header.manifest.sourceDigest,
        catalogDigest: checkpointDigest(catalog.data),
        manifestPageCount: safeCount(counts.pageCount),
        manifestItemsSeen: safeCount(counts.itemsSeen),
        voucherCount: safeCount(counts.voucherCount),
        claimVersion: run.claimVersion,
      },
      financialYear: {
        id: catalog.data.financialYear.id,
        fromDate: catalog.data.financialYear.fromDate,
        toDate: catalog.data.financialYear.toDate,
      },
      storedFinancialYear: row.financialYear,
    }
  } catch (error) {
    rethrowStorageFormat(error)
  }
}

/** Checks every persisted result byte through the real codec, then validates
 * its outer digest against the immutable historical evidence. This does not
 * re-run A–F/economics or authenticate a coherent body+both-hash rewrite.
 */
export function checkedPublicationReceipt(evidence: StoredPublicationEvidence): PublicationReceipt {
  const decoded = decodeLedgerPublication(evidence.stored)
  const boundProof = {
    ...evidence.proof,
    manifestDigest: decoded.proof.manifestDigest,
    detailDigest: decoded.proof.detailDigest,
  }
  if (
    decoded.status !== evidence.status ||
    decoded.reason !== evidence.reason ||
    checkpointDigest(decoded.binding) !== checkpointDigest(evidence.binding) ||
    checkpointDigest(decoded.proof) !== checkpointDigest(boundProof) ||
    (decoded.status !== 'FAILED' &&
      checkpointDigest(evidence.storedFinancialYear) !== checkpointDigest(evidence.financialYear))
  )
    invalid()
  return {
    id: decoded.id,
    organizationId: decoded.organizationId,
    runId: decoded.runId,
    formatVersion: decoded.formatVersion,
    status: decoded.status,
    failureCode: decoded.failureCode,
    reason: decoded.reason,
    publishedAt: evidence.publishedAt,
    claimVersion: decoded.proof.claimVersion,
    resultDigest: decoded.resultDigest,
    canonicalBytes: decoded.canonicalBytes,
    publicationDigest: decoded.publicationDigest,
    proof: decoded.proof,
  }
}
