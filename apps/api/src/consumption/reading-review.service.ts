import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { READING_REVIEW_RULE_VERSION, reviewReadings } from '@eken/shared'
import type { ReadingFinding, ReadingReviewSnapshot, ReviewReading } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'

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

@Injectable()
export class ReadingReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async getReview(organizationId: string): Promise<ReadingReviewSnapshot> {
    // Samma ofiltrerade organisationshistorik som GET readings. Ingen klientstyrd
    // org, mätare eller datumgräns får klippa jämförelseperioderna.
    const rows = await this.prisma.meterReading.findMany({
      where: { organizationId },
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
    return {
      ...report,
      ruleVersion: READING_REVIEW_RULE_VERSION,
      findings: report.findings.map((f) => ({ ...f, fingerprint: readingFindingFingerprint(f) })),
    }
  }
}
