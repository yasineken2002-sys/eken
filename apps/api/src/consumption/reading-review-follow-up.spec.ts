import { Prisma } from '@prisma/client'
import {
  ReadingReviewFollowUpService,
  followUpNotificationId,
} from './reading-review-follow-up.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { loadReadingReview } from './reading-review.query'

function setup(enabled = true) {
  const state = {
    consumptionReviewFollowUpEnabled: enabled,
    consumptionReviewFollowUpEnabledAt: new Date('2026-09-01T10:00:00Z'),
    consumptionReviewFollowUpCheckedAt: null as Date | null,
    consumptionReviewFollowUpErrorAt: null as Date | null,
    consumptionReviewFollowUpRevision: 1,
  }
  const rows = [10, 10, 10, 40].map((value, i) => ({
    id: 'r' + i,
    organizationId: 'org',
    meterId: 'meter',
    value: new Prisma.Decimal(value),
    readingType: 'PERIOD_VOLUME',
    periodStart: new Date(Date.UTC(2026, 0, i + 1)),
    periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
  }))
  const tx = {
    $queryRaw: jest.fn().mockImplementation(async () => [{ ...state }]),
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'owner' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'manager' }]),
    },
    notification: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    organization: {
      update: jest.fn().mockImplementation(async ({ data }) => {
        const { consumptionReviewFollowUpRevision: revision, ...fields } = data
        Object.assign(state, fields)
        if (revision) state.consumptionReviewFollowUpRevision += revision.increment
        return { ...state }
      }),
    },
  }
  const db = {
    organization: {
      findUnique: jest.fn().mockImplementation(async () => ({ ...state })),
      findMany: jest.fn().mockResolvedValue([{ id: 'org' }, { id: 'other' }]),
    },
    meterReading: { findMany: jest.fn().mockResolvedValue(rows) },
    meterReadingReview: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
  }
  const sink = { report: jest.fn().mockResolvedValue(undefined) }
  const service = new ReadingReviewFollowUpService(
    db as unknown as PrismaService,
    sink as unknown as CronErrorSink,
  )
  return { service, db, tx, state, sink, rows }
}

