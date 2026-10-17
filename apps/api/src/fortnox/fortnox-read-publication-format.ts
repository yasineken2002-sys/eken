import { z } from 'zod'
import { CheckpointInputSchema, checkpointDigest } from './fortnox-read-checkpoint-context'
import { ContextManifestSchema } from './fortnox-read-context-format'
import type { NormalizedContextBinding } from './fortnox-read-normalized-context'
import type { ReadyLedgerReduction, ReductionProof } from './fortnox-read-reduction'
import {
  assertLedgerTransportJson,
  decodeLedgerResult,
  encodeLedgerResult,
  LedgerResultFormatError,
} from './fortnox-read-result-format'

export const PUBLICATION_OVERFLOW_REASON = 'Beloppssumman ligger utanför säkert talområde'

export class PublicationFormatError extends Error {
  constructor() {
    super('Ogiltig lagrad huvudbokspublicering')
    this.name = 'PublicationFormatError'
  }
}

const count = z.number().int().nonnegative().safe()
const positive = z.number().int().positive().safe()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1)
const BindingSchema = z
  .object({
    organizationId: id,
    runId: id,
    sourceCaptureId: id,
    stageId: id,
    requestHash: hash,
    input: CheckpointInputSchema,
    connection: ContextManifestSchema.shape.connection,
    counts: z.object({ MAPPINGS: count, OWN_EXPORTS: count }).strict(),
  })
  .strict() satisfies z.ZodType<NormalizedContextBinding>
const ProofSchema = z
  .object({
    version: z.literal(1),
    organizationId: id,
    runId: id,
    sourceCaptureId: id,
    snapshotId: id,
    snapshotDigest: hash,
    sourceDigest: hash,
    catalogDigest: hash,
    manifestDigest: hash,
    detailDigest: hash,
    manifestPageCount: positive,
    manifestItemsSeen: count,
    voucherCount: count,
    claimVersion: positive,
  })
  .strict() satisfies z.ZodType<ReductionProof>

const EnvelopeSchema = z
  .object({
    formatVersion: z.literal(1),
    id,
    organizationId: id,
    runId: id,
    status: z.enum(['COMPLETE', 'COMPLETE_WITH_UNCERTAINTY', 'FAILED']),
    failureCode: z.literal('AMOUNT_OVERFLOW').nullable(),
    reason: z.literal(PUBLICATION_OVERFLOW_REASON).nullable(),
    binding: BindingSchema,
    proof: ProofSchema,
    resultDigest: hash.nullable(),
    canonicalBytes: count.nullable(),
  })
  .strict()
type Envelope = z.infer<typeof EnvelopeSchema>
export type DecodedPublication = Envelope & { publicationDigest: string }

/** DB adapter converts its checked bigint to number before this pure boundary.
 * publishedAt is independently checked against the terminal run, outside this hash.
 */
export type EncodedPublication = Readonly<
  Omit<Envelope, 'binding' | 'proof'> & {
    bindingJson: string
    proofJson: string
    publicationDigest: string
    summaryJson: string | null
    rowsJson: string | null
    coverageJson: string | null
    uncertaintiesJson: string | null
    financialYearJson: string | null
  }
>

function invalid(): never {
  throw new PublicationFormatError()
}

/** Only format failures are masked. Never swallow DB, timeout or unknown errors. */
function formatOperation<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof LedgerResultFormatError) throw new PublicationFormatError()
    throw error
  }
}

/** Called only after the transport descriptor check. Zod reads named fields,
 * including absent optional ones; null-prototype input prevents it from reading
 * inherited getters or inventing inherited values. Only small metadata is copied.
 * The already transport-checked economic result stays with its existing codec.
 */
function ownMetadata(value: unknown, outcomeRoot = false): unknown {
  if (Array.isArray(value)) return value.map((item) => ownMetadata(item))
  if (value === null || typeof value !== 'object') return value
  const own = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key]
    own[key] = outcomeRoot && key === 'result' ? item : ownMetadata(item)
  }
  return own
}

