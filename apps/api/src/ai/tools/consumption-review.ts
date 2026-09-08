import { createHash } from 'node:crypto'
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { READING_REVIEW_ASSESSMENT_LABELS } from '@eken/shared'
import { loadReadingReview } from '../../consumption/reading-review.query'
import { ConsumptionReviewToolSchema } from './consumption-review.input'

type ReviewDb = Pick<Prisma.TransactionClient, 'meterReading' | 'meterReadingReview' | 'meter'>

/** Läsning av samma underlag som människans Granskning-flik. Ingen domänskrivning. */
export async function getConsumptionReview(
  db: ReviewDb,
  organizationId: string,
  role: string,
  input: Record<string, unknown>,
) {
  // Samma fem roller som GET /consumption/reading-review; okända roller nekas.
  if (!['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'].includes(role))
    throw new ForbiddenException('Din roll får inte läsa förbrukningsgranskningen.')
  const parsed = ConsumptionReviewToolSchema.safeParse(input)
  if (!parsed.success)
    throw new BadRequestException(
      'Ogiltig sidindelning. Använd offset, limit och snapshot från svaret.',
    )
  const { offset, limit, snapshot: requestedSnapshot } = parsed.data
  const report = await loadReadingReview(organizationId, db)
  const all = [...report.findings].sort((a, b) =>
    `${a.readingId}:${a.code}`.localeCompare(`${b.readingId}:${b.code}`),
  )
  // Binder sidföljden till både underlag och bedömningar. En ändring kräver omstart,
  // annars kunde samma offset hoppa över en nytillkommen varning.
  const snapshot = createHash('sha256')
    .update(
      JSON.stringify({
        organizationId,
        ruleVersion: report.ruleVersion,
        total: report.total,
        trendAssessed: report.trendAssessed,
        notTrendAssessed: report.notTrendAssessed,
        findings: all.map((f) => [f.readingId, f.code, f.fingerprint, f.reviews[0]?.id ?? null]),
      }),
    )
    .digest('hex')
  if (requestedSnapshot && requestedSnapshot !== snapshot)
    throw new ConflictException('Granskningen har ändrats. Börja om med offset 0 utan snapshot.')
  if (offset > 0 && offset >= all.length)
    throw new BadRequestException('Sidan finns inte. Börja om med offset 0 utan snapshot.')

  const page = all.slice(offset, offset + limit)
  const meters = page.length
    ? await db.meter.findMany({
        where: {
          organizationId,
          id: { in: [...new Set(page.map((f) => f.meterId))] },
          unit: { property: { organizationId } },
        },
        select: {
          id: true,
          type: true,
          unitOfMeasure: true,
          unit: {
            select: {
              id: true,
              name: true,
              unitNumber: true,
              property: { select: { id: true, name: true } },
            },
          },
        },
      })
    : []
  const byMeter = new Map(meters.map((meter) => [meter.id, meter]))
  const nextOffset = offset + page.length < all.length ? offset + page.length : null
  const canSaveAssessment = ['OWNER', 'ADMIN', 'MANAGER'].includes(role)
  const assessmentAccess = canSaveAssessment
    ? 'Du kan själv spara en bedömning i Förbrukning → Granskning. Assistenten kan endast läsa underlaget.'
    : 'Du har läsbehörighet och kan inte spara bedömningar. En behörig förvaltare behöver göra det i Förbrukning → Granskning. Assistenten kan endast läsa underlaget.'
  return {
    success: true,
    message: `${page.length} av ${all.length} varningar visas. ${nextOffset === null ? 'Inga fler sidor.' : 'Fler varningar finns; hämta nextOffset med samma snapshot.'} ${assessmentAccess}`,
    data: {
      humanPath: {
        route: '/consumption',
        tab: 'Granskning',
        canSaveAssessment,
        canAssistantSaveAssessment: false,
        canChangeReadings: false,
        canMakeBillingDecisions: false,
      },
      assessmentOptions: Object.entries(READING_REVIEW_ASSESSMENT_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
      ruleVersion: report.ruleVersion,
      summary: {
        readings: report.total,
        trendAssessed: report.trendAssessed,
        notTrendAssessed: report.notTrendAssessed,
        totalFindings: all.length,
        reviewHistoryCount: report.history.length,
        trendCoverage:
          report.total === 0
            ? 'NO_READINGS'
            : report.trendAssessed === 0
              ? 'NONE'
              : report.notTrendAssessed > 0
                ? 'PARTIAL'
                : 'ALL',
      },
      page: { offset, limit, returned: page.length, nextOffset, snapshot },
      findings: page.map(({ reviews, ...finding }) => {
        const latest = reviews[0]
        const meter = byMeter.get(finding.meterId)
        return {
          ...finding,
          // title är ett befintligt fritextfält som exekveraren skyddar från instruktioner.
          meter: meter
            ? {
                id: meter.id,
                title: `${meter.type} (${meter.unitOfMeasure}) · ${meter.unit.name} (${meter.unit.unitNumber}) · ${meter.unit.property.name}`,
                unitId: meter.unit.id,
                propertyId: meter.unit.property.id,
              }
            : null,
          assessmentState: !latest
            ? 'UNASSESSED'
            : latest.fingerprint !== finding.fingerprint
              ? 'CHANGED_EVIDENCE'
              : latest.assessment,
          latestAssessment: latest
            ? {
                id: latest.id,
                revision: latest.revision,
                assessment: latest.assessment,
                appliesToCurrentEvidence: latest.fingerprint === finding.fingerprint,
                comment: latest.comment,
                reviewedByName: latest.reviewedByName,
                createdAt: latest.createdAt,
              }
            : null,
        }
      }),
    },
  }
}
