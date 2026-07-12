/**
 * T1.4 / #44 — RentBackfillService (motorn för bakdaterad debitering).
 *
 * Bevisar orchestreringen (detektion, klassificering, stängd period, preskription,
 * idempotens, SYSTEM-notis) med mockade beroenden. Verifikatens balans (Σd=Σk)
 * bevisas separat i rent-backfill.verifikat.spec.ts (real AviseringService +
 * AccountingService).
 *
 * Fast systemtid 2026-07-10 → deterministiska månadsintervall och åldrar.
 */

// AviseringService drar transitivt in tunga ESM-beroenden — men vi mockar hela
// AviseringService här, så importen behöver inte laddas skarpt.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { RentBackfillService } from './rent-backfill.service'

const TODAY = new Date('2026-07-10T09:00:00.000Z')

function proratedFull(year: number, month: number) {
  return {
    proration: {
      amount: 10_000,
      periodStart: new Date(Date.UTC(year, month - 1, 1)),
      periodEnd: new Date(Date.UTC(year, month, 0)),
      daysCharged: 30,
      totalDays: 30,
      isProrated: false,
    },
    vatAmount: 0,
    totalAmount: 10_000,
  }
}

function makeService(opts: {
  startDate: Date
  billed?: Array<{ year: number; month: number }>
  closed?: Array<{ year: number; month: number }>
  createImpl?: (year: number, month: number) => unknown
  voluntaryTaxLiability?: boolean
  vatReportingPeriod?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
}) {
  const lease = {
    id: 'lease-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    monthlyRent: 10_000,
    monthlyRentExcludingVat: false,
    startDate: opts.startDate,
    endDate: null,
    status: 'ACTIVE',
    unit: { type: 'APARTMENT', voluntaryTaxLiability: opts.voluntaryTaxLiability ?? false },
  }

  const created: Array<{ year: number; month: number }> = []
  const avisering = {
    computeRentNoticeAmounts: jest.fn((_l: unknown, y: number, m: number) => proratedFull(y, m)),
    createBackfillRentNoticeInTx: jest.fn(
      async (
        _tx: unknown,
        _l: unknown,
        p: {
          year: number
          month: number
          ocrNumber: string
          dueDate: Date
          audit?: {
            actorUserId?: string | null
            ageMonths: number
            beyondWarning: boolean
            allowBeyondWarning: boolean
            hasVoluntaryTaxLiability?: boolean
            vatDeclarationAcknowledged?: boolean
          }
        },
      ) => {
        if (opts.createImpl) return opts.createImpl(p.year, p.month)
        created.push({ year: p.year, month: p.month })
        return { id: `rn-${p.year}-${p.month}`, year: p.year, month: p.month, isBackfill: true }
      },
    ),
  }

  const prisma = {
    lease: { findFirst: jest.fn().mockResolvedValue(lease) },
    rentNotice: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.billed ?? []).map((b) => ({ year: b.year, month: b.month }))),
    },
    closedAccountingPeriod: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.closed ?? []).map((c) => ({ year: c.year, month: c.month }))),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        vatReportingPeriod: opts.vatReportingPeriod ?? 'QUARTERLY',
        fiscalYearStartMonth: 1,
      }),
    },
    // $transaction kör callbacken direkt med en fejk-tx.
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb({ marker: 'tx' })),
  }
  const ocr = { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }

  const service = new RentBackfillService(
    prisma as never,
    avisering as never,
    ocr as never,
    notifications as never,
  )
  return { service, prisma, avisering, ocr, notifications, created }
}

