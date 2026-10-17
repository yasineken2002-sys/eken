/**
 * Månadsaviseringens fristående beteendekontrakt.
 * Direct helper tests: no AviseringService import, module mocks or require hooks.
 * Callback/TX identity is tested; these doubles do NOT prove durable DB rollback,
 * row locking, real OCR allocation, concurrency or capacity.
 */
import { Prisma, RentNoticeStatus, RentNoticeType } from '@prisma/client'
import type { Lease, Unit } from '@prisma/client'
import {
  bookRentNoticeRevenue,
  calculateRentNoticeVat,
  generateMonthlyNotices,
  previewMonthlyNotices,
  type MonthlyNoticeDependencies,
  type RentNoticeRevenueInput,
} from './monthly-notices'

type LeaseFixture = Pick<
  Lease,
  | 'id'
  | 'organizationId'
  | 'tenantId'
  | 'monthlyRent'
  | 'monthlyRentExcludingVat'
  | 'startDate'
  | 'endDate'
  | 'status'
> & {
  tenant: { id: string }
  unit: Pick<Unit, 'type' | 'voluntaryTaxLiability'> & { property: Record<string, never> }
}
type Existing = { leaseId: string; dueDate: Date }
type Write = {
  organizationId: string
  tenantId: string
  leaseId: string
  noticeNumber: string
  ocrNumber: string
  year: number
  month: number
  amount: number
  vatAmount: number
  totalAmount: number
  dueDate: Date
  status: RentNoticeStatus
  type: RentNoticeType
  periodStart: Date
  periodEnd: Date
  daysCharged: number
  totalDays: number
  isProrated: boolean
}
type NoticeFixture = Write & {
  id: string
  consumptionAmount: Prisma.Decimal
  miscChargeAmount: Prisma.Decimal
}
type Ocr = MonthlyNoticeDependencies['ocrService']['assignOcrToTenant']
type Accounting = MonthlyNoticeDependencies['accounting']['createJournalEntryForRentNotice']
type Consumption = MonthlyNoticeDependencies['consumption']['attachRentNoticeLineCharges']
type Misc = MonthlyNoticeDependencies['miscCharges']['attachMiscChargesToRentNotice']
const ORG = 'org-monthly'
const OCR = '00000000019'
const OPENING_REASON =
  'Organisationen har ett ofärdigt öppningspaket för aktuellt brytdatum. ' +
  'Hantera öppningspaketet innan nya avier skapas.'

function lease(id: string, changes: Partial<LeaseFixture> = {}): LeaseFixture {
  return {
    id,
    organizationId: ORG,
    tenantId: `tenant-${id}`,
    monthlyRent: new Prisma.Decimal(30_000),
    monthlyRentExcludingVat: false,
    startDate: new Date(2025, 6, 1),
    endDate: null,
    status: 'ACTIVE',
    tenant: { id: `tenant-${id}` },
    unit: { type: 'APARTMENT', voluntaryTaxLiability: false, property: {} },
    ...changes,
  }
}

