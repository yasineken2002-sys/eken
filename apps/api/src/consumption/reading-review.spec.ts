import 'reflect-metadata'
import { Prisma } from '@prisma/client'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { ReadingReviewService, readingFindingFingerprint } from './reading-review.service'
import { ReadingReviewController } from './reading-review.controller'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { PrismaService } from '../common/prisma/prisma.service'
import { READING_REVIEW_RULE_VERSION } from '@eken/shared'

const row = (n: number, value: number) => ({
  id: `r${n}`,
  organizationId: 'org',
  meterId: 'meter',
  value: new Prisma.Decimal(value),
  readingType: 'PERIOD_VOLUME',
  periodStart: new Date(Date.UTC(2026, 0, n)),
  periodEnd: new Date(Date.UTC(2026, 0, n)),
})
function setup(rows = [10, 10, 10, 40].map((v, i) => row(i + 1, v))) {
  const findMany = jest.fn().mockResolvedValue(rows)
  const service = new ReadingReviewService({
    meterReading: { findMany },
    meterReadingReview: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService)
  return { service, findMany, rows }
}
describe('Granskningsunderlag från API', () => {
  it('läser hela organisationshistoriken med bara granskningens fält', async () => {
    const { service, findMany } = setup()
    const report = await service.getReview('org')
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org' },
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
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({
      total: 4,
      trendAssessed: 1,
      notTrendAssessed: 3,
      ruleVersion: READING_REVIEW_RULE_VERSION,
    })
    expect(report.findings[0]).toMatchObject({
      readingId: 'r4',
      code: 'HIGH_RATE',
      trend: { median: 10, threshold: 30 },
    })
    expect(report.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.findings[0]?.sourceReadings[0]).toMatchObject({
      value: '10',
      periodStart: '2026-01-01T00:00:00.000Z',
    })
  })
  it('vidarebefordrar organisationen från kontrollern och har JWT-skydd', async () => {
    const { service, findMany } = setup()
    const controller = new ReadingReviewController(service)
    await controller.getReview('other-org')
    expect(findMany.mock.calls[0]![0].where).toEqual({ organizationId: 'other-org' })
    expect(Reflect.getMetadata(GUARDS_METADATA, ReadingReviewController)).toContain(JwtAuthGuard)
  })
  it('ger tom rapport först efter lyckad tom DB-läsning', async () => {
    const { service } = setup([])
    expect(await service.getReview('org')).toEqual({
      total: 0,
      trendAssessed: 0,
      notTrendAssessed: 0,
      findings: [],
      history: [],
      ruleVersion: READING_REVIEW_RULE_VERSION,
    })
  })
  it('låter DB-fel bli fel i stället för tomt klartecken', async () => {
    const { service, findMany } = setup()
    findMany.mockRejectedValue(new Error('offline'))
    await expect(service.getReview('org')).rejects.toThrow('offline')
  })
  it('har stabilt fingeravtryck oberoende av DB-ordning', async () => {
    const { service, findMany, rows } = setup()
    const a = await service.getReview('org')
    findMany.mockResolvedValue([...rows].reverse())
    const b = await service.getReview('org')
    expect(b).toEqual(a)
  })
  it.each(['value', 'periodStart', 'id', 'organizationId', 'meterId', 'readingType'] as const)(
    'fingeravtrycket ändras när källfältet %s ändras',
    async (field) => {
      const { service } = setup()
      const f = (await service.getReview('org')).findings[0]!
      const changed = {
        ...f,
        sourceReadings: f.sourceReadings.map((r, i) =>
          i === 0 ? { ...r, [field]: `${r[field]}-changed` } : r,
        ),
      }
      expect(readingFindingFingerprint(changed)).not.toBe(f.fingerprint)
    },
  )
  it('språklig förklaring ändrar inte underlagets identitet', async () => {
    const { service } = setup()
    const f = (await service.getReview('org')).findings[0]!
    expect(readingFindingFingerprint({ ...f, explanation: 'Annan formulering' })).toBe(
      f.fingerprint,
    )
  })
  it('kod och varningens avläsning är del av identiteten', async () => {
    const { service } = setup()
    const f = (await service.getReview('org')).findings[0]!
    expect(readingFindingFingerprint({ ...f, code: 'DATA' })).not.toBe(f.fingerprint)
    expect(readingFindingFingerprint({ ...f, readingId: 'another' })).not.toBe(f.fingerprint)
  })
})
