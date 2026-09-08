import { createHash } from 'node:crypto'
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { MeterReadingReview } from '@prisma/client'
import { READING_REVIEW_RULE_VERSION, reviewReadings } from '@eken/shared'
import type {
  ReadingFinding,
  ReadingReviewSnapshot,
  ReviewReading,
  ReadingReviewDecision,
  SaveReadingReviewInput,
} from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

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
    return this.loadReview(organizationId, this.prisma)
  }

  private async loadReview(
    organizationId: string,
    db: Pick<Prisma.TransactionClient, 'meterReading' | 'meterReadingReview'>,
  ): Promise<ReadingReviewSnapshot> {
    // Samma ofiltrerade organisationshistorik som GET readings. Ingen klientstyrd
    // org, mätare eller datumgräns får klippa jämförelseperioderna.
    const rows = await db.meterReading.findMany({
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
    const history = await db.meterReadingReview.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
    })
    const byFinding = new Map<string, ReadingReviewDecision[]>()
    for (const row of history) {
      const key = JSON.stringify([row.readingId, row.findingCode])
      const reviews = byFinding.get(key) ?? []
      reviews.push(this.presentDecision(row))
      reviews.sort((a, b) => b.revision - a.revision)
      byFinding.set(key, reviews)
    }
    return {
      ...report,
      history: history.map((row) => this.presentDecision(row)),
      ruleVersion: READING_REVIEW_RULE_VERSION,
      findings: report.findings.map((f) => ({
        ...f,
        fingerprint: readingFindingFingerprint(f),
        reviews: byFinding.get(JSON.stringify([f.readingId, f.code])) ?? [],
      })),
    }
  }

  private presentDecision(row: MeterReadingReview): ReadingReviewDecision {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      revision: row.revision,
      assessment: row.assessment,
      comment: row.comment,
      reviewedByName: row.reviewedByName,
      createdAt: row.createdAt.toISOString(),
      evidence: row.evidence as unknown as ReadingFinding,
    }
  }

  async saveReview(
    organizationId: string,
    userId: string,
    dto: SaveReadingReviewInput,
  ): Promise<ReadingReviewDecision> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Roll och aktör hämtas på nytt, inte från kropp eller en gammal JWT-roll.
          const actor = await tx.user.findFirst({
            where: { id: userId, organizationId, isActive: true },
            select: { firstName: true, lastName: true, role: true },
          })
          if (!actor || !['OWNER', 'ADMIN', 'MANAGER'].includes(actor.role))
            throw new ForbiddenException('Din roll får inte spara bedömningar.')
          const report = await this.loadReview(organizationId, tx)
          const finding = report.findings.find(
            (f) => f.readingId === dto.readingId && f.code === dto.findingCode,
          )
          if (!finding || finding.fingerprint !== dto.fingerprint)
            throw new ConflictException('Underlaget har ändrats. Läs om varningen innan du sparar.')
          if ((finding.reviews[0]?.revision ?? 0) !== dto.expectedRevision)
            throw new ConflictException(
              'En ny bedömning har sparats. Läs om historiken innan du sparar.',
            )
          const { reviews: _history, ...evidence } = finding
          void _history
          const row = await tx.meterReadingReview.create({
            data: {
              organizationId,
              readingId: dto.readingId,
              findingCode: dto.findingCode,
              fingerprint: finding.fingerprint,
              ruleVersion: report.ruleVersion,
              revision: dto.expectedRevision + 1,
              assessment: dto.assessment,
              comment: dto.comment,
              reviewedById: userId,
              reviewedByName: `${actor.firstName} ${actor.lastName}`.trim(),
              evidence: JSON.parse(JSON.stringify(evidence)) as Prisma.InputJsonValue,
            },
          })
          return this.presentDecision(row)
        },
        {
          ...PRISMA_DEFAULT_TX_LIMITS,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      )
    } catch (error) {
      // Unik revision skyddar även mot samtidiga första beslut; serialisering
      // hindrar att en tävlande avläsning/bedömning kringgår läsningen ovan.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException(
          'Underlaget eller bedömningen har ändrats. Läs om innan du sparar.',
        )
      }
      throw error
    }
  }
}