function makeRig(leases: LeaseFixture[], existing: Existing[] = [], cutover: Date | null = null) {
  const events: string[] = []
  const createdNotices: NoticeFixture[] = []
  let sequence = 0
  const organizationFindUnique = jest
    .fn<Promise<{ billingCutoverDate: Date | null }>, [Prisma.OrganizationFindUniqueArgs]>()
    .mockResolvedValue({ billingCutoverDate: cutover })
  const leaseFindMany = jest
    .fn<Promise<LeaseFixture[]>, [Prisma.LeaseFindManyArgs]>()
    .mockResolvedValue(leases)
  const noticeFindMany = jest
    .fn<Promise<Existing[]>, [Prisma.RentNoticeFindManyArgs]>()
    .mockResolvedValue(existing)
  const queryRaw = jest.fn<
    Promise<{ billingCutoverDate: Date | null }[]>,
    [TemplateStringsArray, ...unknown[]]
  >(async () => {
    events.push('opening:lock')
    return [{ billingCutoverDate: cutover }]
  })
  const openingFindFirst = jest
    .fn<Promise<{ id: string } | null>, [Prisma.OpeningPackageFindFirstArgs]>()
    .mockResolvedValue(null)
  const allocate = jest.fn<
    Promise<{ lastNumber: number }>,
    [Prisma.RentNoticeNumberSequenceUpsertArgs]
  >(async () => {
    events.push('number')
    return { lastNumber: ++sequence }
  })
  const create = jest.fn<Promise<NoticeFixture>, [{ data: Write; include: unknown }]>(
    async ({ data }) => {
      events.push(`create:${data.leaseId}`)
      const notice = {
        ...data,
        id: `notice-${data.leaseId}`,
        consumptionAmount: new Prisma.Decimal(0),
        miscChargeAmount: new Prisma.Decimal(0),
      }
      createdNotices.push(notice)
      return notice
    },
  )
  // Only generated Prisma delegate boundaries are narrowed. The transaction
  // double is distinct from the outer read client and exposes no outer writes.
  const tx = {
    $queryRaw: queryRaw,
    openingPackage: { findFirst: openingFindFirst },
    rentNoticeNumberSequence: { upsert: allocate },
    rentNotice: { create },
  } as unknown as Prisma.TransactionClient
  const transaction = jest.fn<
    Promise<NoticeFixture>,
    [
      (client: Prisma.TransactionClient) => Promise<NoticeFixture>,
      { timeout: number; maxWait: number },
    ]
  >(async (work) => {
    events.push('tx:enter')
    try {
      const value = await work(tx)
      events.push('tx:resolved')
      return value
    } catch (error) {
      events.push('tx:rejected')
      throw error
    }
  })
  const prisma = {
    organization: { findUnique: organizationFindUnique },
    lease: { findMany: leaseFindMany },
    rentNotice: { findMany: noticeFindMany },
    $transaction: transaction,
  } as unknown as MonthlyNoticeDependencies['prisma']
  const ocr = jest.fn<ReturnType<Ocr>, Parameters<Ocr>>(async (tenantId) => {
    events.push(`ocr:${tenantId}`)
    return OCR
  })
  const accounting = jest.fn<ReturnType<Accounting>, Parameters<Accounting>>(async (notice) => {
    events.push(`book:${notice.leaseId}`)
    return null
  })
  const consumption = jest.fn<ReturnType<Consumption>, Parameters<Consumption>>(async () => {
    events.push('consumption')
    return 0
  })
  const misc = jest.fn<ReturnType<Misc>, Parameters<Misc>>(async () => {
    events.push('misc')
    return 0
  })
  const logger = { warn: jest.fn<void, [string]>(), error: jest.fn<void, [string]>() }
  const dependencies: MonthlyNoticeDependencies = {
    prisma,
    ocrService: { assignOcrToTenant: ocr },
    accounting: { createJournalEntryForRentNotice: accounting },
    consumption: { attachRentNoticeLineCharges: consumption },
    miscCharges: { attachMiscChargesToRentNotice: misc },
    logger,
  }
  return {
    dependencies,
    prisma,
    tx,
    events,
    createdNotices,
    organizationFindUnique,
    leaseFindMany,
    noticeFindMany,
    queryRaw,
    openingFindFirst,
    allocate,
    create,
    transaction,
    ocr,
    accounting,
    consumption,
    misc,
    logger,
  }
}

// Independent June 2026 oracle; no production calculator builds expectations.
function fullMonthWrite(id: string, number: string): Write {
  return {
    organizationId: ORG,
    tenantId: `tenant-${id}`,
    leaseId: id,
    noticeNumber: number,
    ocrNumber: OCR,
    year: 2026,
    month: 6,
    amount: 30_000,
    vatAmount: 0,
    totalAmount: 30_000,
    dueDate: new Date(2026, 4, 29),
    status: 'PENDING',
    type: 'RENT',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    daysCharged: 30,
    totalDays: 30,
    isProrated: false,
  }
}

