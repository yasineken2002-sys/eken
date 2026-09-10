// Ej använda sidoeffektsadaptrar laddas inte; avisering, grind och bokföring är verkliga.
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
import { AviseringService } from '../avisering/avisering.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import type { ConsumptionCharge, UserRole } from '@prisma/client'
import type { SaveReadingReviewInput } from '@eken/shared'
import { ConsumptionService } from './consumption.service'
import { ReadingReviewService } from './reading-review.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { lockConsumptionEvidence } from './charge-gate'

// Riktig PostgreSQL och riktiga produktionsmetoder, inklusive verifikat/avier.
// Varje test äger sin organisation. Ingen lånad fixture eller mockad bokföring.
it('kräver riktig PostgreSQL även i CI', () => expect(Boolean(process.env.DATABASE_URL)).toBe(true))
const hasDb = Boolean(process.env.DATABASE_URL)
;(hasDb ? describe : describe.skip)('spårbar debiteringsgrind i PostgreSQL', () => {
  const db = new PrismaClient()
  const prisma = db as unknown as PrismaService
  const accounting = new AccountingService(prisma, new VerifikationsnummerService(prisma))
  const service = new ConsumptionService(prisma, accounting, new InvoiceEventsService(prisma))
  const reviews = new ReadingReviewService(prisma)
  let org: string, user: string, unit: string, meter: string, lease: string, tenant: string
  const createdOrgs: string[] = []
  const day = (n: number) => new Date(Date.UTC(2026, 0, n))
  async function counts() {
    const where = { organizationId: org }
    return {
      readings: await db.meterReading.count({ where }),
      reviews: await db.meterReadingReview.count({ where }),
      charges: await db.consumptionCharge.count({ where }),
      checks: await db.consumptionChargeCheck.count({ where }),
      entries: await db.journalEntry.count({ where }),
      invoices: await db.invoice.count({ where }),
      lines: await db.rentNoticeLine.count({ where: { rentNotice: where } }),
    }
  }
  async function globalCounts() {
    return {
      organizations: await db.organization.count(),
      readings: await db.meterReading.count(),
      reviews: await db.meterReadingReview.count(),
      charges: await db.consumptionCharge.count(),
      checks: await db.consumptionChargeCheck.count(),
      entries: await db.journalEntry.count(),
      journalLines: await db.journalEntryLine.count(),
      invoices: await db.invoice.count(),
      notices: await db.rentNotice.count(),
      noticeLines: await db.rentNoticeLine.count(),
    }
  }
  let baseline: Awaited<ReturnType<typeof globalCounts>>
  beforeAll(async () => {
    baseline = await globalCounts()
    console.warn('GRIND DB före:', JSON.stringify(baseline))
  })
  beforeEach(async () => {
    const suffix = randomUUID()
    org = (
      await db.organization.create({
        data: {
          name: 'Gate fixture',
          email: suffix + '@example.test',
          street: 'Test',
          city: 'Test',
          postalCode: '11111',
        },
      })
    ).id
    createdOrgs.push(org)
    user = (
      await db.user.create({
        data: {
          organizationId: org,
          email: suffix + '@example.test',
          firstName: 'Ada',
          lastName: 'Grind',
          role: 'MANAGER',
        },
      })
    ).id
    const property = await db.property.create({
      data: {
        organizationId: org,
        name: 'Grind',
        propertyDesignation: suffix,
        type: 'RESIDENTIAL',
        street: 'Test',
        city: 'Test',
        postalCode: '11111',
        totalArea: 50,
        consumptionBillingMode: 'RENT_NOTICE_LINE',
      },
    })
    unit = (
      await db.unit.create({
        data: {
          propertyId: property.id,
          name: 'Test',
          unitNumber: '1',
          type: 'APARTMENT',
          area: 50,
          monthlyRent: 1000,
        },
      })
    ).id
    tenant = (
      await db.tenant.create({
        data: {
          organizationId: org,
          firstName: 'Test',
          lastName: 'Hyresgäst',
          type: 'INDIVIDUAL',
          email: 'tenant-' + suffix + '@example.test',
        },
      })
    ).id
    lease = (
      await db.lease.create({
        data: {
          organizationId: org,
          unitId: unit,
          tenantId: tenant,
          status: 'ACTIVE',
          startDate: day(1),
          tenancyStartDate: day(1),
          monthlyRent: 1000,
          depositAmount: 0,
        },
      })
    ).id
    meter = (
      await service.createMeter({ unitId: unit, type: 'ELECTRICITY', unitOfMeasure: 'kWh' }, org)
    ).id
    await service.createTariff(
      { scope: 'ORGANIZATION', meterType: 'ELECTRICITY', pricePerUnit: 2, validFrom: '2026-01-01' },
      org,
    )
    await db.account.createMany({
      data: [
        { organizationId: org, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: org, number: 1790, name: 'Upplupet', type: 'ASSET' },
        { organizationId: org, number: 3920, name: 'Förbrukning', type: 'REVENUE' },
      ],
    })
    expect(await counts()).toEqual({
      readings: 0,
      reviews: 0,
      charges: 0,
      checks: 0,
      entries: 0,
      invoices: 0,
      lines: 0,
    })
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    for (const organizationId of createdOrgs.splice(0)) {
      const where = { organizationId }
      await db.journalEntryLine.deleteMany({ where: { journalEntry: where } })
      await db.journalEntry.deleteMany({ where })
      await db.journalEntrySequence.deleteMany({ where })
      await db.consumptionChargeCheck.deleteMany({ where })
      await db.rentNoticeLine.deleteMany({ where: { rentNotice: where } })
      await db.consumptionCharge.deleteMany({ where })
      await db.invoiceEvent.deleteMany({ where: { invoice: where } })
      await db.invoiceLine.deleteMany({ where: { invoice: where } })
      await db.invoice.deleteMany({ where })
      await db.rentNotice.deleteMany({ where })
      await db.meterReading.deleteMany({ where })
      await db.meter.deleteMany({ where })
      await db.consumptionTariff.deleteMany({ where })
      await db.lease.deleteMany({ where })
      await db.property.deleteMany({ where })
      await db.tenant.deleteMany({ where })
      await db.account.deleteMany({ where })
      await db.organization.delete({ where: { id: organizationId } })
      expect(await db.consumptionChargeCheck.count({ where })).toBe(0)
      expect(await db.meterReadingReview.count({ where })).toBe(0)
      expect(await db.journalEntry.count({ where })).toBe(0)
    }
  })
  afterAll(async () => {
    try {
      const after = await globalCounts()
      console.warn('GRIND DB efter:', JSON.stringify(after))
      expect(after).toEqual(baseline)
    } finally {
      await db.$disconnect()
    }
  })
  async function record(
    value = 10,
    n = 1,
    readingType: 'PERIOD_VOLUME' | 'CUMULATIVE' = 'PERIOD_VOLUME',
  ) {
    return service.recordReading(
      {
        meterId: meter,
        value,
        readingType,
        source: 'MANUAL',
        readingDate: day(n).toISOString(),
        periodStart: day(n).toISOString(),
        periodEnd: day(n).toISOString(),
      },
      org,
      user,
    )
  }
  async function high() {
    for (let n = 1; n <= 3; n++) await record(10, n)
    return (await record(40, 4)).charge!
  }
  async function decision(
    assessment: SaveReadingReviewInput['assessment'] = 'EXPLAINED',
    billingBasisDecision?: SaveReadingReviewInput['billingBasisDecision'],
  ) {
    const f = (await reviews.getReview(org)).findings.find((f) => f.code === 'HIGH_RATE')!
    const dto: SaveReadingReviewInput = {
      readingId: f.readingId,
      findingCode: f.code,
      fingerprint: f.fingerprint,
      expectedRevision: f.reviews[0]?.revision ?? 0,
      assessment,
      comment: 'Kontrollerat mätvärde och verklig ökning',
      ...(billingBasisDecision ? { billingBasisDecision } : {}),
    }
    return reviews.saveReview(org, user, dto)
  }
  async function confirm(charge: ConsumptionCharge, actor = user) {
    const control = await service.getChargeControl(charge.id, org)
    return service.confirmCharge(charge.id, org, actor, {
      expectedFingerprint: control.fingerprint,
    })
  }
  async function notice() {
    return db.rentNotice.create({
      data: {
        organizationId: org,
        leaseId: lease,
        tenantId: tenant,
        noticeNumber: randomUUID(),
        ocrNumber: randomUUID(),
        month: 4,
        year: 2026,
        amount: 1000,
        totalAmount: 1000,
        dueDate: day(90),
        type: 'RENT',
      },
    })
  }
  async function attach() {
    const n = await notice()
    return service.attachRentNoticeLineCharges({
      organizationId: org,
      leaseId: lease,
      rentNoticeId: n.id,
      aviMonth: 4,
      aviYear: 2026,
    })
  }
  it('normal utan trendhistorik: ett spår, en verklig verifikation och en avi-rad', async () => {
    const c = (await record()).charge!
    await confirm(c)
    const evidence = (
      await db.consumptionChargeCheck.findFirstOrThrow({ where: { organizationId: org } })
    ).evidence
    expect(evidence).toMatchObject({
      findings: [],
      trendCoverage: { trendAssessed: 0, notTrendAssessed: 1 },
    })
    expect(await attach()).toBe(20)
    expect(await counts()).toMatchObject({ checks: 1, entries: 1, lines: 1 })
    const lines = await db.journalEntryLine.findMany({
      where: { journalEntry: { organizationId: org } },
      include: { account: true },
    })
    expect(
      lines
        .map((l) => [l.account.number, l.debit?.toString() ?? '0', l.credit?.toString() ?? '0'])
        .sort(),
    ).toEqual([
      [1510, '20', '0'],
      [3920, '0', '20'],
    ])
  })
  it('varning utan bedömning blockerar konfirmering utan DB-effekter', async () => {
    const c = await high()
    await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ checks: 0, entries: 0, lines: 0, invoices: 0 })
    expect((await db.consumptionCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(
      'DRAFT',
    )
  })
  it.each(['NEEDS_INVESTIGATION', 'CONFIRMED', 'EXPLAINED'] as const)(
    '%s ensamt blockerar',
    async (status) => {
      const c = await high()
      await decision(status)
      await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
      expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
    },
  )
  it('uttrycklig aktuell bedömning tillåter korrekt stor verklig ökning', async () => {
    const c = await high()
    const d = await decision('EXPLAINED', 'VERIFIED_CORRECT_REAL_INCREASE')
    await confirm(c)
    const trace = await db.consumptionChargeCheck.findFirstOrThrow({
      where: { chargeId: c.id, organizationId: org },
    })
    expect(trace).toMatchObject({
      checkedById: user,
      checkedByName: 'Ada Grind',
      readingId: c.meterReadingId,
    })
    expect(trace.evidence).toMatchObject({
      findings: [{ latestReview: { id: d.id, revision: 1 } }],
    })
  })
  it('felaktigt underlag och nyare revision spärrar även efter konfirmering', async () => {
    const c = await high()
    await decision('EXPLAINED', 'VERIFIED_CORRECT_REAL_INCREASE')
    await confirm(c)
    await decision('EXPLAINED', 'INCORRECT')
    await expect(attach()).rejects.toMatchObject({ status: 409 })
    await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ checks: 1, entries: 1, lines: 0 })
  })
  it.each(['DATA', 'OVERLAP', 'DECREASE'] as const)(
    '%s kan inte godkännas med intyg',
    async (code) => {
      let c: ConsumptionCharge
      if (code === 'DECREASE') {
        await record(100, 1, 'CUMULATIVE')
        c = (await record(120, 2, 'CUMULATIVE')).charge!
        await db.meterReading.update({ where: { id: c.meterReadingId }, data: { value: 90 } })
      } else {
        c = (await record()).charge!
        if (code === 'DATA')
          await db.meterReading.update({ where: { id: c.meterReadingId }, data: { value: -1 } })
        else await record(11, 1)
      }
      const f = (await reviews.getReview(org)).findings.find(
        (f) => f.readingId === c.meterReadingId,
      )!
      expect(f.code).toBe(code)
      await reviews.saveReview(org, user, {
        readingId: f.readingId,
        findingCode: f.code,
        fingerprint: f.fingerprint,
        expectedRevision: 0,
        assessment: 'EXPLAINED',
        billingBasisDecision: 'VERIFIED_CORRECT_REAL_INCREASE',
        comment: 'Kommentar rättar inte underlaget',
      })
      await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
      expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
    },
  )
  it('ändrad jämförelseavläsning gör både intyg och förväntat underlag inaktuellt', async () => {
    const c = await high()
    await decision('EXPLAINED', 'VERIFIED_CORRECT_REAL_INCREASE')
    const old = await service.getChargeControl(c.id, org)
    const prior = await db.meterReading.findFirstOrThrow({
      where: { organizationId: org, periodEnd: day(2) },
    })
    await db.meterReading.update({ where: { id: prior.id }, data: { value: 11 } })
    await expect(
      service.confirmCharge(c.id, org, user, { expectedFingerprint: old.fingerprint }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
  })
  it('gammal regelversion i senaste review kan inte återanvändas', async () => {
    const c = await high()
    await decision('EXPLAINED', 'VERIFIED_CORRECT_REAL_INCREASE')
    const r = await db.meterReadingReview.findFirstOrThrow({ where: { organizationId: org } })
    await db.meterReadingReview.create({
      data: {
        ...r,
        id: randomUUID(),
        revision: 2,
        ruleVersion: 'consumption-review-old',
        evidence: r.evidence as Prisma.InputJsonValue,
      },
    })
    await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
  })
  it('bakdaterad mellanavläsning utan target-varning får inte legitimera gammal kvantitet', async () => {
    await record(100, 1, 'CUMULATIVE')
    const c = (await record(150, 3, 'CUMULATIVE')).charge!
    await record(120, 2, 'CUMULATIVE')
    expect((await reviews.getReview(org)).findings).toHaveLength(0)
    await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
  })
  it.each(['VIEWER', 'ACCOUNTANT'] as const)('servern nekar %s', async (role) => {
    const c = (await record()).charge!
    await db.user.update({ where: { id: user }, data: { role: role as UserRole } })
    await expect(confirm(c)).rejects.toMatchObject({ status: 403 })
    expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
  })
  it('nekar främmande organisation och inaktiverad aktör', async () => {
    const c = (await record()).charge!
    await expect(service.getChargeControl(c.id, randomUUID())).rejects.toMatchObject({
      status: 404,
    })
    await expect(confirm(c, randomUUID())).rejects.toMatchObject({ status: 403 })
    await db.user.update({ where: { id: user }, data: { isActive: false } })
    await expect(confirm(c)).rejects.toMatchObject({ status: 403 })
  })
  it('fel efter verklig verifikationsskrivning rullar tillbaka spår, status och verifikation', async () => {
    const c = (await record()).charge!
    const original = accounting.createJournalEntryForConsumptionCharge.bind(accounting)
    jest
      .spyOn(accounting, 'createJournalEntryForConsumptionCharge')
      .mockImplementationOnce(async (...args) => {
        await original(...args)
        expect(await args[3]!.journalEntry.count({ where: { organizationId: org } })).toBe(1)
        throw new Error('simulerat fel före commit')
      })
    await expect(confirm(c)).rejects.toThrow('simulerat fel före commit')
    expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
    expect((await db.consumptionCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(
      'DRAFT',
    )
  })
  it('äldre CONFIRMED utan spår når varken avi, separat faktura, direktbokföring eller bokslut', async () => {
    const c = (await record()).charge!
    await db.consumptionCharge.update({ where: { id: c.id }, data: { status: 'CONFIRMED' } })
    await expect(attach()).rejects.toMatchObject({ status: 409 })
    await expect(
      accounting.createJournalEntryForConsumptionCharge(c, org, user),
    ).rejects.toMatchObject({ status: 409 })
    await expect(service.runYearEndAccrual(org, 2026, user)).rejects.toMatchObject({ status: 409 })
    await db.consumptionCharge.update({
      where: { id: c.id },
      data: { deliveryMode: 'SEPARATE_INVOICE' },
    })
    await expect(service.invoiceSeparateCharges(lease, org, user)).rejects.toMatchObject({
      status: 409,
    })
    expect(await counts()).toMatchObject({ checks: 0, entries: 0, invoices: 0, lines: 0 })
    await confirm(c)
    expect(await service.invoiceSeparateCharges(lease, org, user)).toMatchObject({
      type: 'UTILITY',
    })
    expect(await counts()).toMatchObject({ checks: 1, entries: 1, invoices: 1 })
  })
  it('blockerad DRAFT är inte en tillåten bokslutsbas', async () => {
    await high()
    await expect(service.runYearEndAccrual(org, 2026, user)).rejects.toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ entries: 0 })
  })
  it('ny regelversion i sparat kontrollspår kräver ny mänsklig kontroll', async () => {
    const c = (await record()).charge!
    await confirm(c)
    const old = await db.consumptionChargeCheck.findFirstOrThrow({ where: { organizationId: org } })
    await db.consumptionChargeCheck.create({
      data: {
        ...old,
        id: randomUUID(),
        createdAt: new Date(Date.now() + 1000),
        revision: old.revision + 1,
        ruleVersion: 'old',
        evidence: old.evidence as Prisma.InputJsonValue,
      },
    })
    await expect(attach()).rejects.toMatchObject({ status: 409 })
  })
  it('kontrollspår är append-only', async () => {
    const c = (await record()).charge!
    await confirm(c)
    await expect(
      db.$executeRaw`UPDATE "ConsumptionChargeCheck" SET "ruleVersion" = 'forged' WHERE "organizationId" = ${org}`,
    ).rejects.toThrow(/append-only/)
  })
  async function waitForBlockedLock() {
    for (let n = 0; n < 100; n++) {
      const rows = await db.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())`
      if (Number(rows[0]!.n) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Ingen styrd överlappning uppstod')
  }
  it('samtidig ny bedömning väntar på konfirmeringens lås och blockerar sedan leverans', async () => {
    const c = await high()
    await decision('EXPLAINED', 'VERIFIED_CORRECT_REAL_INCREASE')
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const original = accounting.createJournalEntryForConsumptionCharge.bind(accounting)
    jest
      .spyOn(accounting, 'createJournalEntryForConsumptionCharge')
      .mockImplementationOnce(async (...args) => {
        entered()
        await hold
        return original(...args)
      })
    const first = confirm(c)
    await enteredPromise
    const second = decision('NEEDS_INVESTIGATION')
    try {
      await waitForBlockedLock()
    } finally {
      release()
    }
    await first
    await second
    await expect(attach()).rejects.toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ entries: 1, checks: 1, lines: 0 })
  })
  it('samtidiga konfirmeringar ger ett spår och en verifikation', async () => {
    const c = (await record()).charge!
    const control = await service.getChargeControl(c.id, org)
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const original = accounting.createJournalEntryForConsumptionCharge.bind(accounting)
    jest
      .spyOn(accounting, 'createJournalEntryForConsumptionCharge')
      .mockImplementationOnce(async (...args) => {
        entered()
        await hold
        return original(...args)
      })
    const first = service.confirmCharge(c.id, org, user, {
      expectedFingerprint: control.fingerprint,
    })
    await enteredPromise
    const second = service.confirmCharge(c.id, org, user, {
      expectedFingerprint: control.fingerprint,
    })
    try {
      await waitForBlockedLock()
    } finally {
      release()
    }
    await Promise.all([first, second])
    expect(await counts()).toMatchObject({ checks: 1, entries: 1 })
  })
  it('ny avläsning som vinner låset ger konflikt för väntande konfirmering', async () => {
    const c = (await record()).charge!
    const control = await service.getChargeControl(c.id, org)
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const writer = db.$transaction(async (tx) => {
      await lockConsumptionEvidence(tx, org)
      await tx.meterReading.create({
        data: {
          organizationId: org,
          meterId: meter,
          unitId: unit,
          value: 11,
          readingType: 'PERIOD_VOLUME',
          readingDate: day(1),
          periodStart: day(1),
          periodEnd: day(1),
          source: 'MANUAL',
        },
      })
      entered()
      await hold
    })
    await enteredPromise
    const attempt = service
      .confirmCharge(c.id, org, user, { expectedFingerprint: control.fingerprint })
      .then(
        () => null,
        (e) => e,
      )
    try {
      await waitForBlockedLock()
    } finally {
      release()
    }
    await writer
    expect(await attempt).toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
  })
  it('nolltariff bevarar normal konfirmering utan verifikat', async () => {
    await service.createTariff(
      { scope: 'ORGANIZATION', meterType: 'ELECTRICITY', pricePerUnit: 0, validFrom: '2026-01-02' },
      org,
    )
    const c = (await record(10, 2)).charge!
    expect(Number(c.totalAmount)).toBe(0)
    await confirm(c)
    expect(await counts()).toMatchObject({ checks: 1, entries: 0 })
  })
  it.each(['NEEDS_INVESTIGATION', 'EXPLAINED'] as const)(
    'försvunnen trendvarning upphäver inte %s eller känt fel',
    async (status) => {
      const c = await high()
      await decision(status, 'INCORRECT')
      await record(10, 2)
      expect(
        (await reviews.getReview(org)).findings.some((f) => f.readingId === c.meterReadingId),
      ).toBe(false)
      await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
      expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
    },
  )
  it('fullt avläst år utan periodiseringsbehov kräver ingen konfirmering', async () => {
    await record(10, 365)
    await expect(service.runYearEndAccrual(org, 2026, user)).resolves.toMatchObject({
      accrued: 0,
      skipped: 1,
    })
    expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
  })
  it('flera charges där en är blockerad ger inga partiella faktura- eller avi-rader', async () => {
    const c = await high()
    const normal = await db.consumptionCharge.findFirstOrThrow({
      where: { organizationId: org, periodEnd: day(1) },
    })
    await confirm(normal)
    await db.consumptionCharge.update({ where: { id: c.id }, data: { status: 'CONFIRMED' } })
    await expect(attach()).rejects.toMatchObject({ status: 409 })
    await db.consumptionCharge.updateMany({
      where: { organizationId: org },
      data: { deliveryMode: 'SEPARATE_INVOICE' },
    })
    await confirm(normal)
    await expect(service.invoiceSeparateCharges(lease, org, user)).rejects.toMatchObject({
      status: 409,
    })
    expect(await counts()).toMatchObject({ lines: 0, invoices: 0, entries: 1 })
  })
  it('alla relevanta varningar på kumulativ föregångare och target kontrolleras', async () => {
    await record(100, 1, 'CUMULATIVE')
    const c = (await record(120, 2, 'CUMULATIVE')).charge!
    await db.meterReading.create({
      data: {
        organizationId: org,
        meterId: meter,
        unitId: unit,
        value: 130,
        readingType: 'CUMULATIVE',
        readingDate: day(1),
        periodStart: day(1),
        periodEnd: day(1),
        source: 'MANUAL',
      },
    })
    const control = await service.getChargeControl(c.id, org)
    expect(control.findingCount).toBeGreaterThanOrEqual(2)
    expect(control.allowed).toBe(false)
    await expect(confirm(c)).rejects.toMatchObject({ status: 409 })
  })
  it('DB nekar korskopplat spår för annan avläsning eller organisation', async () => {
    const c = (await record()).charge!
    await confirm(c)
    const trace = await db.consumptionChargeCheck.findFirstOrThrow({
      where: { organizationId: org },
    })
    for (const extra of [{ readingId: randomUUID() }, { organizationId: randomUUID() }])
      await expect(
        db.consumptionChargeCheck.create({
          data: {
            ...trace,
            ...extra,
            id: randomUUID(),
            revision: 2,
            evidence: trace.evidence as Prisma.InputJsonValue,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' })
  })
  it.each(['INSERT', 'UPDATE', 'DELETE'] as const)(
    'rå %s av avläsning skyddas av DB-trigger utan hjälplås',
    async (op) => {
      const prior = await db.meterReading.create({
        data: {
          organizationId: org,
          meterId: meter,
          unitId: unit,
          value: 10,
          readingType: 'PERIOD_VOLUME',
          readingDate: day(1),
          periodStart: day(1),
          periodEnd: day(1),
          source: 'MANUAL',
        },
      })
      const c = (await record(10, 2)).charge!
      let release!: () => void
      let entered!: () => void
      const enteredPromise = new Promise<void>((r) => {
        entered = r
      })
      const hold = new Promise<void>((r) => {
        release = r
      })
      const original = accounting.createJournalEntryForConsumptionCharge.bind(accounting)
      jest
        .spyOn(accounting, 'createJournalEntryForConsumptionCharge')
        .mockImplementationOnce(async (...args) => {
          entered()
          await hold
          return original(...args)
        })
      const first = confirm(c)
      await enteredPromise
      const write =
        op === 'UPDATE'
          ? db.$executeRaw`UPDATE "MeterReading" SET "value"=11 WHERE "id"=${prior.id}`
          : op === 'DELETE'
            ? db.$executeRaw`DELETE FROM "MeterReading" WHERE "id"=${prior.id}`
            : db.meterReading.create({
                data: {
                  organizationId: org,
                  meterId: meter,
                  unitId: unit,
                  value: 11,
                  readingType: 'PERIOD_VOLUME',
                  readingDate: day(1),
                  periodStart: day(1),
                  periodEnd: day(1),
                  source: 'MANUAL',
                },
              })
      const second = Promise.resolve(write)
      try {
        await waitForBlockedLock()
      } finally {
        release()
      }
      await first
      await second
      expect((await service.getChargeControl(c.id, org)).hasCurrentCheck).toBe(false)
      await expect(attach()).rejects.toMatchObject({ status: 409 })
    },
  )
  it('direkt review-INSERT väntar på kontrollens lås utan hjälplås', async () => {
    const c = await high()
    await decision('EXPLAINED', 'VERIFIED_CORRECT_REAL_INCREASE')
    const row = await db.meterReadingReview.findFirstOrThrow({ where: { organizationId: org } })
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const original = accounting.createJournalEntryForConsumptionCharge.bind(accounting)
    jest
      .spyOn(accounting, 'createJournalEntryForConsumptionCharge')
      .mockImplementationOnce(async (...args) => {
        entered()
        await hold
        return original(...args)
      })
    const first = confirm(c)
    await enteredPromise
    const second = Promise.resolve(
      db.meterReadingReview.create({
        data: {
          ...row,
          id: randomUUID(),
          revision: 2,
          billingBasisDecision: 'INCORRECT',
          evidence: row.evidence as Prisma.InputJsonValue,
        },
      }),
    )
    try {
      await waitForBlockedLock()
    } finally {
      release()
    }
    await first
    await second
    await expect(attach()).rejects.toMatchObject({ status: 409 })
  })
  it('två nya beslut överlappar styrt och bara ett får revisionen', async () => {
    await high()
    const f = (await reviews.getReview(org)).findings[0]!
    const dto: SaveReadingReviewInput = {
      readingId: f.readingId,
      findingCode: f.code,
      fingerprint: f.fingerprint,
      expectedRevision: 0,
      assessment: 'EXPLAINED',
      billingBasisDecision: 'VERIFIED_CORRECT_REAL_INCREASE',
      comment: 'Verklig ökning',
    }
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const delayed = db.$extends({
      query: {
        meterReadingReview: {
          async create({ args, query }) {
            entered()
            await hold
            return query(args)
          },
        },
      },
    })
    const first = new ReadingReviewService(delayed as unknown as PrismaService).saveReview(
      org,
      user,
      dto,
    )
    await enteredPromise
    const second = reviews
      .saveReview(org, user, { ...dto, assessment: 'NEEDS_INVESTIGATION' })
      .then(
        () => null,
        (e) => e,
      )
    try {
      await waitForBlockedLock()
    } finally {
      release()
    }
    await first
    expect(await second).toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ reviews: 1, checks: 0, entries: 0 })
  })

  it('samtidig verklig aviannullering hindrar koppling till tom annullerad avi', async () => {
    const c = (await record()).charge!
    await confirm(c)
    const n = await notice()
    const notices = new AviseringService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      accounting,
      service,
      {} as never,
      {} as never,
      new RentNoticeEventsService(prisma),
    )
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const original = accounting.reverseJournalEntryForRentNotice.bind(accounting)
    jest
      .spyOn(accounting, 'reverseJournalEntryForRentNotice')
      .mockImplementationOnce(async (...args) => {
        entered()
        await hold
        return original(...args)
      })
    const first = notices.cancelNotice(n.id, org, user)
    await enteredPromise
    const second = service
      .attachRentNoticeLineCharges({
        organizationId: org,
        leaseId: lease,
        rentNoticeId: n.id,
        aviMonth: 4,
        aviYear: 2026,
      })
      .then(
        () => null,
        (e) => e,
      )
    try {
      let blocked = false
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`
        if (Number(rows[0]!.n) > 0) {
          blocked = true
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(blocked).toBe(true)
    } finally {
      release()
    }
    await first
    expect(await second).toMatchObject({ status: 404 })
    expect((await db.rentNotice.findUniqueOrThrow({ where: { id: n.id } })).status).toBe(
      'CANCELLED',
    )
    expect(await counts()).toMatchObject({ entries: 1, lines: 0 })
  })

  it('giltig bas ger verklig bokslutspost och återföring utan dubbla effekter', async () => {
    const c = (await record(10, 360)).charge!
    await confirm(c)
    const first = await service.runYearEndAccrual(org, 2026, user)
    expect(first).toMatchObject({ accrued: 1, totalNet: 100 })
    await service.runYearEndAccrual(org, 2026, user)
    expect(await counts()).toMatchObject({ checks: 1, entries: 3 })
    const entries = await db.journalEntry.findMany({
      where: { organizationId: org },
      include: { lines: true },
    })
    for (const entry of entries) {
      expect(
        entry.lines.reduce((n, l) => n + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0),
      ).toBe(0)
    }
    expect(
      await db.journalEntryLine.count({ where: { journalEntry: { organizationId: org } } }),
    ).toBe(6)
  })
  it('två samtidiga fakturaförsök skapar bara ett dokument', async () => {
    const c = (await record()).charge!
    await db.consumptionCharge.update({
      where: { id: c.id },
      data: { deliveryMode: 'SEPARATE_INVOICE' },
    })
    await confirm(c)
    let release!: () => void, entered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      entered = r
    })
    const hold = new Promise<void>((r) => {
      release = r
    })
    const delayed = db.$extends({
      query: {
        invoice: {
          async create({ args, query }) {
            entered()
            await hold
            return query(args)
          },
        },
      },
    })
    const first = new ConsumptionService(
      delayed as unknown as PrismaService,
      accounting,
      new InvoiceEventsService(prisma),
    ).invoiceSeparateCharges(lease, org, user)
    await enteredPromise
    const second = service.invoiceSeparateCharges(lease, org, user).then(
      (v) => v,
      (e) => e,
    )
    try {
      await waitForBlockedLock()
    } finally {
      release()
    }
    await first
    expect(await second).toBeNull()
    expect(await counts()).toMatchObject({ invoices: 1, entries: 1, checks: 1 })
  })

  it('två HIGH_RATE kräver bådas intyg: ett godkänt först ger NEJ, båda ger JA', async () => {
    let target: ConsumptionCharge | undefined
    for (const [i, value] of [100, 110, 120, 130, 170, 210].entries())
      target = (await record(value, i + 1, 'CUMULATIVE')).charge ?? undefined
    const findings = (await reviews.getReview(org)).findings.sort((a, b) =>
      a.readingId.localeCompare(b.readingId),
    )
    expect(findings.map((f) => f.code)).toEqual(['HIGH_RATE', 'HIGH_RATE'])
    async function attest(index: number) {
      const f = findings[index]!
      return reviews.saveReview(org, user, {
        readingId: f.readingId,
        findingCode: f.code,
        fingerprint: f.fingerprint,
        expectedRevision: 0,
        assessment: 'EXPLAINED',
        billingBasisDecision: 'VERIFIED_CORRECT_REAL_INCREASE',
        comment: 'Period, original och jämförelser kontrollerade',
      })
    }
    await attest(0)
    await expect(confirm(target!)).rejects.toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ checks: 0, entries: 0 })
    await attest(1)
    await expect(confirm(target!)).resolves.toMatchObject({ status: 'CONFIRMED' })
    const trace = await db.consumptionChargeCheck.findFirstOrThrow({
      where: { organizationId: org },
    })
    expect((trace.evidence as { findings: unknown[] }).findings).toHaveLength(2)
    expect(await counts()).toMatchObject({ checks: 1, entries: 1 })
  })
  it('obedömd varning blir inte klartecken när dubbla jämförelser gör trenden omöjlig', async () => {
    const target = await high()
    await record(10, 2)
    expect(
      (await reviews.getReview(org)).findings.some((f) => f.readingId === target.meterReadingId),
    ).toBe(false)
    await expect(confirm(target)).rejects.toMatchObject({ status: 409 })
    expect(await counts()).toMatchObject({ reviews: 0, checks: 0, entries: 0 })
  })
  it.each(['utanför jämförelsefönstret', 'före tidslucka'] as const)(
    'strukturellt fel %s blir inget permanent historikkrav',
    async (mode) => {
      await record(10, 1)
      await record(10, 1)
      let target: ConsumptionCharge
      if (mode === 'före tidslucka') target = (await record(10, 10)).charge!
      else {
        await record(10, 2)
        await record(10, 3)
        await record(10, 4)
        target = (await record(10, 5)).charge!
      }
      await expect(confirm(target)).resolves.toMatchObject({ status: 'CONFIRMED' })
      expect(await counts()).toMatchObject({ checks: 1, entries: 1 })
    },
  )
})
