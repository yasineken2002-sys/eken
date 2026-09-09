import { getConsumptionFollowUp } from '../ai/tools/consumption-follow-up'
import { randomUUID } from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import {
  ReadingReviewFollowUpService,
  followUpNotificationId,
} from './reading-review-follow-up.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'

const hasDb = Boolean(process.env.DATABASE_URL)
it('uppföljningens DB-prov kräver en riktig databas', () => expect(hasDb).toBe(true))
;(hasDb ? describe : describe.skip)('automatisk uppföljning mot riktig Postgres', () => {
  const db = new PrismaClient()
  const sink = { report: jest.fn().mockResolvedValue(undefined) } as unknown as CronErrorSink
  const service = new ReadingReviewFollowUpService(db as unknown as PrismaService, sink)
  let orgId: string,
    otherOrgId: string,
    ownerId: string,
    managerId: string,
    inactiveId: string,
    viewerId: string
  beforeAll(async () => {
    const suffix = randomUUID()
    const orgData = {
      name: 'Follow up ' + suffix,
      email: suffix + '@example.test',
      street: 'Test',
      city: 'Test',
      postalCode: '11111',
    }
    orgId = (await db.organization.create({ data: orgData })).id
    otherOrgId = (
      await db.organization.create({ data: { ...orgData, email: 'other-' + orgData.email } })
    ).id
    for (const [role, active] of [
      ['OWNER', true],
      ['MANAGER', true],
      ['ADMIN', false],
      ['VIEWER', true],
    ] as const) {
      const user = await db.user.create({
        data: {
          organizationId: orgId,
          email: role + '-' + suffix + '@example.test',
          firstName: 'Test',
          lastName: role,
          role,
          isActive: active,
        },
      })
      if (role === 'OWNER') ownerId = user.id
      if (role === 'MANAGER') managerId = user.id
      if (role === 'ADMIN') inactiveId = user.id
      if (role === 'VIEWER') viewerId = user.id
    }
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
    const meter = await db.meter.create({
      data: { organizationId: orgId, unitId: unit.id, type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
    })
    for (const [i, value] of [10, 10, 10, 40].entries())
      await db.meterReading.create({
        data: {
          organizationId: orgId,
          meterId: meter.id,
          unitId: unit.id,
          value,
          readingType: 'PERIOD_VOLUME',
          source: 'MANUAL',
          readingDate: new Date(Date.UTC(2026, 0, i + 1)),
          periodStart: new Date(Date.UTC(2026, 0, i + 1)),
          periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
        },
      })
  })
  beforeEach(async () => {
    await db.notification.deleteMany({ where: { organizationId: orgId } })
    await service.update(orgId, ownerId, { enabled: false })
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
  it('nya organisationer har AV som DB-default och påverkas inte av cron', async () => {
    expect(await service.getStatus(otherOrgId)).toEqual({
      enabled: false,
      enabledAt: null,
      lastCheckedAt: null,
      lastFailedAt: null,
    })
    await service.checkOrganization(otherOrgId)
    expect(await db.notification.count({ where: { organizationId: otherOrgId } })).toBe(0)
    expect((await service.getStatus(otherOrgId)).lastCheckedAt).toBeNull()
  })
  it('assistenten läser samma status som API:t, isolerar organisationer och skriver ingenting', async () => {
    await service.update(orgId, ownerId, { enabled: true })
    await service.checkOrganization(orgId)
    const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } })
    const notices = await db.notification.findMany({
      where: { organizationId: orgId },
      orderBy: { id: 'asc' },
    })
    const result = await getConsumptionFollowUp(db, orgId, 'VIEWER', {})
    expect(result.data.status).toEqual(await service.getStatus(orgId))
    expect(result.data.state).toBe('checked')
    expect(result.data.humanPath.canChangeSetting).toBe(false)
    const other = await getConsumptionFollowUp(db, otherOrgId, 'OWNER', {})
    expect(other.data.status).toEqual({
      enabled: false,
      enabledAt: null,
      lastCheckedAt: null,
      lastFailedAt: null,
    })
    await expect(
      getConsumptionFollowUp(db, orgId, 'OWNER', { organizationId: otherOrgId }),
    ).rejects.toMatchObject({ status: 400 })
    expect(await db.organization.findUniqueOrThrow({ where: { id: orgId } })).toEqual(before)
    expect(
      await db.notification.findMany({ where: { organizationId: orgId }, orderBy: { id: 'asc' } }),
    ).toEqual(notices)
    expect(await db.meterReading.count({ where: { organizationId: orgId } })).toBe(4)
    expect(await db.meterReadingReview.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.consumptionCharge.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.invoice.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.journalEntry.count({ where: { organizationId: orgId } })).toBe(0)
  })
  it('två samtidiga körningar och återförsök ger en notis per aktiv ansvarig, utan domänskrivning', async () => {
    await service.update(orgId, ownerId, { enabled: true })
    await Promise.all([service.checkOrganization(orgId), service.checkOrganization(orgId)])
    await service.checkOrganization(orgId)
    const notices = await db.notification.findMany({ where: { organizationId: orgId } })
    expect(notices.map((n) => n.userId).sort()).toEqual([ownerId, managerId].sort())
    expect(notices.every((n) => n.message.includes('1 varning behövde bedömas'))).toBe(true)
    expect(notices.some((n) => [inactiveId, viewerId].includes(n.userId))).toBe(false)
    expect(await db.notification.count({ where: { organizationId: otherOrgId } })).toBe(0)
    expect((await service.getStatus(orgId)).lastCheckedAt).not.toBeNull()
    expect(await db.meterReading.count({ where: { organizationId: orgId } })).toBe(4)
    expect(await db.meterReadingReview.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.consumptionCharge.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.journalEntry.count({ where: { organizationId: orgId } })).toBe(0)
    expect(await db.invoice.count({ where: { organizationId: orgId } })).toBe(0)
  })
  it('fel efter infogad notis rullar tillbaka hela transaktionen, och nästa försök kan lyckas', async () => {
    await service.update(orgId, ownerId, { enabled: true })
    let failOnce = true
    // Endast felinjektion. Infogningen och rollback körs i RIKTIG Postgres.
    const proxy = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction')
          return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
            target.$transaction(async (tx) => {
              const wrapped = new Proxy(tx, {
                get(inner, field) {
                  if (field === 'notification')
                    return {
                      ...inner.notification,
                      createMany: async (args: Prisma.NotificationCreateManyArgs) => {
                        const result = await inner.notification.createMany(args)
                        if (failOnce) {
                          failOnce = false
                          throw new Error('after-notice')
                        }
                        return result
                      },
                    }
                  return Reflect.get(inner, field)
                },
              })
              return fn(wrapped)
            }, options)
        return Reflect.get(target, key)
      },
    })
    const failing = new ReadingReviewFollowUpService(proxy as unknown as PrismaService, sink)
    await expect(failing.checkOrganization(orgId)).rejects.toThrow('after-notice')
    const first = await db.notification.findMany({ where: { organizationId: orgId } })
    expect(first).toHaveLength(2)
    expect(first.every((n) => n.title.includes('misslyckades'))).toBe(true)
    const failed = await service.getStatus(orgId)
    expect(failed.lastCheckedAt).toBeNull()
    expect(failed.lastFailedAt).not.toBeNull()
    await service.checkOrganization(orgId)
    expect(await db.notification.count({ where: { organizationId: orgId } })).toBe(4)
    const recovered = await service.getStatus(orgId)
    expect(Date.parse(recovered.lastCheckedAt!)).toBeGreaterThanOrEqual(
      Date.parse(failed.lastFailedAt!),
    )
    expect(recovered.lastFailedAt).toBeNull()
    expect(
      await db.notification.findUnique({
        where: { id: followUpNotificationId(orgId, ownerId, new Date(), 'queue') },
      }),
    ).not.toBeNull()
  })
  it.each([false, true])(
    'avstängning under pågående läsning stoppar notis även efter återaktivering=%s',
    async (reenable) => {
      await service.update(orgId, ownerId, { enabled: true })
      let reached!: () => void, release!: () => void
      const reading = new Promise<void>((resolve) => {
        reached = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const proxy = new Proxy(db, {
        get(target, key) {
          if (key === 'meterReading')
            return {
              ...target.meterReading,
              findMany: async (args: Prisma.MeterReadingFindManyArgs) => {
                const result = await target.meterReading.findMany(args)
                reached()
                await gate
                return result
              },
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const slow = new ReadingReviewFollowUpService(proxy as unknown as PrismaService, sink)
      const running = slow.checkOrganization(orgId)
      try {
        await reading
        await service.update(orgId, ownerId, { enabled: false })
        if (reenable) await service.update(orgId, ownerId, { enabled: true })
      } finally {
        release()
      }
      await running
      expect(await db.notification.count({ where: { organizationId: orgId } })).toBe(0)
      expect((await service.getStatus(orgId)).lastCheckedAt).toBeNull()
    },
  )
  it('en annan organisations ägare och en degraderad aktör får inte ändra inställningen', async () => {
    await expect(service.update(otherOrgId, ownerId, { enabled: true })).rejects.toMatchObject({
      status: 403,
    })
    await expect(service.update(orgId, managerId, { enabled: true })).rejects.toMatchObject({
      status: 403,
    })
    await db.user.update({ where: { id: ownerId }, data: { role: 'VIEWER' } })
    try {
      await expect(service.update(orgId, ownerId, { enabled: true })).rejects.toMatchObject({
        status: 403,
      })
    } finally {
      await db.user.update({ where: { id: ownerId }, data: { role: 'OWNER' } })
    }
    expect((await service.getStatus(orgId)).enabled).toBe(false)
    expect((await service.getStatus(otherOrgId)).enabled).toBe(false)
  })
})