describe('monthly notice extraction — direct helper contract', () => {
  it('preview och generate delar scoped urval, befintliga datum och EXPIRED-prorata', async () => {
    const rig = makeRig(
      [
        lease('full'),
        lease('expired', { status: 'EXPIRED', endDate: new Date(2026, 5, 20) }),
        lease('existing'),
        lease('future', { startDate: new Date(2026, 6, 1) }),
        lease('ended', { endDate: new Date(2026, 4, 31) }),
      ],
      [
        { leaseId: 'existing', dueDate: new Date('2026-05-18T12:00:00Z') },
        { leaseId: 'existing-other-a', dueDate: new Date('2026-05-14T12:00:00Z') },
        { leaseId: 'existing-other-b', dueDate: new Date('2026-05-18T12:00:00Z') },
      ],
    )
    expect(await previewMonthlyNotices(rig.prisma, ORG, 6, 2026)).toEqual({
      month: 6,
      year: 2026,
      toCreate: 2,
      skipped: 3,
      dueDates: [{ dueDate: '2026-05-29', count: 2 }],
      existingDueDates: [
        { dueDate: '2026-05-14', count: 1 },
        { dueDate: '2026-05-18', count: 2 },
      ],
      beforeCutover: null,
    })
    expect(rig.events).toEqual([])
    expect(rig.ocr).not.toHaveBeenCalled()
    expect(rig.transaction).not.toHaveBeenCalled()
    expect(rig.create).not.toHaveBeenCalled()
    const result = await generateMonthlyNotices(rig.dependencies, ORG, 6, 2026)
    expect(result).toEqual({
      created: 2,
      skipped: 3,
      failed: 0,
      notices: rig.createdNotices,
      beforeCutover: null,
      blockedByOpening: 0,
      blockedReason: null,
    })
    expect(rig.create.mock.calls.map(([call]) => call.data)).toEqual([
      fullMonthWrite('full', 'AVI-2026-06-0001'),
      {
        ...fullMonthWrite('expired', 'AVI-2026-06-0002'),
        amount: 20_000,
        totalAmount: 20_000,
        periodEnd: new Date('2026-06-20T00:00:00.000Z'),
        daysCharged: 20,
        isProrated: true,
      },
    ])
    for (const [args] of rig.leaseFindMany.mock.calls) {
      expect(args.where).toEqual({
        organizationId: ORG,
        OR: [{ status: 'ACTIVE' }, { status: 'EXPIRED', endDate: { gte: new Date(2026, 5, 1) } }],
      })
    }
    expect(rig.organizationFindUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { billingCutoverDate: true },
    })
    expect(rig.noticeFindMany).toHaveBeenCalledTimes(2)
    for (const [args] of rig.noticeFindMany.mock.calls) {
      expect(args).toEqual({
        where: { organizationId: ORG, month: 6, year: 2026, type: 'RENT' },
        select: { leaseId: true, dueDate: true },
      })
    }
    expect(rig.ocr.mock.calls).toEqual([
      ['tenant-full', ORG],
      ['tenant-expired', ORG],
    ])
  })

  it('före brytdatum ger samma nollplan utan OCR/TX och bevarar befintligt dokumentdatum', async () => {
    const rig = makeRig(
      [lease('old')],
      [{ leaseId: 'old', dueDate: new Date('2026-05-14T12:00:00Z') }],
      new Date('2026-07-01T00:00:00Z'),
    )
    const beforeCutover =
      'Perioden ligger före organisationens brytdatum 2026-07-01 — den är ' +
      'fakturerad i tidigare system och skapas inte i Eveno.'
    expect(await previewMonthlyNotices(rig.prisma, ORG, 6, 2026)).toEqual({
      month: 6,
      year: 2026,
      toCreate: 0,
      skipped: 0,
      dueDates: [],
      existingDueDates: [{ dueDate: '2026-05-14', count: 1 }],
      beforeCutover,
    })
    expect(await generateMonthlyNotices(rig.dependencies, ORG, 6, 2026)).toEqual({
      created: 0,
      skipped: 0,
      failed: 0,
      notices: [],
      beforeCutover,
      blockedByOpening: 0,
      blockedReason: null,
    })
    for (const [args] of rig.leaseFindMany.mock.calls) expect(args.where?.id).toEqual({ in: [] })
    expect(rig.events).toEqual([])
    expect(rig.ocr).not.toHaveBeenCalled()
    expect(rig.transaction).not.toHaveBeenCalled()
  })

  it('OCR föregår avi-TX; nummer, momsavi och bokföring delar TX, avgifter kommer efteråt', async () => {
    const rig = makeRig([
      lease('office', {
        monthlyRent: new Prisma.Decimal(10_000),
        monthlyRentExcludingVat: true,
        unit: { type: 'OFFICE', voluntaryTaxLiability: true, property: {} },
      }),
    ])
    rig.consumption.mockImplementation(async () => {
      rig.events.push('consumption')
      return 125.5
    })
    rig.misc.mockImplementation(async () => {
      rig.events.push('misc')
      return 75.25
    })
    const result = await generateMonthlyNotices(rig.dependencies, ORG, 6, 2026)
    expect(rig.events).toEqual([
      'ocr:tenant-office',
      'tx:enter',
      'opening:lock',
      'number',
      'create:office',
      'book:office',
      'tx:resolved',
      'consumption',
      'misc',
    ])
    expect(rig.tx).not.toBe(rig.prisma)
    expect(rig.transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 5_000,
      maxWait: 2_000,
    })
    expect(rig.queryRaw.mock.calls[0]!.slice(1)).toEqual([ORG])
    expect(rig.allocate).toHaveBeenCalledWith({
      where: { organizationId_year_month: { organizationId: ORG, year: 2026, month: 6 } },
      create: { organizationId: ORG, year: 2026, month: 6, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })
    expect(rig.create.mock.calls[0]![0].data).toEqual({
      ...fullMonthWrite('office', 'AVI-2026-06-0001'),
      amount: 10_000,
      vatAmount: 2_500,
      totalAmount: 12_500,
    })
    expect(rig.accounting).toHaveBeenCalledWith(rig.createdNotices[0], ORG, null, rig.tx)
    expect(rig.consumption).toHaveBeenCalledWith({
      organizationId: ORG,
      leaseId: 'office',
      rentNoticeId: 'notice-office',
      aviMonth: 6,
      aviYear: 2026,
    })
    expect(rig.misc).toHaveBeenCalledWith({
      organizationId: ORG,
      leaseId: 'office',
      rentNoticeId: 'notice-office',
    })
    expect(result.notices[0]).toBe(rig.createdNotices[0])
    expect(result.notices[0]!.consumptionAmount).toEqual(new Prisma.Decimal(125.5))
    expect(result.notices[0]!.miscChargeAmount).toEqual(new Prisma.Decimal(75.25))
    expect(result.created).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('skiljer verklig opening-exception från bokföringsfel och fortsätter med nästa avtal', async () => {
    const rig = makeRig(
      [lease('blocked'), lease('failed'), lease('ok')],
      [],
      new Date('2026-06-01T00:00:00Z'),
    )
    rig.openingFindFirst.mockResolvedValueOnce({ id: 'opening-draft' })
    const failure = new Error('stängd period')
    rig.accounting.mockRejectedValueOnce(failure)
    const result = await generateMonthlyNotices(rig.dependencies, ORG, 6, 2026)
    expect(result).toEqual({
      created: 1,
      skipped: 0,
      failed: 1,
      notices: [rig.createdNotices[1]],
      beforeCutover: null,
      blockedByOpening: 1,
      blockedReason: OPENING_REASON,
    })
    expect(rig.openingFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        cutoverDate: new Date('2026-06-01T00:00:00Z'),
        status: { in: ['DRAFT', 'VALIDATED', 'APPROVED'] },
      },
      select: { id: true },
    })
    expect(rig.ocr.mock.calls).toEqual([
      ['tenant-blocked', ORG],
      ['tenant-failed', ORG],
      ['tenant-ok', ORG],
    ])
    expect(rig.transaction).toHaveBeenCalledTimes(3)
    expect(rig.allocate).toHaveBeenCalledTimes(2)
    expect(rig.create.mock.calls.map(([call]) => call.data.leaseId)).toEqual(['failed', 'ok'])
    expect(rig.accounting).toHaveBeenCalledTimes(2)
    expect(rig.consumption).toHaveBeenCalledTimes(1)
    expect(rig.misc).toHaveBeenCalledTimes(1)
    expect(rig.consumption).toHaveBeenCalledWith(
      expect.objectContaining({ rentNoticeId: 'notice-ok' }),
    )
    expect(rig.logger.error).toHaveBeenCalledTimes(1)
    expect(rig.logger.error).toHaveBeenCalledWith(
      `[Avisering] Avi för lease failed (org ${ORG}) misslyckades — hoppar, övriga leases fortsätter: stängd period`,
    )
    // No assertion about persisted/rolled-back rows or sequence numbers: this is a callback double.
    expect(rig.events.filter((event) => event.startsWith('tx:'))).toEqual([
      'tx:enter',
      'tx:rejected',
      'tx:enter',
      'tx:rejected',
      'tx:enter',
      'tx:resolved',
    ])
  })

  it('OCR-fel öppnar ingen avi-TX för det avtalet men stoppar inte nästa kandidat', async () => {
    const rig = makeRig([lease('ocr-failed'), lease('ok')])
    rig.ocr.mockRejectedValueOnce(new Error('OCR nere'))
    const result = await generateMonthlyNotices(rig.dependencies, ORG, 6, 2026)
    expect(result).toEqual({
      created: 1,
      skipped: 0,
      failed: 1,
      notices: rig.createdNotices,
      beforeCutover: null,
      blockedByOpening: 0,
      blockedReason: null,
    })
    expect(rig.ocr).toHaveBeenCalledTimes(2)
    expect(rig.transaction).toHaveBeenCalledTimes(1)
    expect(rig.create.mock.calls.map(([call]) => call.data.leaseId)).toEqual(['ok'])
    expect(rig.logger.error).toHaveBeenCalledWith(
      `[Avisering] Avi för lease ocr-failed (org ${ORG}) misslyckades — hoppar, övriga leases fortsätter: OCR nere`,
    )
  })

  it.each(['consumption', 'misc'] as const)(
    'ett %s-fel efter avi-TX ändrar inte created/failed',
    async (kind) => {
      const rig = makeRig([lease('charges')])
      rig[kind].mockRejectedValueOnce(new Error('koppling nere'))
      const result = await generateMonthlyNotices(rig.dependencies, ORG, 6, 2026)
      expect(result).toEqual({
        created: 1,
        skipped: 0,
        failed: 0,
        notices: rig.createdNotices,
        beforeCutover: null,
        blockedByOpening: 0,
        blockedReason: null,
      })
      expect(rig.consumption).toHaveBeenCalledTimes(1)
      expect(rig.misc).toHaveBeenCalledTimes(1)
      expect(rig.events.indexOf('tx:resolved')).toBeGreaterThan(rig.events.indexOf('book:charges'))
      expect(rig.logger.error).toHaveBeenCalledTimes(1)
      const chargeName = kind === 'consumption' ? 'förbrukning' : 'övriga debiteringar'
      expect(rig.logger.error).toHaveBeenCalledWith(
        `[Avisering] Koppling av ${chargeName} till avi AVI-2026-06-0001 misslyckades: koppling nere`,
      )
      expect(result.notices[0]!.consumptionAmount).toEqual(new Prisma.Decimal(0))
      expect(result.notices[0]!.miscChargeAmount).toEqual(new Prisma.Decimal(0))
    },
  )

  it('bevarar momsgrindarna, avrundningen och varningen för en momspliktig bruttohyra', () => {
    const logger = { warn: jest.fn<void, [string]>() }
    expect(
      calculateRentNoticeVat(
        logger,
        10_000.03,
        { type: 'APARTMENT', voluntaryTaxLiability: true },
        { monthlyRentExcludingVat: true },
      ),
    ).toEqual({ vatAmount: 0, totalAmount: 10_000.03 })
    expect(
      calculateRentNoticeVat(
        logger,
        10_000,
        { type: 'OFFICE', voluntaryTaxLiability: false },
        { monthlyRentExcludingVat: true },
      ),
    ).toEqual({ vatAmount: 0, totalAmount: 10_000 })
    expect(
      calculateRentNoticeVat(
        logger,
        10_000.03,
        { type: 'OFFICE', voluntaryTaxLiability: true },
        { monthlyRentExcludingVat: true },
      ),
    ).toEqual({ vatAmount: 2_500.01, totalAmount: 10_000.03 + 2_500.01 })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(
      calculateRentNoticeVat(
        logger,
        10_000,
        { type: 'OFFICE', voluntaryTaxLiability: true },
        { monthlyRentExcludingVat: false },
        'avi office',
      ),
    ).toEqual({ vatAmount: 0, totalAmount: 10_000 })
    expect(logger.warn).toHaveBeenCalledWith(
      '[Moms] Enhet OFFICE är momspliktig men hyran är inte markerad som exkl. moms — moms läggs ej på (avi office). Kontrollera kontraktsregistreringen.',
    )
  })

  it('bokföringsdelegaten bevarar DEPOSIT-undantag och felriktning med respektive utan TX', async () => {
    const rig = makeRig([])
    const notice: RentNoticeRevenueInput = {
      id: 'revenue',
      noticeNumber: 'AVI-2026-06-0099',
      leaseId: 'lease-revenue',
      type: RentNoticeType.RENT,
      amount: 10_000,
      vatAmount: 0,
      totalAmount: 10_000,
      year: 2026,
      month: 6,
    }
    await bookRentNoticeRevenue(
      rig.dependencies.accounting,
      rig.logger,
      ORG,
      { ...notice, type: RentNoticeType.DEPOSIT },
      rig.tx,
    )
    expect(rig.accounting).not.toHaveBeenCalled()
    const failure = new Error('bokföring nere')
    rig.accounting.mockRejectedValue(failure)
    await expect(
      bookRentNoticeRevenue(rig.dependencies.accounting, rig.logger, ORG, notice, rig.tx),
    ).rejects.toBe(failure)
    expect(rig.accounting).toHaveBeenLastCalledWith(notice, ORG, null, rig.tx)
    expect(rig.logger.error).not.toHaveBeenCalled()
    await expect(
      bookRentNoticeRevenue(rig.dependencies.accounting, rig.logger, ORG, notice),
    ).resolves.toBeUndefined()
    expect(rig.accounting).toHaveBeenLastCalledWith(notice, ORG, null, undefined)
    expect(rig.logger.error).toHaveBeenCalledWith(
      '[Avisering] Bokföring av hyresavi AVI-2026-06-0099 misslyckades: bokföring nere',
    )
  })
})
