/** Calendar-day effects against real PostgreSQL; external delivery is never invoked. */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { PassportModule } from '@nestjs/passport'
import { JwtService } from '@nestjs/jwt'
import { JwtStrategy } from '../auth/strategies/jwt.strategy'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { TransformInterceptor } from '../common/interceptors/transform.interceptor'
import { PrismaService } from '../common/prisma/prisma.service'
import { TenantPortalController } from '../tenant-portal/tenant-portal.controller'
import { TenantPortalService } from '../tenant-portal/tenant-portal.service'
import { TenantAuthService } from '../tenant-portal/tenant-auth.service'
import { TenantAuthGuard } from '../tenant-portal/tenant-auth.guard'
import { AviseringController } from './avisering.controller'
import { PrismaClient, type RentNoticeStatus } from '@prisma/client'
import { AviseringService } from './avisering.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { OcrService } from '../common/ocr/ocr.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { RentReminderService } from './rent-reminder.service'
import { RentInterestService } from './rent-interest.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentDebtService } from './rent-debt.service'
import { swedishDateKey, rentNoticeDisplayStatus } from '@eken/shared'
import { NotificationsService } from '../notifications/notifications.service'

const hasDb = Boolean(process.env.DATABASE_URL)
it('requires a real database', () => expect(hasDb).toBe(true))
;(hasDb ? describe : describe.skip)('rent due calendar day', () => {
  const prisma = new PrismaClient()
  const orgIds: string[] = []
  let orgId: string
  let tenantId: string
  let leaseId: string
  let referenceRateId: string | undefined
  let sequence = 0
  const avisering = Object.assign(Object.create(AviseringService.prototype), {
    prisma,
  }) as AviseringService
  const accounting = new AccountingService(
    prisma as never,
    new VerifikationsnummerService(prisma as never),
  )
  const events = new RentNoticeEventsService(prisma as never)
  const freshness = new PaymentFreshnessService(
    prisma as never,
    { sendCustomEmail: jest.fn(), send: jest.fn() } as never,
  )
  const interest = new RentInterestService(prisma as never, accounting, events, freshness)
  const reminder = Object.assign(Object.create(RentReminderService.prototype), {
    pdfQueue: { enqueue: async () => 'synthetic-pdf-job' },
    prisma,
    accounting,
    freshness,
    rentInterest: interest,
    rentNoticeEvents: events,
    rentDebt: new RentDebtService(prisma as never),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    cronErrors: {
      report: async (error: unknown) => {
        throw error
      },
    },
  }) as RentReminderService
  Object.assign(avisering, {
    accounting,
    ocrService: new OcrService(prisma as never),
    consumption: { attachRentNoticeLineCharges: async () => 0 },
    miscCharges: { attachMiscChargesToRentNotice: async () => 0 },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  })
  const notifications = Object.assign(Object.create(NotificationsService.prototype), {
    prisma,
    logger: { log: () => undefined },
    cronErrors: {
      report: async (e: unknown) => {
        throw e
      },
    },
  }) as NotificationsService

  beforeAll(async () => {
    // Egen syntetisk ränta: provet får inte bero på migrationsseedens belopp.
    const rate = await prisma.referenceInterestRate.create({
      data: {
        effectiveFrom: new Date('2026-09-24'),
        ratePercent: 2,
        source: 'synthetic Swedish calendar test',
      },
    })
    referenceRateId = rate.id
    const suffix = randomUUID()
    for (const name of ['own', 'other']) {
      const org = await prisma.organization.create({
        data: {
          name: `calendar-${name}-${suffix}`,
          email: `${name}-${suffix}@example.test`,
          street: 'Testgatan 1',
          city: 'Teststad',
          postalCode: '11111',
          orgNumber: `${name}-${suffix}`,
          bankgiro: '5050-1055',
          remindersEnabled: true,
          rentReminderDay: 1,
          rentInkassoDaysAfterReminder: 14,
          paymentDataThrough: new Date('2026-09-24'),
        },
      })
      orgIds.push(org.id)
    }
    orgId = orgIds[0]!
    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyra', type: 'REVENUE' },
        { organizationId: orgId, number: 3593, name: 'Påminnelseavgift', type: 'REVENUE' },
        { organizationId: orgId, number: 8131, name: 'Ränta', type: 'REVENUE' },
      ],
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        email: `${suffix}@example.test`,
        firstName: 'Alva',
        lastName: 'Test',
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11111',
      },
    })
    tenantId = tenant.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: 'Testgård',
        propertyDesignation: suffix,
        type: 'RESIDENTIAL',
        street: 'Testgatan 1',
        city: 'Teststad',
        postalCode: '11111',
        totalArea: 100,
      },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: property.id,
        name: 'Lgh 1',
        unitNumber: '1',
        type: 'APARTMENT',
        area: 50,
        rooms: 2,
        monthlyRent: 9000,
      },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        tenantId,
        unitId: unit.id,
        contractNumber: suffix,
        monthlyRent: 9000,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        reminderFeeTermsFrom: new Date('2025-01-01'),
        status: 'ACTIVE',
      },
    })
    leaseId = lease.id
  })

  afterEach(async () => {
    jest.useRealTimers()
    const noticeIds = (
      await prisma.rentNotice.findMany({
        where: { organizationId: { in: orgIds } },
        select: { id: true },
      })
    ).map((n) => n.id)
    await prisma.rentNoticeEvent.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
    await prisma.rentNoticeSend.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
    await prisma.rentNoticeCredit.deleteMany({ where: { rentNoticeId: { in: noticeIds } } })
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: { in: orgIds } } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.rentNotice.deleteMany({ where: { organizationId: { in: orgIds } } })
  })
  afterAll(async () => {
    await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.account.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.lease.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.unit.deleteMany({ where: { property: { organizationId: { in: orgIds } } } })
    await prisma.property.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.tenant.deleteMany({ where: { organizationId: { in: orgIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    if (referenceRateId) {
      await prisma.referenceInterestRate.delete({ where: { id: referenceRateId } })
    }
    await prisma.$disconnect()
  })

  async function notice(
    status: RentNoticeStatus = 'SENT',
    dueDate = '2026-09-23T00:00:00Z',
    organizationId = orgId,
  ) {
    const n = sequence++
    return prisma.rentNotice.create({
      data: {
        organizationId,
        tenantId,
        leaseId,
        noticeNumber: `CAL-${n}`,
        ocrNumber: `123${n}`,
        year: 2026 + Math.floor(n / 12),
        month: (n % 12) + 1,
        amount: 9000,
        totalAmount: 9000,
        dueDate: new Date(dueDate),
        status,
        periodStart: new Date('2026-09-01'),
      },
    })
  }

  it.each([
    ['day before', '2026-09-22T12:00:00Z', 'SENT'],
    ['due day noon', '2026-09-23T12:00:00Z', 'SENT'],
    ['last Swedish second', '2026-09-23T21:59:59Z', 'SENT'],
    ['next Swedish day, still same UTC day', '2026-09-23T22:00:00Z', 'OVERDUE'],
  ])('list and statistics: %s', async (_label, now, expected) => {
    const n = await notice()
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date(now))
    const rows = await avisering.findAll(orgId)
    expect(rows.find((r) => r.id === n.id)?.status).toBe(expected)
    const stats = await avisering.getStats(orgId, n.month, n.year)
    expect(stats.overdue).toBe(expected === 'OVERDUE' ? 1 : 0)
  })

  it('scheduler preserves the whole due day and marks it next Swedish day', async () => {
    const n = await notice()
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date('2026-09-23T12:00:00Z'))
    await notifications.markOverdueRentNotices()
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT')
    jest.setSystemTime(new Date('2026-09-23T22:00:00Z'))
    await notifications.markOverdueRentNotices()
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })).status).toBe(
      'OVERDUE',
    )
  })

  it('list leaves paid, cancelled and other organization unchanged', async () => {
    const paid = await notice('PAID')
    const cancelled = await notice('CANCELLED')
    const other = await notice('SENT', '2026-09-23T00:00:00Z', orgIds[1]!)
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date('2026-09-24T12:00:00Z'))
    await avisering.findAll(orgId)
    const saved = await prisma.rentNotice.findMany({
      where: { id: { in: [paid.id, cancelled.id, other.id] } },
    })
    expect(saved.map((r) => [r.id, r.status]).sort()).toEqual(
      [
        [paid.id, 'PAID'],
        [cancelled.id, 'CANCELLED'],
        [other.id, 'SENT'],
      ].sort(),
    )
  })

  it('payment between list read and status write is never overwritten', async () => {
    const n = await notice()
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date('2026-09-24T12:00:00Z'))
    const racing = prisma.$extends({
      query: {
        rentNotice: {
          async findMany({ args, query }) {
            const rows = await query(args)
            await prisma.rentNotice.update({ where: { id: n.id }, data: { status: 'PAID' } })
            return rows
          },
        },
      },
    })
    Object.assign(avisering, { prisma: racing })
    try {
      await avisering.checkAndMarkOverdue(orgId)
    } finally {
      Object.assign(avisering, { prisma })
    }
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('PAID')
  })

  it('no fee, interest or collection start on due day, including a legacy OVERDUE', async () => {
    const n = await notice('OVERDUE')
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date('2026-09-23T21:59:59Z'))
    expect(await reminder.escalateNoticeToReminded(n.id, orgId, 99, 60)).toBe(false)
    expect(await interest.crystallizeInterest(n.id, orgId, new Date())).toBeNull()
    const cron = await reminder.escalateOverdueRentNotices()
    expect(cron).toMatchObject({ reminded: 0, errors: 0 })
    expect(await prisma.journalEntry.count({ where: { organizationId: orgId } })).toBe(0)
    const saved = await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })
    expect(saved.collectionStage).toBe('NONE')
    expect(Number(saved.reminderFeeAmount)).toBe(0)
    expect(Number(saved.interestAccruedAmount)).toBe(0)
  })

  it('first Swedish day overdue can charge once with balanced accounting, paid/cancelled cannot', async () => {
    const n = await notice('OVERDUE')
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date('2026-09-23T22:00:00Z'))
    expect(await reminder.escalateNoticeToReminded(n.id, orgId, 1, 60)).toBe(true)
    expect(await reminder.escalateNoticeToReminded(n.id, orgId, 1, 60)).toBe(false)
    const rows = await prisma.journalEntry.findMany({
      where: { organizationId: orgId },
      include: { lines: true },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.lines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0)).toBe(0)
    expect(
      (
        await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })
      ).reminderFeeAmount.toNumber(),
    ).toBe(60)
    for (const status of ['PAID', 'CANCELLED'] as const) {
      const closed = await notice(status)
      expect(await reminder.escalateNoticeToReminded(closed.id, orgId, 1, 60)).toBe(false)
      expect(await interest.crystallizeInterest(closed.id, orgId, new Date())).toBeNull()
    }
  })

  it('cron books fee and one day of interest only after midnight and fresh bank data', async () => {
    const n = await notice('OVERDUE')
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date('2026-09-23T22:00:00Z'))
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: new Date('2026-09-01') },
    })
    expect(await reminder.escalateOverdueRentNotices()).toMatchObject({
      reminded: 0,
      pausedStale: 1,
      errors: 0,
    })
    expect(await prisma.journalEntry.count({ where: { organizationId: orgId } })).toBe(0)
    await prisma.organization.update({
      where: { id: orgId },
      data: { paymentDataThrough: new Date('2026-09-24') },
    })
    expect(await reminder.escalateOverdueRentNotices()).toMatchObject({ reminded: 1, errors: 0 })
    const saved = await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })
    expect(saved.collectionStage).toBe('REMINDED')
    expect(saved.reminderFeeAmount.toNumber()).toBe(60)
    expect(saved.interestAccruedAmount.toNumber()).toBe(2.47)
    const rows = await prisma.journalEntry.findMany({
      where: { organizationId: orgId },
      include: { lines: true },
    })
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row.lines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0)).toBe(0)
    const event = await prisma.rentNoticeEvent.findFirstOrThrow({
      where: { rentNoticeId: n.id, type: 'INTEREST_ACCRUED' },
    })
    expect(event.payload).toMatchObject({
      days: 1,
      segments: [{ from: '2026-09-24', to: '2026-09-24', days: 1 }],
    })
  })

  it.each([
    ['2026-01-31T00:00:00Z', '2026-01-31T22:59:59Z', '2026-01-31T23:00:00Z'],
    ['2026-03-29T00:00:00Z', '2026-03-29T21:59:59Z', '2026-03-29T22:00:00Z'],
    ['2026-10-24T22:00:00Z', '2026-10-25T22:59:59Z', '2026-10-25T23:00:00Z'],
    ['2026-12-31T00:00:00Z', '2026-12-31T22:59:59Z', '2026-12-31T23:00:00Z'],
  ])('DB boundary for %s at DST/month/year rollover', async (due, before, after) => {
    const n = await notice('SENT', due)
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
      .setSystemTime(new Date(before))
    await avisering.findAll(orgId)
    await notifications.markOverdueRentNotices()
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT')
    jest.setSystemTime(new Date(after))
    await notifications.markOverdueRentNotices()
    expect((await avisering.findAll(orgId)).find((r) => r.id === n.id)?.status).toBe('OVERDUE')
  })

  it('collection day and its status use Stockholm midnight at the existing 1+14-day threshold', async () => {
    const n = await notice('OVERDUE')
    await prisma.rentNotice.update({ where: { id: n.id }, data: { collectionStage: 'REMINDED' } })
    const before = new Date('2026-10-07T21:59:59Z')
    const after = new Date('2026-10-07T22:00:00Z')
    expect((await reminder.collectionStatus(n.id, orgId, before)).daysOverdue).toBe(14)
    expect(await reminder.escalateNoticeToInkassoReady(n.id, orgId, before)).toMatchObject({
      flipped: false,
      tooEarly: true,
    })
    expect((await reminder.collectionStatus(n.id, orgId, after)).daysOverdue).toBe(15)
    // Day gate now permits evaluation; missing delivery evidence still blocks.
    await expect(reminder.escalateNoticeToInkassoReady(n.id, orgId, after)).rejects.toThrow(
      'ofullständigt underlag',
    )
    expect(
      (await prisma.rentNotice.findUniqueOrThrow({ where: { id: n.id } })).collectionStage,
    ).toBe('REMINDED')
  })

  it.each([
    [10, 2026, '2026-09-30'],
    [11, 2026, '2026-10-30'],
    [1, 2027, '2026-12-30'],
  ])(
    'preview %s/%s equals generated notice, PDF HTML and ledger',
    async (month, year, expected) => {
      const preview = await avisering.previewMonthlyNotices(orgId, month as number, year as number)
      expect(preview.toCreate).toBe(1)
      expect(preview.dueDates).toEqual([{ dueDate: expected, count: 1 }])
      expect(await prisma.rentNotice.count({ where: { organizationId: orgId } })).toBe(0)
      const generated = await avisering.generateMonthlyNotices(
        orgId,
        month as number,
        year as number,
      )
      expect(generated).toMatchObject({ created: 1, skipped: 0, failed: 0 })
      const saved = await prisma.rentNotice.findUniqueOrThrow({
        where: { id: generated.notices[0]!.id },
        include: {
          tenant: true,
          lease: { include: { unit: { include: { property: true } } } },
          lines: true,
          credits: true,
        },
      })
      expect(swedishDateKey(saved.dueDate)).toBe(expected)
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
      const html = await (
        avisering as unknown as { buildNoticePdfHtml(n: unknown, o: unknown): Promise<string> }
      ).buildNoticePdfHtml(saved, org)
      expect(html).toContain(`Förfallodatum: <strong>${expected}</strong>`)
      const again = await avisering.previewMonthlyNotices(orgId, month as number, year as number)
      expect(again).toMatchObject({
        toCreate: 0,
        dueDates: [],
        existingDueDates: [{ dueDate: expected, count: 1 }],
      })
      expect(
        (await avisering.generateMonthlyNotices(orgId, month as number, year as number)).created,
      ).toBe(0)
      expect(await prisma.journalEntry.count({ where: { organizationId: orgId } })).toBe(1)
    },
  )

  it('preview and generation share prorated EXPIRED coverage and exclude future/terminated leases', async () => {
    await prisma.lease.update({
      where: { id: leaseId },
      data: { status: 'EXPIRED', endDate: new Date('2026-10-15') },
    })
    try {
      expect(await avisering.previewMonthlyNotices(orgId, 10, 2026)).toMatchObject({
        toCreate: 1,
        dueDates: [{ dueDate: '2026-09-30', count: 1 }],
      })
      const generated = await avisering.generateMonthlyNotices(orgId, 10, 2026)
      expect(generated.created).toBe(1)
      expect(generated.notices[0]).toMatchObject({ daysCharged: 15, isProrated: true })
      expect(await avisering.previewMonthlyNotices(orgId, 11, 2026)).toMatchObject({
        toCreate: 0,
        dueDates: [],
      })
      await prisma.lease.update({ where: { id: leaseId }, data: { status: 'TERMINATED' } })
      expect(await avisering.previewMonthlyNotices(orgId, 9, 2026)).toMatchObject({
        toCreate: 0,
        dueDates: [],
      })
      await prisma.lease.update({
        where: { id: leaseId },
        data: { status: 'ACTIVE', startDate: new Date('2027-01-01'), endDate: null },
      })
      expect(await avisering.previewMonthlyNotices(orgId, 11, 2026)).toMatchObject({
        toCreate: 0,
        dueDates: [],
      })
    } finally {
      await prisma.lease.update({
        where: { id: leaseId },
        data: { status: 'ACTIVE', startDate: new Date('2026-01-01'), endDate: null },
      })
    }
  })

  it('preview separates existing dates and isolates the other organization', async () => {
    const n = await notice('SENT', '2026-10-15T00:00:00Z')
    const preview = await avisering.previewMonthlyNotices(orgId, n.month, n.year)
    expect(preview).toMatchObject({
      toCreate: 0,
      dueDates: [],
      existingDueDates: [{ dueDate: '2026-10-15', count: 1 }],
    })
    expect(await avisering.previewMonthlyNotices(orgIds[1]!, n.month, n.year)).toMatchObject({
      toCreate: 0,
      dueDates: [],
      existingDueDates: [],
    })
  })

  it('repeated preview preserves persisted rows, sequences and queue effects with existing notices in two organizations', async () => {
    // Generera först på riktigt: en tom tabell kan inte avslöja att preview
    // skriver över status/datum/belopp på en befintlig avi eller dess verifikat.
    const generated = await avisering.generateMonthlyNotices(orgId, 10, 2026)
    expect(generated.created).toBe(1)
    const ownNoticeId = generated.notices[0]!.id
    await prisma.rentNotice.update({
      where: { id: ownNoticeId },
      data: { status: 'SENT', dueDate: new Date('2026-10-15T00:00:00Z') },
    })

    const otherOrg = orgIds[1]!
    const otherTenant = await prisma.tenant.create({
      data: { organizationId: otherOrg, type: 'INDIVIDUAL', email: 'preview@example.test' },
    })
    const otherProperty = await prisma.property.create({
      data: {
        organizationId: otherOrg,
        name: 'Preview annan org',
        propertyDesignation: randomUUID(),
        type: 'RESIDENTIAL',
        street: 'Testgatan 2',
        city: 'Teststad',
        postalCode: '11111',
        totalArea: 50,
      },
    })
    const otherUnit = await prisma.unit.create({
      data: {
        propertyId: otherProperty.id,
        name: 'Annan lägenhet',
        unitNumber: '2',
        type: 'APARTMENT',
        area: 50,
        monthlyRent: 7000,
      },
    })
    const otherLease = await prisma.lease.create({
      data: {
        organizationId: otherOrg,
        tenantId: otherTenant.id,
        unitId: otherUnit.id,
        contractNumber: randomUUID(),
        monthlyRent: 7000,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
    })
    await prisma.rentNotice.create({
      data: {
        organizationId: otherOrg,
        tenantId: otherTenant.id,
        leaseId: otherLease.id,
        noticeNumber: 'OTHER-PREVIEW',
        ocrNumber: '987654',
        month: 10,
        year: 2026,
        amount: 7000,
        totalAmount: 7000,
        dueDate: new Date('2026-10-20T00:00:00Z'),
        status: 'SENT',
      },
    })
    // Kögränsen observeras; ingen Redis eller leverantör får en leverans.
    const enqueue = jest.fn().mockResolvedValue('unexpected-preview-job')
    const previewService = Object.assign(Object.create(AviseringService.prototype), avisering, {
      pdfQueue: { enqueue },
    }) as AviseringService
    const scope = { organizationId: { in: orgIds } }
    const snapshot = async () => ({
      notices: await prisma.rentNotice.findMany({ where: scope, orderBy: { id: 'asc' } }),
      lines: await prisma.rentNoticeLine.findMany({
        where: { rentNotice: scope },
        orderBy: { id: 'asc' },
      }),
      journals: await prisma.journalEntry.findMany({
        where: scope,
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { id: 'asc' } } },
      }),
      sends: await prisma.rentNoticeSend.findMany({
        where: { rentNotice: scope },
        orderBy: { id: 'asc' },
      }),
      events: await prisma.rentNoticeEvent.findMany({
        where: { rentNotice: scope },
        orderBy: { id: 'asc' },
      }),
      noticeNumbers: await prisma.rentNoticeNumberSequence.findMany({
        where: scope,
        orderBy: [{ organizationId: 'asc' }, { year: 'asc' }, { month: 'asc' }],
      }),
      journalNumbers: await prisma.journalEntrySequence.findMany({
        where: scope,
        orderBy: [{ organizationId: 'asc' }, { fiscalYear: 'asc' }, { series: 'asc' }],
      }),
      ocrNumbers: await prisma.tenantOcrSequence.findMany({
        where: scope,
        orderBy: { organizationId: 'asc' },
      }),
      tenants: await prisma.tenant.findMany({ where: scope, orderBy: { id: 'asc' } }),
      organizations: await prisma.organization.findMany({
        where: { id: { in: orgIds } },
        orderBy: { id: 'asc' },
      }),
      queued: [...enqueue.mock.calls],
    })
    const before = await snapshot()
    expect(before.notices).toHaveLength(2)
    expect(before.journals).toHaveLength(1)
    expect(before.journals[0]!.lines).toHaveLength(2)
    expect(before.noticeNumbers.length).toBeGreaterThan(0)
    expect(before.ocrNumbers.length).toBeGreaterThan(0)
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await previewService.previewMonthlyNotices(orgId, 10, 2026)).toMatchObject({
        toCreate: 0,
        existingDueDates: [{ dueDate: '2026-10-15', count: 1 }],
      })
      expect(await previewService.previewMonthlyNotices(otherOrg, 10, 2026)).toMatchObject({
        toCreate: 0,
        existingDueDates: [{ dueDate: '2026-10-20', count: 1 }],
      })
      expect(await previewService.previewMonthlyNotices(orgId, 11, 2026)).toMatchObject({
        toCreate: 1,
        dueDates: [{ dueDate: '2026-10-30', count: 1 }],
        existingDueDates: [],
      })
      expect(await snapshot()).toEqual(before)
    }
    expect(enqueue).not.toHaveBeenCalled()
    // Positiv kontroll: samma mätning ser den verkliga skrivvägens effekt.
    expect((await previewService.generateMonthlyNotices(orgId, 11, 2026)).created).toBe(1)
    const afterGeneration = await snapshot()
    expect(afterGeneration.notices).toHaveLength(before.notices.length + 1)
    expect(afterGeneration.journals).toHaveLength(before.journals.length + 1)
    expect(afterGeneration.noticeNumbers).not.toEqual(before.noticeNumbers)
    expect(afterGeneration.journalNumbers).not.toEqual(before.journalNumbers)
    // Positiv kontroll för KÖN: samma tjänstinstans och snapshot ser sendNotices.
    // Enqueue stannar vid lokal attrapp; ingen worker eller extern leverantör startas.
    const toSend = afterGeneration.notices.find((row) => row.month === 11)!
    const sent = await previewService.sendNotices(orgId, [toSend.id])
    expect(sent.queued).toBe(1)
    expect((await snapshot()).queued).toEqual([
      [{ kind: 'avisering-send', organizationId: orgId, noticeId: toSend.id }],
    ])
    expect(Object.hasOwn(avisering, 'pdfQueue')).toBe(false)
  })

  it('HTTP list/detail/statistics and tenant sessions share real remaining debt without rewriting legacy rows', async () => {
    const auth = Object.assign(Object.create(TenantAuthService.prototype), {
      prisma,
    }) as TenantAuthService
    const portal = Object.assign(Object.create(TenantPortalService.prototype), {
      prisma,
    }) as TenantPortalService
    const secret = 'synthetic-t3-display-http-key'
    const jwt = new JwtService({ secret })
    const controllers = [AviseringController, TenantPortalController]
    const values = new Map<unknown, unknown>([
      [AviseringService, avisering],
      [TenantPortalService, portal],
      [PrismaService, prisma],
      [TenantAuthService, auth],
    ])
    const dependencies = new Set(
      controllers.flatMap(
        (controller) =>
          Reflect.getMetadata('design:paramtypes', controller) as Array<
            new (...args: never[]) => unknown
          >,
      ),
    )
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers,
      providers: [
        ...[...dependencies].map((provide) => ({ provide, useValue: values.get(provide) ?? {} })),
        { provide: TenantAuthService, useValue: auth },
        TenantAuthGuard,
        JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
      ],
    }).compile()
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.setGlobalPrefix('v1')
    app.useGlobalGuards(new JwtAuthGuard(new Reflector()), new RolesGuard(new Reflector()))
    app.useGlobalInterceptors(new TransformInterceptor())
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    )
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    const http = (url: string, token?: string) =>
      app.inject({
        method: 'GET',
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    const orgToken = (organizationId = orgId, role = 'VIEWER') =>
      jwt.sign({ sub: 'synthetic-viewer', organizationId, role })
    try {
      const baseLease = await prisma.lease.findUniqueOrThrow({ where: { id: leaseId } })
      const baseUnit = await prisma.unit.findUniqueOrThrow({ where: { id: baseLease.unitId } })
      const cases: Array<[string, RentNoticeStatus, string, number, number]> = [
        ['legacy-utc', 'OVERDUE', '2026-07-01T00:00:00Z', 4000, 0],
        ['legacy-stockholm', 'OVERDUE', '2026-06-30T22:00:00Z', 4000, 0],
        ['paid', 'PAID', '2026-07-01T00:00:00Z', 9000, 0],
        ['cancelled', 'CANCELLED', '2026-07-01T00:00:00Z', 0, 0],
        ['zero-paid', 'OVERDUE', '2026-07-01T00:00:00Z', 9000, 0],
        ['zero-credit', 'OVERDUE', '2026-07-01T00:00:00Z', 0, 9000],
      ]
      const ids: string[] = []
      for (const [name, status, dueDate, payment, credit] of cases) {
        const unit = await prisma.unit.create({
          data: {
            ...baseUnit,
            id: randomUUID(),
            unitNumber: randomUUID(),
            name,
          },
        })
        const lease = await prisma.lease.create({
          data: {
            ...baseLease,
            id: randomUUID(),
            contractNumber: randomUUID(),
            unitId: unit.id,
          },
        })
        const n = await prisma.rentNotice.create({
          data: {
            organizationId: orgId,
            tenantId,
            leaseId: lease.id,
            noticeNumber: name,
            ocrNumber: String(700001 + ids.length),
            month: 7,
            year: 2026,
            status,
            dueDate: new Date(dueDate),
            amount: 9000,
            totalAmount: 9000,
            // Avsiktligt fel cache: visningen måste läsa allokeringarna.
            paidAmount: 0,
            sentAt: new Date('2026-06-20T10:00:00Z'),
          },
        })
        ids.push(n.id)
        if (payment)
          await prisma.rentNoticePayment.create({
            data: {
              rentNoticeId: n.id,
              amount: payment,
              paidAt: new Date('2026-06-21'),
              source: 'MANUAL',
            },
          })
        if (credit)
          await prisma.rentNoticeCredit.create({
            data: {
              rentNoticeId: n.id,
              organizationId: orgId,
              amount: credit,
              reason: 'Syntetisk full kreditering för visningsprovet',
              creditedAt: new Date('2026-06-21'),
            },
          })
      }
      const ownSession = await auth.createSessionForTenant(tenantId)
      const otherTenant = await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          email: `${randomUUID()}@example.test`,
        },
      })
      const otherSession = await auth.createSessionForTenant(otherTenant.id)
      const snapshot = async () => ({
        notices: await prisma.rentNotice.findMany({
          where: { id: { in: ids } },
          orderBy: { id: 'asc' },
          include: { payments: true, credits: true, events: true, sends: true, lines: true },
        }),
        journals: await prisma.journalEntry.findMany({
          where: { organizationId: orgId },
          include: { lines: true },
        }),
        noticeNumbers: await prisma.rentNoticeNumberSequence.findMany({
          where: { organizationId: orgId },
        }),
        journalNumbers: await prisma.journalEntrySequence.findMany({
          where: { organizationId: orgId },
        }),
      })
      const before = await snapshot()
      const proof: unknown[] = []
      for (const [now, expectedOverdue] of [
        ['2026-07-01T21:59:59Z', 0],
        ['2026-07-01T22:00:00Z', 2],
      ] as const) {
        jest
          .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] })
          .setSystemTime(new Date(now))
        const webResponse = await http('/v1/avisering?month=7&year=2026', orgToken())
        const portalResponse = await http('/v1/portal/rent-notices', ownSession.sessionToken)
        const statsResponse = await http('/v1/avisering/stats/7/2026', orgToken())
        expect([
          webResponse.statusCode,
          portalResponse.statusCode,
          statsResponse.statusCode,
        ]).toEqual([200, 200, 200])
        const web = webResponse.json().data as Array<{
          id: string
          noticeNumber: string
          dueDate: string
          status: RentNoticeStatus
          payableTotal: number
        }>
        const tenant = portalResponse.json().data as typeof web
        expect(web).toHaveLength(6)
        expect(tenant).toHaveLength(5) // CANCELLED är inte en nåbar portalrad.
        expect(statsResponse.json().data.overdue).toBe(expectedOverdue)
        expect(web.filter((row) => rentNoticeDisplayStatus(row) === 'OVERDUE')).toHaveLength(
          expectedOverdue,
        )
        for (const row of web) {
          const detail = await http(`/v1/avisering/${row.id}`, orgToken(orgId, 'ACCOUNTANT'))
          expect(detail.statusCode).toBe(200)
          expect(detail.json().data.payableTotal).toBe(row.payableTotal)
          const n = tenant.find((item) => item.id === row.id)
          if (n) {
            expect(n.payableTotal).toBe(row.payableTotal)
            expect(rentNoticeDisplayStatus(n)).toBe(rentNoticeDisplayStatus(row))
          }
          expect(row).not.toHaveProperty('payments')
          expect(row).not.toHaveProperty('credits')
          expect(row).not.toHaveProperty('reminderPdfStorageKey')
          expect(row).not.toHaveProperty('reminderMessageId')
        }
        expect(
          web.filter((row) => row.noticeNumber.startsWith('legacy')).map((row) => row.payableTotal),
        ).toEqual([5000, 5000])
        expect(
          web.filter((row) => row.noticeNumber.startsWith('zero')).map((row) => row.payableTotal),
        ).toEqual([0, 0])
        expect((await http('/v1/avisering')).statusCode).toBe(401)
        expect((await http('/v1/portal/rent-notices')).statusCode).toBe(401)
        expect((await http(`/v1/avisering/${ids[0]}`, orgToken(orgIds[1]!))).statusCode).toBe(404)
        expect(
          (await http('/v1/avisering?month=7&year=2026', orgToken(orgIds[1]!))).json().data,
        ).toEqual([])
        expect(
          (await http('/v1/portal/rent-notices', otherSession.sessionToken)).json().data,
        ).toEqual([])
        expect(
          (await http(`/v1/portal/rent-notices/${ids[0]}/download`, otherSession.sessionToken))
            .statusCode,
        ).toBe(404)
        expect(await snapshot()).toEqual(before)
        proof.push({
          now,
          web: webResponse.json(),
          portal: portalResponse.json(),
          stats: statsResponse.json(),
          before,
          after: await snapshot(),
        })
      }
      if (process.env.T3_DISPLAY_PROOF)
        writeFileSync(process.env.T3_DISPLAY_PROOF, JSON.stringify(proof, null, 2) + '\n')
    } finally {
      await app.close()
      jest.useRealTimers()
    }
  }, 60_000)
})