function envelope(value: unknown): Envelope {
  const parsed = EnvelopeSchema.safeParse(ownMetadata(value))
  if (!parsed.success) return invalid()
  const e = parsed.data
  if (
    e.binding.organizationId !== e.organizationId ||
    e.proof.organizationId !== e.organizationId ||
    e.binding.runId !== e.runId ||
    e.proof.runId !== e.runId ||
    e.binding.sourceCaptureId !== e.runId ||
    e.binding.stageId !== e.runId ||
    e.proof.sourceCaptureId !== e.binding.sourceCaptureId
  )
    invalid()
  if (e.status === 'FAILED') {
    if (
      e.failureCode !== 'AMOUNT_OVERFLOW' ||
      e.reason !== PUBLICATION_OVERFLOW_REASON ||
      e.resultDigest !== null ||
      e.canonicalBytes !== null
    )
      invalid()
  } else if (
    e.failureCode !== null ||
    e.reason !== null ||
    e.resultDigest === null ||
    e.canonicalBytes === null
  )
    invalid()
  return e
}

const OUTCOME_SCHEMA = z.union([
  z.object({ kind: z.literal('REDUCED'), proof: ProofSchema, result: z.unknown() }).strict(),
  z
    .object({ kind: z.literal('FAILED'), code: z.literal('AMOUNT_OVERFLOW'), proof: ProofSchema })
    .strict(),
])

/** Server-private caller supplies its actual A–F outcome. This format is never
 * evidence that A–F ran, nor authorization for a later DB write.
 */
export function encodeLedgerPublication(
  publicationId: string,
  binding: NormalizedContextBinding,
  outcome: ReadyLedgerReduction,
): EncodedPublication {
  return formatOperation(() => {
    assertLedgerTransportJson({ publicationId, binding, outcome })
    if (!OUTCOME_SCHEMA.safeParse(ownMetadata(outcome, true)).success) return invalid()
    // Zod's unknown field accepts absence; the existing codec must never read
    // a missing result through Object.prototype after that shape check.
    if (outcome.kind === 'REDUCED' && !Object.hasOwn(outcome, 'result')) return invalid()
    const parsedBinding = BindingSchema.safeParse(ownMetadata(binding))
    if (!parsedBinding.success) return invalid()
    const result = outcome.kind === 'REDUCED' ? encodeLedgerResult(outcome.result) : null
    const e = envelope({
      formatVersion: 1,
      id: publicationId,
      organizationId: parsedBinding.data.organizationId,
      runId: parsedBinding.data.runId,
      status: result?.status ?? 'FAILED',
      failureCode: result ? null : 'AMOUNT_OVERFLOW',
      reason: result ? null : PUBLICATION_OVERFLOW_REASON,
      binding: parsedBinding.data,
      proof: outcome.proof,
      resultDigest: result?.resultDigest ?? null,
      canonicalBytes: result?.canonicalBytes ?? null,
    })
    const { binding: checkedBinding, proof, ...scalars } = e
    return Object.freeze({
      ...scalars,
      bindingJson: JSON.stringify(checkedBinding),
      proofJson: JSON.stringify(proof),
      publicationDigest: checkpointDigest(e),
      summaryJson: result?.summaryJson ?? null,
      rowsJson: result?.rowsJson ?? null,
      coverageJson: result?.coverageJson ?? null,
      uncertaintiesJson: result?.uncertaintiesJson ?? null,
      financialYearJson: result?.financialYearJson ?? null,
    })
  })
}

const STORED_KEYS = new Set([
  ...Object.keys(EnvelopeSchema.shape),
  'publicationDigest',
  'summary',
  'rows',
  'coverage',
  'uncertainties',
  'financialYear',
])

/** Reads actual JSONB content. Returns small metadata only after the complete
 * result digest and byte count, then outer digest, have both been checked.
 * The caller separately compares binding/proof to immutable scoped DB metadata.
 */
export function decodeLedgerPublication(stored: unknown): DecodedPublication {
  return formatOperation(() => {
    assertLedgerTransportJson(stored)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return invalid()
    const s = stored as Record<string, unknown>
    const keys = Object.keys(s)
    if (keys.length !== STORED_KEYS.size || keys.some((key) => !STORED_KEYS.has(key)))
      return invalid()
    const { publicationDigest, summary, rows, coverage, uncertainties, financialYear, ...fields } =
      s
    const e = envelope(fields)
    if (!hash.safeParse(publicationDigest).success) return invalid()
    if (e.status === 'FAILED') {
      if ([summary, rows, coverage, uncertainties, financialYear].some((part) => part !== null))
        invalid()
    } else {
      decodeLedgerResult({
        formatVersion: 1,
        status: e.status,
        reason: e.reason,
        resultDigest: e.resultDigest,
        canonicalBytes: e.canonicalBytes,
        summary,
        rows,
        coverage,
        uncertainties,
        financialYear,
      })
    }
    if (checkpointDigest(e) !== publicationDigest) return invalid()
    return { ...e, publicationDigest: publicationDigest as string }
  })
}
