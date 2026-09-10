import { createHash } from 'node:crypto'
import type { Prisma, MeterReadingReview } from '@prisma/client'
import { READING_REVIEW_RULE_VERSION, reviewReadings } from '@eken/shared'
import type {
  ReadingFinding,
  ReadingReviewSnapshot,
  ReviewReading,
  ReadingReviewDecision,
} from '@eken/shared'

/** Binder underlaget till regelversionen; är ingen behörighet eller ett godkännande. */
export function readingFindingFingerprint(finding: ReadingFinding): string {
  // Explicit fältlista och ordning. Etiketter, språk och annan presentationsdata
  // ska inte ge en annan identitet; originalvärden och källrader ska göra det.
  const sources = [...finding.sourceReadings]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      meterId: r.meterId,
      value: r.value,
      readingType: r.readingType,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
    }))
  return createHash('sha256')
    .update(
      JSON.stringify({
        ruleVersion: READING_REVIEW_RULE_VERSION,
        readingId: finding.readingId,
        meterId: finding.meterId,
        code: finding.code,
        sources,
      }),
    )
    .digest('hex')
}

export async function loadReadingReview(
  organizationId: string,
  db: Pick<Prisma.TransactionClient, 'meterReading' | 'meterReadingReview'>,
  meterId?: string,
): Promise<ReadingReviewSnapshot> {
  // Full periodhistorik för organisationen, eller grindens servervalda mätare.
  // Ingen klientstyrd datumgräns får klippa jämförelseperioderna.
  const rows = await db.meterReading.findMany({
    where: { organizationId, ...(meterId ? { meterId } : {}) },
    select: {
      id: true,
      organizationId: true,
      meterId: true,
      value: true,
      readingType: true,
      periodStart: true,
      periodEnd: true,
    },
  })
  const readings: ReviewReading[] = rows.map((r) => ({
    ...r,
    value: r.value.toString(),
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
  }))
  const report = reviewReadings(readings)
  const history = await db.meterReadingReview.findMany({
    where: { organizationId, ...(meterId ? { reading: { meterId } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
  })
  const byFinding = new Map<string, ReadingReviewDecision[]>()
  for (const row of history) {
    const key = JSON.stringify([row.readingId, row.findingCode])
    const reviews = byFinding.get(key) ?? []
    reviews.push(presentReadingReviewDecision(row))
    reviews.sort((a, b) => b.revision - a.revision)
    byFinding.set(key, reviews)
  }
  return {
    ...report,
    history: history.map((row) => presentReadingReviewDecision(row)),
    ruleVersion: READING_REVIEW_RULE_VERSION,
    findings: report.findings.map((f) => ({
      ...f,
      fingerprint: readingFindingFingerprint(f),
      reviews: byFinding.get(JSON.stringify([f.readingId, f.code])) ?? [],
    })),
  }
}

export function presentReadingReviewDecision(row: MeterReadingReview): ReadingReviewDecision {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    revision: row.revision,
    assessment: row.assessment,
    ruleVersion: row.ruleVersion,
    ...(row.billingBasisDecision ? { billingBasisDecision: row.billingBasisDecision } : {}),
    comment: row.comment,
    reviewedByName: row.reviewedByName,
    createdAt: row.createdAt.toISOString(),
    evidence: row.evidence as unknown as ReadingFinding,
  }
}
