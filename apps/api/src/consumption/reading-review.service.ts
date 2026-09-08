import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type {
  ReadingReviewSnapshot,
  ReadingReviewDecision,
  SaveReadingReviewInput,
} from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { loadReadingReview, presentReadingReviewDecision } from './reading-review.query'
export { readingFindingFingerprint } from './reading-review.query'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

@Injectable()
export class ReadingReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async getReview(organizationId: string): Promise<ReadingReviewSnapshot> {
    return loadReadingReview(organizationId, this.prisma)
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
          const report = await loadReadingReview(organizationId, tx)
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
          return presentReadingReviewDecision(row)
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
