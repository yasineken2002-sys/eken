import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { ReadingReviewService } from './reading-review.service'
import { PrismaService } from '../common/prisma/prisma.service'
import type { SaveReadingReviewInput } from '@eken/shared'
import { getConsumptionReview } from '../ai/tools/consumption-review'

const hasDb = Boolean(process.env.DATABASE_URL)
it('DB-provet kräver en riktig databas', () => expect(hasDb).toBe(true))
;(hasDb ? describe : describe.skip)('bedömningshistorik i Postgres', () => {
  const db = new PrismaClient()
  const service = new ReadingReviewService(db as unknown as PrismaService)
  let orgId: string, otherOrgId: string, userId: string, meterId: string, unitId: string
  let original: SaveReadingReviewInput
  beforeAll(async () => {
    const suffix = randomUUID()
    const org = await db.organization.create({
      data: {
        name: 'Review ' + suffix,
        email: suffix + '@example.test',
        street: 'Test',
        city: 'Test',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const other = await db.organization.create({
      data: {
        name: 'Other ' + suffix,
        email: 'other-' + suffix + '@example.test',
        street: 'Test',
        city: 'Test',
        postalCode: '11111',
      },
    })
    otherOrgId = other.id
    const user = await db.user.create({
      data: {
        organizationId: orgId,
        email: 'user-' + suffix + '@example.test',
        firstName: 'Ada',
        lastName: 'Test',
        role: 'MANAGER',
      },
    })
    userId = user.id
    const property = await db.property.create({
      data: {
        organizationId: orgId,
        name: 'Test',
        propertyDesignation: suffix,
        type: 'RESIDENTIAL',
        street: 'Test',
        city: 'Test',
        postalCode: '11111',
        totalArea: 50,
      },
    })
    const unit = await db.unit.create({
      data: {
        propertyId: property.id,
        name: 'Test',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 1000,
      },
    })
    unitId = unit.id
    const meter = await db.meter.create({
      data: { organizationId: orgId, unitId, type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
    })
    meterId = meter.id
    for (const [i, value] of [10, 10, 10, 40].entries())
      await db.meterReading.create({
        data: {
          organizationId: orgId,
          meterId,
          unitId,
          value,
          readingType: 'PERIOD_VOLUME',
          readingDate: new Date(Date.UTC(2026, 0, i + 1)),
          periodStart: new Date(Date.UTC(2026, 0, i + 1)),
          periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
          source: 'MANUAL',
        },
      })
    const finding = (await service.getReview(orgId)).findings[0]!
    original = {
      readingId: finding.readingId,
      findingCode: finding.code,
      fingerprint: finding.fingerprint,
      expectedRevision: 0,
      assessment: 'EXPLAINED',
      comment: 'Kontrollerat underlag',
    }
  })
  afterAll(async () => {
    if (orgId) {
      await db.meterReading.deleteMany({ where: { organizationId: orgId } })
      await db.meter.deleteMany({ where: { organizationId: orgId } })
      await db.property.deleteMany({ where: { organizationId: orgId } })
      await db.organization.delete({ where: { id: orgId } })
    }
    if (otherOrgId) await db.organization.delete({ where: { id: otherOrgId } })
    await db.$disconnect()
  })
  it('sparar, läser om och bevarar originalunderlaget', async () => {
    const saved = await service.saveReview(orgId, userId, original)
    const reopened = new ReadingReviewService(db as unknown as PrismaService)
    expect((await reopened.getReview(orgId)).history[0]).toMatchObject({
      id: saved.id,
      revision: 1,
      reviewedByName: 'Ada Test',
      evidence: { code: 'HIGH_RATE' },
    })
  })
  it('låter exakt en av två samtidiga bedömningar få nästa revision', async () => {
    const outcomes = await Promise.allSettled([
      service.saveReview(orgId, userId, {
        ...original,
        expectedRevision: 1,
        comment: 'Bedömning A',
      }),
      service.saveReview(orgId, userId, {
        ...original,
        expectedRevision: 1,
        comment: 'Bedömning B',
      }),
    ])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const failure = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect(failure.reason.getStatus()).toBe(409)
    expect(await db.meterReadingReview.count({ where: { organizationId: orgId } })).toBe(2)
  })
  it('assistenten läser samma verkliga underlag utan domänskrivning eller org-läckage', async () => {
    const report = await service.getReview(orgId)
    const tool = await getConsumptionReview(db, orgId, 'VIEWER', {})
    expect(tool.data.findings[0]).toMatchObject({
      fingerprint: report.findings[0]!.fingerprint,
      sourceReadings: report.findings[0]!.sourceReadings,
      latestAssessment: { revision: 2, appliesToCurrentEvidence: true },
      meter: { id: meterId, unitId },
    })
    const other = await getConsumptionReview(db, otherOrgId, 'VIEWER', {})
    expect(other.data.findings).toEqual([])
    expect(other.data.summary).toMatchObject({ readings: 0, reviewHistoryCount: 0 })
    expect(await db.meterReadingReview.count({ where: { organizationId: orgId } })).toBe(2)
    expect(await db.meterReading.count({ where: { organizationId: orgId } })).toBe(4)
    expect(await db.consumptionCharge.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.journalEntry.count({ where: { organizationId: orgId } })).toBe(0)
  })
  it('nekar en annan organisations aktör och lämnar dess rapport tom', async () => {
    await expect(service.saveReview(otherOrgId, userId, original)).rejects.toMatchObject({
      status: 403,
    })
    expect((await service.getReview(otherOrgId)).history).toEqual([])
  })
  it('DB binder avläsningen till samma organisation även vid direkt felaktig skrivning', async () => {
    const source = await db.meterReadingReview.findFirstOrThrow({
      where: { organizationId: orgId },
    })
    await expect(
      db.meterReadingReview.create({
        data: {
          ...source,
          evidence: source.evidence as Prisma.InputJsonValue,
          id: randomUUID(),
          organizationId: otherOrgId,
          revision: 99,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
  })
  it('DB avvisar omskrivning av tidigare bedömning', async () => {
    const saved = await db.meterReadingReview.findFirstOrThrow({ where: { organizationId: orgId } })
    await expect(
      db.$executeRaw`UPDATE "MeterReadingReview" SET "comment" = 'ändrad' WHERE "id" = ${saved.id}`,
    ).rejects.toThrow(/append-only/)
  })
  it('ändrat underlag stoppar gammalt beslut men raderar inte historiken', async () => {
    await db.meterReading.create({
      data: {
        organizationId: orgId,
        meterId,
        unitId,
        value: 41,
        readingType: 'PERIOD_VOLUME',
        readingDate: new Date('2026-01-04'),
        periodStart: new Date('2026-01-04'),
        periodEnd: new Date('2026-01-04'),
        source: 'MANUAL',
      },
    })
    await expect(
      service.saveReview(orgId, userId, { ...original, expectedRevision: 2 }),
    ).rejects.toMatchObject({ status: 409 })
    expect((await service.getReview(orgId)).history).toHaveLength(2)
    expect(await db.consumptionCharge.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.journalEntry.count({ where: { organizationId: orgId } })).toBe(0)
  })
  it('underlagsradering för organisationsstädning kaskaderar historiken', async () => {
    await db.meterReading.deleteMany({ where: { organizationId: orgId } })
    expect(await db.meterReadingReview.count({ where: { organizationId: orgId } })).toBe(0)
  })
})
