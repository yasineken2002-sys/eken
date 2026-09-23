/** Calendar-day effects against real PostgreSQL; external delivery is never invoked. */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
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
import { swedishDateKey } from '@eken/shared'
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
})