it('avstängd innebär ingen läsning av avläsningar och ingen notis', async () => {
  const { service, db, tx } = setup(false)
  await service.checkOrganization('org')
  expect(db.meterReading.findMany).not.toHaveBeenCalled()
  expect(tx.notification.createMany).not.toHaveBeenCalled()
})
it('läser alla perioder i organisationen före filtret och skriver bara samlad notis/status', async () => {
  const { service, db, tx, state } = setup()
  await service.checkOrganization('org')
  expect(db.meterReading.findMany.mock.calls[0]![0].where).toEqual({ organizationId: 'org' })
  expect(db.meterReadingReview.findMany.mock.calls[0]![0].where).toEqual({ organizationId: 'org' })
  expect(tx.user.findMany).toHaveBeenCalledWith({
    where: { organizationId: 'org', isActive: true, role: { in: ['OWNER', 'ADMIN', 'MANAGER'] } },
    select: { id: true },
  })
  const notice = tx.notification.createMany.mock.calls[0]![0]
  expect(notice).toMatchObject({
    skipDuplicates: true,
    data: [
      { organizationId: 'org', userId: 'manager', type: 'SYSTEM', link: '/consumption?tab=review' },
    ],
  })
  expect(notice.data[0].message).toContain('1 varning behövde bedömas')
  expect(JSON.stringify(notice)).not.toContain('meter')
  expect(state.consumptionReviewFollowUpCheckedAt).toBeInstanceOf(Date)
  expect(state.consumptionReviewFollowUpErrorAt).toBeNull()
})
it.each(['EXPLAINED', 'CONFIRMED'])(
  'bedömt %s lämnas kvar i underlaget men ger ingen ny påminnelse',
  async (assessment) => {
    const { service, db, tx, state } = setup()
    const report = await loadReadingReview('org', db as unknown as PrismaService)
    const { reviews: _reviews, fingerprint, ...evidence } = report.findings[0]!
    void _reviews
    db.meterReadingReview.findMany.mockResolvedValue([
      {
        id: 'review',
        readingId: evidence.readingId,
        findingCode: evidence.code,
        fingerprint,
        revision: 1,
        assessment,
        comment: 'Test',
        reviewedByName: 'Test',
        createdAt: new Date(),
        evidence,
      },
    ])
    await service.checkOrganization('org')
    expect(tx.notification.createMany).not.toHaveBeenCalled()
    expect(state.consumptionReviewFollowUpCheckedAt).toBeInstanceOf(Date)
    expect(db.meterReadingReview.findMany).toHaveBeenCalled()
  },
)
it('nyare ändrat underlag får en notis även om ett äldre fingeravtryck var bedömt', async () => {
  const { service, db, tx } = setup()
  const report = await loadReadingReview('org', db as unknown as PrismaService)
  const finding = report.findings[0]!
  db.meterReadingReview.findMany.mockResolvedValue([
    {
      id: 'review',
      readingId: finding.readingId,
      findingCode: finding.code,
      fingerprint: 'old',
      revision: 1,
      assessment: 'EXPLAINED',
      comment: 'Test',
      reviewedByName: 'Test',
      createdAt: new Date(),
      evidence: finding,
    },
  ])
  await service.checkOrganization('org')
  expect(tx.notification.createMany).toHaveBeenCalledTimes(1)
})
it('ingen avläsning ger genomförd kontroll utan falsk allt-klart-notis', async () => {
  const { service, db, tx, state } = setup()
  db.meterReading.findMany.mockResolvedValue([])
  await service.checkOrganization('org')
  expect(tx.notification.createMany).not.toHaveBeenCalled()
  expect(state.consumptionReviewFollowUpCheckedAt).toBeInstanceOf(Date)
})
it('ett fel får egen felnotis och felstämpel, aldrig en lyckad kontroll', async () => {
  const { service, db, tx, state } = setup()
  db.meterReading.findMany.mockRejectedValue(new Error('read failed'))
  await expect(service.checkOrganization('org')).rejects.toThrow('read failed')
  expect(tx.notification.createMany.mock.calls[0]![0].data[0].title).toContain('misslyckades')
  expect(state.consumptionReviewFollowUpCheckedAt).toBeNull()
  expect(state.consumptionReviewFollowUpErrorAt).toBeInstanceOf(Date)
})
it('även fel vid lagring av felnotisen når den varaktiga sänkan', async () => {
  const { service, db, tx, sink } = setup()
  db.meterReading.findMany.mockRejectedValue(new Error('read failed'))
  tx.notification.createMany.mockRejectedValue(new Error('write failed'))
  await expect(service.checkOrganization('org')).rejects.toThrow('read failed')
  expect(sink.report).toHaveBeenCalledWith(
    'consumption-review-follow-up',
    expect.objectContaining({ message: 'write failed' }),
    { organizationId: 'org', detail: { stage: 'failure-status' } },
  )
})
it('ett per-org-fel stoppar inte nästa organisation och rapporteras med org-kontext', async () => {
  const { service, db, sink } = setup()
  const check = jest
    .spyOn(service, 'checkOrganization')
    .mockRejectedValueOnce(new Error('first'))
    .mockResolvedValueOnce(undefined)
  await service.followUpDaily()
  expect(db.organization.findMany).toHaveBeenCalledWith({
    where: { consumptionReviewFollowUpEnabled: true },
    select: { id: true },
  })
  expect(check.mock.calls).toEqual([['org'], ['other']])
  expect(sink.report).toHaveBeenCalledWith('consumption-review-follow-up', expect.any(Error), {
    organizationId: 'org',
  })
})
it('cronets första query-fel når sänkan', async () => {
  const { service, db, sink } = setup()
  db.organization.findMany.mockRejectedValue(new Error('start'))
  await service.followUpDaily()
  expect(sink.report).toHaveBeenCalledWith(
    'consumption-review-follow-up',
    expect.objectContaining({ message: 'start' }),
  )
})
it('stoppar både avstängning och av/på-cykel medan underlaget läses', async () => {
  for (const cycle of [false, true]) {
    const { service, db, tx, state } = setup()
    db.meterReadingReview.findMany.mockImplementation(async () => {
      state.consumptionReviewFollowUpEnabled = cycle
      state.consumptionReviewFollowUpRevision += cycle ? 2 : 1
      return []
    })
    await service.checkOrganization('org')
    expect(tx.notification.createMany).not.toHaveBeenCalled()
    expect(tx.organization.update).not.toHaveBeenCalled()
  }
})
it('gammalt resultat får inte skriva över en nyare kontroll', async () => {
  const { service, db, tx, state } = setup()
  db.meterReadingReview.findMany.mockImplementation(async () => {
    state.consumptionReviewFollowUpCheckedAt = new Date(Date.now() + 60_000)
    return []
  })
  await service.checkOrganization('org')
  expect(tx.organization.update).not.toHaveBeenCalled()
  expect(tx.notification.createMany).not.toHaveBeenCalled()
})
it('uppdatering kräver en aktuell aktiv ägare i sessionens organisation', async () => {
  const { service, tx } = setup(false)
  tx.user.findFirst.mockResolvedValue(null)
  await expect(service.update('org', 'user', { enabled: true })).rejects.toMatchObject({
    status: 403,
  })
  expect(tx.user.findFirst).toHaveBeenCalledWith({
    where: { id: 'user', organizationId: 'org', isActive: true, role: 'OWNER' },
    select: { id: true },
  })
  expect(tx.organization.update).not.toHaveBeenCalled()
})
it('identiskt PATCH-återförsök bevarar kontrollhistorik och revisionsnummer', async () => {
  const { service, tx, state } = setup(false)
  await service.update('org', 'owner', { enabled: true })
  const enabledAt = state.consumptionReviewFollowUpEnabledAt
  state.consumptionReviewFollowUpCheckedAt = new Date()
  await service.update('org', 'owner', { enabled: true })
  expect(tx.organization.update).toHaveBeenCalledTimes(1)
  expect(state.consumptionReviewFollowUpRevision).toBe(2)
  expect(state.consumptionReviewFollowUpEnabledAt).toEqual(enabledAt)
  expect(state.consumptionReviewFollowUpCheckedAt).not.toBeNull()
})
it('notisidentiteten följer Stockholms kalenderdag, även kring sommar/vintertid', () => {
  const id = (date: string, kind: 'queue' | 'error' = 'queue') =>
    followUpNotificationId('org', 'user', new Date(date), kind)
  expect(id('2026-09-09T21:59:59Z')).not.toBe(id('2026-09-09T22:00:00Z'))
  expect(id('2026-10-25T00:30:00Z')).toBe(id('2026-10-25T01:30:00Z'))
  expect(id('2026-10-25T22:59:59Z')).not.toBe(id('2026-10-25T23:00:00Z'))
  expect(id('2026-09-09T10:00:00Z')).not.toBe(id('2026-09-09T10:00:00Z', 'error'))
  expect(followUpNotificationId('other', 'user', new Date('2026-09-09'), 'queue')).not.toBe(
    id('2026-09-09'),
  )
  expect(followUpNotificationId('org', 'other', new Date('2026-09-09'), 'queue')).not.toBe(
    id('2026-09-09'),
  )
})
