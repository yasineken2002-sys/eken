/**
 * T1.3 — gap-avins förfallodag + EXPIRED-avtalets sista avi.
 *
 * Bevisar:
 *   A) Succession-gap-avin får förfallodag enligt JB 12 kap 20 § 2 st
 *      (sista vardagen före den period hyran avser, framåtklampad om dagen
 *      passerat) — INTE inflyttningslogiken (daysBeforeMoveIn), som fel-
 *      klassificerar gap-perioden som en "första" period.
 *   B) Manuell aktivering behåller inflyttningslogiken (oförändrat beteende).
 *   C) generateMonthlyNotices inkluderar EXPIRED avtal som fortfarande täcker
 *      dagar i månaden — gamla avtalets sista prorata-avi genereras även om
 *      förnyelsen (ACTIVE→EXPIRED) hann före månadsgenereringen. TERMINATED
 *      ingår inte (rymmer avbrutna utkast som aldrig varit i kraft).
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { rentDueDateForPeriodStart, calculateFirstPaymentDueDate } from '@eken/shared'
import { AviseringService } from './avisering.service'

// Startdatum ~2 månader fram, den 1:a i månaden — framtida så att "aldrig i
// förflutet"-klampningen inte utjämnar skillnaden mellan de två förfallodags-
// vägarna (JB 12:20 vs inflyttningsoffset) och testet förblir stabilt över tid.
function futureMonthStart(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return new Date(d.getFullYear(), d.getMonth() + 2, 1)
}

function makeInitialNoticesRig(startDate: Date) {
  const lease = {
    id: 'lease-new',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    monthlyRent: 10_000,
    monthlyRentExcludingVat: false,
    depositAmount: 0, // ingen deposition-avi — isolerar hyresavins förfallodag
    startDate,
    endDate: null,
    status: 'ACTIVE',
    tenant: { id: 'tenant-1', email: null, type: 'INDIVIDUAL' },
    unit: {
      id: 'unit-1',
      type: 'APARTMENT',
      voluntaryTaxLiability: false,
      name: 'Lgh 1',
      property: {},
    },
  }
  const prisma = {
    lease: { findUnique: jest.fn().mockResolvedValue(lease) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ daysBeforeMoveInForFirstPayment: 7 }),
    },
    rentNotice: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'rn-1', ...data }),
        ),
    },
  }
  const ocrService = { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') }
  const accounting = { createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }) } // prettier-ignore
  const noop = {}
  const service = new AviseringService(
    prisma as never,
    ocrService as never,
    noop as never, // mail
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
    accounting as never,
    { attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0) } as never,
    noop as never, // miscCharges
    { ensureDepositForNotice: jest.fn() } as never,
  )
  return { service, prisma }
}

describe('T1.3 · A/B: gap-avins förfallodag', () => {
  it('A: succession → sista vardagen före periodstart (JB 12 kap 20 §), inte inflyttningsoffset', async () => {
    const startDate = futureMonthStart()
    const { service, prisma } = makeInitialNoticesRig(startDate)

    await service.createInitialNoticesForLease('lease-new', {
      skipDeposit: true,
      succession: true,
    })

    const data = prisma.rentNotice.create.mock.calls[0]![0].data as { dueDate: Date }
    const expected = rentDueDateForPeriodStart(startDate)
    expect(data.dueDate.getTime()).toBe(expected.getTime())
    // …och skiljer sig från inflyttningslogiken (annars bevisar testet inget)
    const moveInDue = calculateFirstPaymentDueDate(startDate, 7)
    expect(data.dueDate.getTime()).not.toBe(moveInDue.getTime())
  })

  it('B: manuell aktivering → oförändrad inflyttningslogik (daysBeforeMoveIn)', async () => {
    const startDate = futureMonthStart()
    const { service, prisma } = makeInitialNoticesRig(startDate)

    await service.createInitialNoticesForLease('lease-new', {})

    const data = prisma.rentNotice.create.mock.calls[0]![0].data as { dueDate: Date }
    const expected = calculateFirstPaymentDueDate(startDate, 7)
    expect(data.dueDate.getTime()).toBe(expected.getTime())
  })

  it('gap-förfallodagen föds aldrig förfallen: passerad lagstadgad dag klampas framåt', () => {
    // Auto-förnyelse körs dagen EFTER gamla slutdatumet → "sista vardagen före
    // perioden" har redan passerat. En avi med förfallodag i förfluten tid
    // skulle trilla rakt in i kravtrappan.
    const yesterdayStart = new Date()
    yesterdayStart.setHours(0, 0, 0, 0)
    yesterdayStart.setDate(yesterdayStart.getDate() - 1)
    const due = rentDueDateForPeriodStart(yesterdayStart)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    expect(due.getTime()).toBeGreaterThanOrEqual(today.getTime())
  })
})

describe('T1.3 · C: EXPIRED avtal med dagar kvar i månaden aviseras', () => {
  function makeMonthlyRig(leases: unknown[]) {
    const prisma = {
      lease: { findMany: jest.fn().mockResolvedValue(leases) },
      rentNotice: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'rn-1',
            ...data,
            type: 'RENT',
            lease: { unit: { type: 'APARTMENT', property: {} } },
            tenant: { email: null },
          }),
        ),
      },
    }
    const noop = {}
    const service = new AviseringService(
      prisma as never,
      { assignOcrToTenant: jest.fn().mockResolvedValue('1234567890') } as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      { createJournalEntryForRentNotice: jest.fn().mockResolvedValue({ id: 'je-1' }) } as never,
      { attachRentNoticeLineCharges: jest.fn().mockResolvedValue(0) } as never,
      { attachMiscChargesToRentNotice: jest.fn().mockResolvedValue(0) } as never,
      noop as never,
    )
    return { service, prisma }
  }

  it('urvalet: ACTIVE eller (EXPIRED och endDate ≥ månadens start) — aldrig TERMINATED', async () => {
    const { service, prisma } = makeMonthlyRig([])
    await service.generateMonthlyNotices('org-1', 6, 2026)

    const where = prisma.lease.findMany.mock.calls[0]![0].where
    expect(where.organizationId).toBe('org-1')
    expect(where.OR).toEqual([
      { status: 'ACTIVE' },
      { status: 'EXPIRED', endDate: { gte: new Date(2026, 5, 1) } },
    ])
  })

  it('EXPIRED avtal (förnyat) med endDate 20 juni → prorata-avi 1–20 juni', async () => {
    const expired = {
      id: 'lease-old',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      status: 'EXPIRED',
      monthlyRent: 30_000,
      monthlyRentExcludingVat: false,
      startDate: new Date('2025-07-01'),
      endDate: new Date('2026-06-20'),
      tenant: { id: 'tenant-1', email: null, type: 'INDIVIDUAL' },
      unit: {
        id: 'unit-1',
        type: 'APARTMENT',
        voluntaryTaxLiability: false,
        name: 'Lgh 1',
        property: {},
      },
    }
    const { service, prisma } = makeMonthlyRig([expired])

    const result = await service.generateMonthlyNotices('org-1', 6, 2026)

    expect(result.created).toBe(1)
    const data = prisma.rentNotice.create.mock.calls[0]![0].data as Record<string, unknown>
    expect(data['leaseId']).toBe('lease-old')
    expect(data['daysCharged']).toBe(20)
    expect(data['isProrated']).toBe(true)
    expect((data['periodEnd'] as Date).getDate()).toBe(20)
    // 30 000 × 20/30 = 20 000 — dagarna 1–20 tappas inte längre
    expect(data['amount']).toBe(20_000)
  })
})
