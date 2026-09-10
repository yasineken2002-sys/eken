import { ConflictException, ForbiddenException, ValidationPipe } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { SaveReadingReviewSchema } from '@eken/shared'
import type { SaveReadingReviewInput } from '@eken/shared'
import { ReadingReviewService } from './reading-review.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { SaveReadingReviewDto } from './dto/save-reading-review.dto'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'

function setup() {
  const history: Record<string, unknown>[] = []
  const readings = [10, 10, 10, 40].map((value, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    organizationId: 'org',
    meterId: 'meter',
    value: new Prisma.Decimal(value),
    readingType: 'PERIOD_VOLUME',
    periodStart: new Date(Date.UTC(2026, 0, i + 1)),
    periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
  }))
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ firstName: 'Ada', lastName: 'Test', role: 'MANAGER' }),
    },
    meterReading: { findMany: jest.fn().mockResolvedValue(readings) },
    meterReadingReview: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve([...history].reverse())),
      create: jest.fn().mockImplementation(({ data }) => {
        const row = {
          ...data,
          id: `decision-${history.length + 1}`,
          createdAt: new Date('2026-09-08T12:00:00Z'),
        }
        history.push(row)
        return Promise.resolve(row)
      }),
    },
  }
  const transaction = jest.fn().mockImplementation((fn) => fn(db))
  const service = new ReadingReviewService({
    ...db,
    $transaction: transaction,
  } as unknown as PrismaService)
  const input = async (): Promise<SaveReadingReviewInput> => {
    const f = (await service.getReview('org')).findings[0]!
    return {
      readingId: f.readingId,
      findingCode: f.code,
      fingerprint: f.fingerprint,
      expectedRevision: 0,
      assessment: 'EXPLAINED',
      comment: 'Ändrad användning enligt kontrollerat underlag',
    }
  }
  return { db, service, input, history, readings, transaction }
}
describe('spara bedömning', () => {
  it('sparar bara en historikrad med serverns aktör och underlag', async () => {
    const { service, input, db, transaction } = setup()
    const dto = await input()
    const saved = await service.saveReview('org', 'user', dto)
    expect(saved).toMatchObject({
      revision: 1,
      reviewedByName: 'Ada Test',
      assessment: 'EXPLAINED',
      fingerprint: dto.fingerprint,
    })
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user', organizationId: 'org', isActive: true },
      select: { firstName: true, lastName: true, role: true },
    })
    expect(db.meterReadingReview.create.mock.calls[0]![0].data).toMatchObject({
      organizationId: 'org',
      reviewedById: 'user',
      ruleVersion: 'consumption-review-v2',
      evidence: { readingId: dto.readingId, code: 'HIGH_RATE' },
    })
    expect(db.meterReadingReview.create.mock.calls[0]![0].data.evidence.reviews).toBeUndefined()
    expect(transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: 'ReadCommitted' })
  })
  it('behåller förra revisionen och visar historik efter omläsning', async () => {
    const { service, input, history } = setup()
    const dto = await input()
    await service.saveReview('org', 'user', dto)
    await service.saveReview('org', 'user', {
      ...dto,
      expectedRevision: 1,
      assessment: 'CONFIRMED',
      comment: 'Ny kontroll visar fel',
    })
    expect(history).toHaveLength(2)
    const report = await service.getReview('org')
    expect(report.findings[0]?.reviews.map((r) => r.revision)).toEqual([2, 1])
    expect(report.history).toHaveLength(2)
  })
  it('bevarar historiken även när varningen försvinner', async () => {
    const { service, input, db } = setup()
    await service.saveReview('org', 'user', await input())
    db.meterReading.findMany.mockResolvedValue([])
    const report = await service.getReview('org')
    expect(report.findings).toEqual([])
    expect(report.history).toHaveLength(1)
  })
  it.each(['VIEWER', 'ACCOUNTANT'])(
    'nekar %s även om JWT-rollen skulle vara gammal',
    async (role) => {
      const { service, input, db } = setup()
      const dto = await input()
      db.user.findFirst.mockResolvedValue({ firstName: 'A', lastName: 'B', role })
      await expect(service.saveReview('org', 'user', dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(db.meterReadingReview.create).not.toHaveBeenCalled()
    },
  )
  it('nekar användare utanför organisationen eller inaktiv användare', async () => {
    const { service, input, db } = setup()
    const dto = await input()
    db.user.findFirst.mockResolvedValue(null)
    await expect(service.saveReview('org', 'outsider', dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
  it('nekar ändrat fingeravtryck eller varning i annan organisation', async () => {
    const { service, input, db } = setup()
    const dto = await input()
    await expect(
      service.saveReview('org', 'user', { ...dto, fingerprint: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(ConflictException)
    db.meterReading.findMany.mockResolvedValue([])
    await expect(service.saveReview('other', 'user', dto)).rejects.toBeInstanceOf(ConflictException)
    expect(db.meterReadingReview.create).not.toHaveBeenCalled()
  })
  it('nekar gammal revision utan att skriva över', async () => {
    const { service, input, db } = setup()
    const dto = await input()
    await service.saveReview('org', 'user', dto)
    await expect(service.saveReview('org', 'user', dto)).rejects.toBeInstanceOf(ConflictException)
    expect(db.meterReadingReview.create).toHaveBeenCalledTimes(1)
  })
  it.each(['P2002', 'P2034'])('översätter tävlingskonflikten %s till 409', async (code) => {
    const { service, input, db } = setup()
    const dto = await input()
    db.meterReadingReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('race', { code, clientVersion: '5.22.0' }),
    )
    await expect(service.saveReview('org', 'user', dto)).rejects.toBeInstanceOf(ConflictException)
  })
  it('döljer inte okända databasfel', async () => {
    const { service, input, db } = setup()
    const dto = await input()
    db.meterReadingReview.create.mockRejectedValue(new Error('offline'))
    await expect(service.saveReview('org', 'user', dto)).rejects.toThrow('offline')
  })
})

describe('DTO genom produktionspipen', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
  const valid = {
    readingId: '11111111-1111-4111-8111-111111111111',
    findingCode: 'HIGH_RATE',
    fingerprint: 'a'.repeat(64),
    expectedRevision: 0,
    assessment: 'EXPLAINED',
    comment: 'Kontrollerat',
  }
  const parse = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: SaveReadingReviewDto })
  it('accepterar samma kropp', async () => {
    expect(SaveReadingReviewSchema.safeParse(valid).success).toBe(true)
    await expect(parse(valid)).resolves.toMatchObject(valid)
  })
  it.each([
    { expectedRevision: '0' },
    { comment: '   ' },
    { comment: '😀'.repeat(501) },
    { comment: 'x'.repeat(1000) + '\n' },
    { fingerprint: 'a'.repeat(64) + '\n' },
    { assessment: 'APPROVED' },
    { reviewedById: 'spoof' },
    { comment: 42 },
    { fingerprint: 'x' },
    { expectedRevision: 2147483647 },
  ])('avvisar samma ogiltiga kropp %j', async (extra) => {
    const body = { ...valid, ...extra }
    expect(SaveReadingReviewSchema.safeParse(body).success).toBe(false)
    await expect(parse(body)).rejects.toThrow()
  })
})