describe('T1.4 · RentBackfillService', () => {
  beforeAll(() => {
    jest.useFakeTimers()
    jest.setSystemTime(TODAY)
  })
  afterAll(() => jest.useRealTimers())

  // ── Detektion / preview ────────────────────────────────────────────────────
  describe('detectGaps (PREVIEW — skapar INGET)', () => {
    it('hittar saknade månader [startmånad..innevarande], exklusive redan aviserade', async () => {
      // start maj 2026, idag juli 2026 → maj, jun, jul. Juni redan aviserad.
      const { service } = makeService({
        startDate: new Date('2026-05-01'),
        billed: [{ year: 2026, month: 6 }],
      })
      const preview = await service.detectGaps('lease-1', 'org-1')
      expect(preview.months.map((m) => `${m.year}-${m.month}`)).toEqual(['2026-5', '2026-7'])
      expect(preview.summary.billableCount).toBe(2)
      expect(preview.summary.billableTotal).toBe(20_000)
    })

    it('preview skapar VARKEN avi ELLER verifikat (ren detektion)', async () => {
      const { service, avisering, prisma } = makeService({ startDate: new Date('2026-05-01') })
      await service.detectGaps('lease-1', 'org-1')
      expect(avisering.createBackfillRentNoticeInTx).not.toHaveBeenCalled()
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('okänd lease → tom preview', async () => {
      const { service, prisma } = makeService({ startDate: new Date('2026-05-01') })
      prisma.lease.findFirst.mockResolvedValueOnce(null)
      const preview = await service.detectGaps('lease-x', 'org-1')
      expect(preview.months).toEqual([])
      expect(preview.summary.billableCount).toBe(0)
    })
  })

  // ── Klassificering: preskription + stängd period ───────────────────────────
  describe('klassificering', () => {
    it('preskription: >36 mån → BEYOND_HARD_CAP, 12–36 mån → BEYOND_WARNING, ≤12 → BILLABLE', async () => {
      // start jan 2023, idag juli 2026. jan-2023 = 42 mån (>36); jan-2025 = 18 (>12); jan-2026 = 6.
      const { service } = makeService({ startDate: new Date('2023-01-01') })
      const preview = await service.detectGaps('lease-1', 'org-1')
      const byKey = new Map(preview.months.map((m) => [`${m.year}-${m.month}`, m.status]))
      expect(byKey.get('2023-1')).toBe('BEYOND_HARD_CAP') // 42 mån
      expect(byKey.get('2025-1')).toBe('BEYOND_WARNING') // 18 mån
      expect(byKey.get('2026-1')).toBe('BILLABLE') // 6 mån
      // Dag-säker gräns: EXAKT 36 mån (juli 2023) blockeras hårt (>=36), inte
      // warning — en 36-mån-fordran kan dag-för-dag redan vara preskriberad.
      expect(byKey.get('2023-7')).toBe('BEYOND_HARD_CAP')
      // 35 mån (aug 2023) är fortfarande tillåten (warning-vägen).
      expect(byKey.get('2023-8')).toBe('BEYOND_WARNING')
    })

    it('stängd räkenskapsperiod → CLOSED_PERIOD (går före warning men efter hard cap)', async () => {
      const { service } = makeService({
        startDate: new Date('2026-05-01'),
        closed: [{ year: 2026, month: 6 }],
      })
      const preview = await service.detectGaps('lease-1', 'org-1')
      const jun = preview.months.find((m) => m.month === 6)!
      expect(jun.status).toBe('CLOSED_PERIOD')
      expect(preview.summary.closedCount).toBe(1)
    })
  })

  // ── Skapande (efter bekräftelse) ───────────────────────────────────────────
  describe('createBackfillNotices (bekräftat skapande)', () => {
    it('skapar BILLABLE månader atomiskt, framåtklampad förfallodag delas av batchen', async () => {
      const { service, avisering, prisma } = makeService({ startDate: new Date('2026-05-01') })
      const res = await service.createBackfillNotices('lease-1', 'org-1')
      expect(res.created).toHaveLength(3) // maj, jun, jul
      // varje skapande gick via en egen $transaction (atomiskt notis+verifikat)
      expect(prisma.$transaction).toHaveBeenCalledTimes(3)
      // förfallodagen är framåt (efter idag), samma för alla
      const dueDates = avisering.createBackfillRentNoticeInTx.mock.calls.map((c) => c[2].dueDate)
      for (const d of dueDates) expect(d.getTime()).toBeGreaterThan(TODAY.getTime())
      expect(new Set(dueDates.map((d: Date) => d.getTime())).size).toBe(1)
    })

    it('BEYOND_HARD_CAP skapas ALDRIG (hård preskriptionsspärr)', async () => {
      const { res, avisering } = await (async () => {
        const s = makeService({ startDate: new Date('2023-01-01') })
        const r = await s.service.createBackfillNotices('lease-1', 'org-1')
        return { res: r, avisering: s.avisering }
      })()
      expect(res.blockedHardCap).toBeGreaterThan(0)
      // ingen skapad avi avser en >36-mån-månad
      for (const call of avisering.createBackfillRentNoticeInTx.mock.calls) {
        const { year, month } = call[2]
        const age = (2026 - year) * 12 + (7 - month)
        expect(age).toBeLessThanOrEqual(36)
      }
    })

    it('BEYOND_WARNING skapas ENDAST med allowBeyondWarning', async () => {
      const base = () => makeService({ startDate: new Date('2025-01-01') }) // 18 mån → warning
      const off = base()
      const rOff = await off.service.createBackfillNotices('lease-1', 'org-1')
      expect(rOff.skippedBeyondWarning).toBeGreaterThan(0)
      const warnCreatedOff = off.avisering.createBackfillRentNoticeInTx.mock.calls.some((c) => {
        const age = (2026 - c[2].year) * 12 + (7 - c[2].month)
        return age > 12
      })
      expect(warnCreatedOff).toBe(false)

      const on = base()
      await on.service.createBackfillNotices('lease-1', 'org-1', {
        allowBeyondWarning: true,
        actorRole: 'ADMIN',
      })
      const warnCreatedOn = on.avisering.createBackfillRentNoticeInTx.mock.calls.some((c) => {
        const age = (2026 - c[2].year) * 12 + (7 - c[2].month)
        return age > 12
      })
      expect(warnCreatedOn).toBe(true)
    })

    // ── ADMIN/OWNER-grind för >12-mån-override (hyresjurist MEDIUM, #20) ───────
    it('allowBeyondWarning från MANAGER → ForbiddenException, inget skapas', async () => {
      const { service, avisering } = makeService({ startDate: new Date('2025-01-01') })
      await expect(
        service.createBackfillNotices('lease-1', 'org-1', {
          allowBeyondWarning: true,
          actorRole: 'MANAGER',
        }),
      ).rejects.toThrow(ForbiddenException)
      expect(avisering.createBackfillRentNoticeInTx).not.toHaveBeenCalled()
    })

    it('allowBeyondWarning utan roll → ForbiddenException (fail-closed)', async () => {
      const { service } = makeService({ startDate: new Date('2025-01-01') })
      await expect(
        service.createBackfillNotices('lease-1', 'org-1', { allowBeyondWarning: true }),
      ).rejects.toThrow(ForbiddenException)
    })

    it.each(['ADMIN', 'OWNER'] as const)(
      'allowBeyondWarning från %s → tillåtet (>12-mån skapas)',
      async (actorRole) => {
        const { service, avisering } = makeService({ startDate: new Date('2025-01-01') })
        await service.createBackfillNotices('lease-1', 'org-1', {
          allowBeyondWarning: true,
          actorRole,
        })
        const warnCreated = avisering.createBackfillRentNoticeInTx.mock.calls.some((c) => {
          const age = (2026 - c[2].year) * 12 + (7 - c[2].month)
          return age > 12
        })
        expect(warnCreated).toBe(true)
      },
    )

    it('MANAGER UTAN override → normal (≤12 mån) efterdebitering fungerar', async () => {
      const { service } = makeService({ startDate: new Date('2026-05-01') }) // alla ≤12 mån
      const res = await service.createBackfillNotices('lease-1', 'org-1', { actorRole: 'MANAGER' })
      expect(res.created.length).toBeGreaterThan(0)
    })

    it('stängd period → ingen avi + SYSTEM-notis (hård spärr, aldrig orphan)', async () => {
      const { service, avisering, notifications } = makeService({
        startDate: new Date('2026-05-01'),
        closed: [{ year: 2026, month: 6 }],
      })
      const res = await service.createBackfillNotices('lease-1', 'org-1')
      expect(res.skippedClosed).toBe(1)
      // juni skapades ALDRIG
      const juneCreated = avisering.createBackfillRentNoticeInTx.mock.calls.some(
        (c) => c[2].month === 6,
      )
      expect(juneCreated).toBe(false)
      expect(notifications.createForAllOrgUsers).toHaveBeenCalledTimes(1)
      expect(notifications.createForAllOrgUsers.mock.calls[0][3]).toContain('2026-06')
    })

    it('idempotent: P2002 (redan aviserad) → skippedExisting, inget kastas', async () => {
      const { service } = makeService({
        startDate: new Date('2026-06-01'),
        createImpl: () => {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: '5',
          })
        },
      })
      const res = await service.createBackfillNotices('lease-1', 'org-1')
      expect(res.created).toHaveLength(0)
      expect(res.skippedExisting).toBe(2) // jun + jul
    })

    it('ConflictException (period stängdes mellan detekt och skapande) → skippedClosed + notis', async () => {
      const { service, notifications } = makeService({
        startDate: new Date('2026-07-01'),
        createImpl: () => {
          throw new ConflictException('Bokföringsperioden 2026-07 är stängd')
        },
      })
      const res = await service.createBackfillNotices('lease-1', 'org-1')
      expect(res.skippedClosed).toBe(1)
      expect(notifications.createForAllOrgUsers).toHaveBeenCalledTimes(1)
    })

    // Bokförings-expert CRITICAL: kontoplan saknar konto → verifikatet kastar →
    // tx rullas tillbaka (ingen orphan-avi) → egen kategori + SYSTEM-notis.
    it('UnprocessableEntityException (saknat konto) → skippedMissingAccount + SYSTEM-notis', async () => {
      const { service, notifications } = makeService({
        startDate: new Date('2026-06-01'),
        createImpl: () => {
          throw new UnprocessableEntityException('Kontoplanen saknar konto 3911')
        },
      })
      const res = await service.createBackfillNotices('lease-1', 'org-1')
      expect(res.skippedMissingAccount).toBe(2) // jun + jul
      expect(res.created).toHaveLength(0)
      expect(notifications.createForAllOrgUsers).toHaveBeenCalledTimes(1)
      expect(notifications.createForAllOrgUsers.mock.calls[0][2]).toContain('konto')
    })

    // ── PR2: actor-audit trådas till varje skapad avi ────────────────────────
    it('actor-audit: actorUserId + ageMonths trådas till varje createBackfillRentNoticeInTx', async () => {
      const { service, avisering } = makeService({ startDate: new Date('2026-05-01') })
      await service.createBackfillNotices('lease-1', 'org-1', { actorUserId: 'user-9' })
      expect(avisering.createBackfillRentNoticeInTx).toHaveBeenCalledTimes(3)
      for (const call of avisering.createBackfillRentNoticeInTx.mock.calls) {
        expect(call[2].audit).toMatchObject({ actorUserId: 'user-9', allowBeyondWarning: false })
        expect(typeof call[2].audit?.ageMonths).toBe('number')
      }
    })

    it('actor-audit: >12-mån-avi loggas med beyondWarning=true + allowBeyondWarning=true', async () => {
      const { service, avisering } = makeService({ startDate: new Date('2025-01-01') }) // 18 mån
      await service.createBackfillNotices('lease-1', 'org-1', {
        allowBeyondWarning: true,
        actorUserId: 'user-1',
        actorRole: 'ADMIN',
      })
      const warnCall = avisering.createBackfillRentNoticeInTx.mock.calls.find((c) => {
        const age = (2026 - c[2].year) * 12 + (7 - c[2].month)
        return age > 12
      })!
      expect(warnCall[2].audit).toMatchObject({
        beyondWarning: true,
        allowBeyondWarning: true,
        actorUserId: 'user-1',
      })
    })
  })

  // ── Momsperiod-flagga (PR2 disclaimer-underlag) ────────────────────────────
  it('detectGaps surfar hasVoluntaryTaxLiability för momspliktig lokal', async () => {
    const on = makeService({ startDate: new Date('2026-05-01'), voluntaryTaxLiability: true })
    expect((await on.service.detectGaps('lease-1', 'org-1')).hasVoluntaryTaxLiability).toBe(true)
    const off = makeService({ startDate: new Date('2026-05-01') })
    expect((await off.service.detectGaps('lease-1', 'org-1')).hasVoluntaryTaxLiability).toBe(false)
  })

  // ── PR3: periodspecifika momsperioder ──────────────────────────────────────
  describe('detectGaps vatPeriods (PR3 — periodspecifik momsvarning)', () => {
    it('momspliktig lokal → namnger berörda momsperioder (kvartal)', async () => {
      // start maj 2026, idag juli 2026 → maj, jun (Q2), jul (Q3).
      const { service } = makeService({
        startDate: new Date('2026-05-01'),
        voluntaryTaxLiability: true,
        vatReportingPeriod: 'QUARTERLY',
      })
      const preview = await service.detectGaps('lease-1', 'org-1')
      expect(preview.vatPeriods).toEqual(['Q2 2026', 'Q3 2026'])
    })

    it('respekterar org:ens redovisningsperiod (månad)', async () => {
      const { service } = makeService({
        startDate: new Date('2026-05-01'),
        voluntaryTaxLiability: true,
        vatReportingPeriod: 'MONTHLY',
      })
      const preview = await service.detectGaps('lease-1', 'org-1')
      expect(preview.vatPeriods).toEqual(['maj 2026', 'juni 2026', 'juli 2026'])
    })

    it('helår → en periodetikett per år', async () => {
      const { service } = makeService({
        startDate: new Date('2026-05-01'),
        voluntaryTaxLiability: true,
        vatReportingPeriod: 'YEARLY',
      })
      const preview = await service.detectGaps('lease-1', 'org-1')
      expect(preview.vatPeriods).toEqual(['2026'])
    })

    it('icke-momspliktig lokal → INGA momsperioder (ingen falsk varning)', async () => {
      const { service, prisma } = makeService({ startDate: new Date('2026-05-01') })
      const preview = await service.detectGaps('lease-1', 'org-1')
      expect(preview.vatPeriods).toEqual([])
      // ingen onödig org-query för icke-momspliktig lokal
      expect(prisma.organization.findUnique).not.toHaveBeenCalled()
    })
  })

  // ── Momsdeklarations-grind (bokförings HIGH) ───────────────────────────────
  it('momspliktig lokal UTAN vatDeclarationAcknowledged → KASTAR, inget skapas', async () => {
    const { service, avisering } = makeService({
      startDate: new Date('2026-05-01'),
      voluntaryTaxLiability: true,
    })
    await expect(
      service.createBackfillNotices('lease-1', 'org-1', { actorUserId: 'u1' }),
    ).rejects.toThrow(UnprocessableEntityException)
    expect(avisering.createBackfillRentNoticeInTx).not.toHaveBeenCalled()
  })

  it('momspliktig lokal MED vatDeclarationAcknowledged → skapas + loggas i audit', async () => {
    const { service, avisering } = makeService({
      startDate: new Date('2026-05-01'),
      voluntaryTaxLiability: true,
    })
    const res = await service.createBackfillNotices('lease-1', 'org-1', {
      actorUserId: 'u1',
      vatDeclarationAcknowledged: true,
    })
    expect(res.created.length).toBeGreaterThan(0)
    for (const call of avisering.createBackfillRentNoticeInTx.mock.calls) {
      expect(call[2].audit).toMatchObject({
        hasVoluntaryTaxLiability: true,
        vatDeclarationAcknowledged: true,
      })
    }
  })

  it('momsfri bostad → ingen momsgrind (vatDeclarationAcknowledged ej krävt)', async () => {
    const { service } = makeService({ startDate: new Date('2026-05-01') })
    const res = await service.createBackfillNotices('lease-1', 'org-1', { actorUserId: 'u1' })
    expect(res.created.length).toBeGreaterThan(0)
  })

  // ── detectQueue: kön + manuell retrigger (#58) ─────────────────────────────
  describe('detectQueue (kön över alla aktiva kontrakt = manuell retrigger #58)', () => {
    function makeQueueService(
      leases: Array<Record<string, unknown>>,
      billedByLease: Record<string, Array<{ year: number; month: number }>> = {},
    ) {
      const avisering = {
        computeRentNoticeAmounts: jest.fn((_l: unknown, y: number, m: number) =>
          proratedFull(y, m),
        ),
      }
      const prisma = {
        lease: { findMany: jest.fn().mockResolvedValue(leases) },
        rentNotice: {
          findMany: jest.fn((args: { where: { leaseId: string } }) =>
            Promise.resolve(billedByLease[args.where.leaseId] ?? []),
          ),
        },
        closedAccountingPeriod: { findMany: jest.fn().mockResolvedValue([]) },
      }
      const service = new RentBackfillService(
        prisma as never,
        avisering as never,
        {} as never,
        {} as never,
      )
      return { service, prisma }
    }

    function leaseRow(over: Record<string, unknown>) {
      return {
        id: 'lease-A',
        organizationId: 'org-1',
        tenantId: 't-A',
        monthlyRent: 10_000,
        monthlyRentExcludingVat: false,
        startDate: new Date('2026-05-01'),
        endDate: null,
        status: 'ACTIVE',
        tenant: { type: 'INDIVIDUAL', firstName: 'Anna', lastName: 'Ek', companyName: null },
        unit: {
          type: 'APARTMENT',
          voluntaryTaxLiability: false,
          name: 'Lgh 1',
          unitNumber: '1101',
          property: { name: 'Fast', street: 'Storgatan 1' },
        },
        ...over,
      }
    }

    it('listar kontrakt med debiterbara luckor med etiketter + flaggor', async () => {
      const { service } = makeQueueService([
        leaseRow({
          id: 'lease-A',
          unit: {
            type: 'OFFICE',
            voluntaryTaxLiability: true,
            name: 'Lokal',
            unitNumber: 'L1',
            property: { name: 'Fast', street: 'Storgatan 1' },
          },
        }),
      ])
      const queue = await service.detectQueue('org-1')
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({
        leaseId: 'lease-A',
        tenantName: 'Anna Ek',
        unitLabel: 'L1 — Lokal',
        propertyLabel: 'Storgatan 1',
        hasVoluntaryTaxLiability: true,
        requiresApproval: false, // maj–jul 2026 = ≤12 mån
      })
      expect(queue[0]!.summary.billableCount).toBe(3)
    })

    it('requiresApproval=true när kontraktet har månader >12 mån bakåt', async () => {
      const { service } = makeQueueService([
        leaseRow({ id: 'lease-A', startDate: new Date('2025-01-01') }), // 18 mån → warning
      ])
      const queue = await service.detectQueue('org-1')
      expect(queue[0]!.requiresApproval).toBe(true)
      expect(queue[0]!.maxAgeMonths).toBeGreaterThan(12)
    })

    it('exkluderar kontrakt utan debiterbara luckor (framtida start → tom)', async () => {
      const { service } = makeQueueService([
        leaseRow({ id: 'lease-future', startDate: new Date('2026-12-01') }),
      ])
      expect(await service.detectQueue('org-1')).toHaveLength(0)
    })
  })
})
