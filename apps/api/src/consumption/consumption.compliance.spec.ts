/**
 * ConsumptionService — IMD intake (PR 2): avläsningar in → DRAFT-charges ut.
 *
 * Fokus (per krav):
 *  • recordReading() är EN källagnostisk väg (MANUAL/IMPORT/API) och idempotent
 *    på (meterId + externalId) — samma avläsning skapar aldrig en dubblett.
 *  • CUMULATIVE: förbrukning = differens mot föregående avläsning; första
 *    avläsningen är baslinje (ingen charge); lägre värde avvisas (mätarbyte) så
 *    att differensen ALDRIG blir negativ.
 *  • PERIOD_VOLUME: värdet är periodförbrukningen.
 *  • Moms snapshotas via vatRateForRent (unit-typ + voluntaryTaxLiability) →
 *    EXEMPT för bostad, TAXABLE_25 för momspliktig enhet. Aldrig hårdkodat.
 *  • PR 2 stannar vid DRAFT-charge: inget verifikat, ingen 1510-fordran.
 *  • RBAC: skriv (mätare/tariff/avläsning) kräver MANAGER/ADMIN/OWNER; läs öppen.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RolesGuard } from '../common/guards/roles.guard'
import { ConsumptionService } from './consumption.service'
import { ConsumptionController } from './consumption.controller'

function defaultMeter(over: Record<string, unknown> = {}) {
  return {
    id: 'meter-1',
    organizationId: 'org-1',
    unitId: 'unit-1',
    type: 'ELECTRICITY',
    status: 'ACTIVE',
    unit: {
      id: 'unit-1',
      type: 'APARTMENT',
      voluntaryTaxLiability: false,
      propertyId: 'prop-1',
      property: { consumptionBillingMode: 'RENT_NOTICE_LINE' },
    },
    ...over,
  }
}

function defaultLease(over: Record<string, unknown> = {}) {
  return { id: 'lease-1', tenantId: 'ten-1', consumptionBillingMode: null, ...over }
}

function defaultTariff(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    scope: 'ORGANIZATION',
    propertyId: null,
    unitId: null,
    meterType: 'ELECTRICITY',
    pricePerUnit: 2.5,
    validFrom: new Date('2026-01-01'),
    validTo: null,
    ...over,
  }
}

function chargeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'charge-1',
    organizationId: 'org-1',
    leaseId: 'lease-1',
    unitId: 'unit-1',
    tenantId: 'ten-1',
    meterType: 'ELECTRICITY',
    status: 'DRAFT',
    netAmount: 600,
    vatStatus: 'EXEMPT',
    vatAmount: 0,
    totalAmount: 600,
    periodEnd: new Date('2026-05-31'),
    ...over,
  }
}

type MockTable = Record<string, jest.Mock>
interface MockPrisma {
  meter: MockTable
  unit: MockTable
  property: MockTable
  lease: MockTable
  meterReading: MockTable
  consumptionTariff: MockTable
  consumptionCharge: MockTable
  $transaction: jest.Mock
}

interface Opts {
  meter?: Record<string, unknown>
  lease?: Record<string, unknown> | null
  previousReading?: { value: number } | null
  existingReading?: Record<string, unknown> | null
  existingCharge?: Record<string, unknown> | null
  tariffs?: Record<string, unknown>[]
}

function makeService(o: Opts = {}) {
  const meter = o.meter ?? defaultMeter()
  const prisma: Record<string, unknown> = {
    meter: { findFirst: jest.fn().mockResolvedValue(meter) },
    unit: { findFirst: jest.fn().mockResolvedValue({ id: 'unit-1' }) },
    property: { findFirst: jest.fn().mockResolvedValue({ id: 'prop-1' }) },
    lease: {
      findFirst: jest.fn().mockResolvedValue('lease' in o ? o.lease : defaultLease()),
    },
    meterReading: {
      findUnique: jest.fn().mockResolvedValue(o.existingReading ?? null),
      findFirst: jest.fn().mockResolvedValue(o.previousReading ?? null),
      create: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'reading-1', ...data })),
    },
    consumptionTariff: {
      findMany: jest.fn().mockResolvedValue(o.tariffs ?? [defaultTariff()]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 't-new', ...data })),
    },
    consumptionCharge: {
      findFirst: jest.fn().mockResolvedValue(o.existingCharge ?? null),
      create: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'charge-1', ...data })),
      update: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ ...chargeRow(), ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma))
  const accounting = {
    createJournalEntryForConsumptionCharge: jest.fn().mockResolvedValue({ id: 'je-1' }),
  }
  return {
    service: new ConsumptionService(prisma as never, accounting as never),
    prisma: prisma as unknown as MockPrisma,
    accounting,
  }
}

const dtoBase = {
  meterId: 'meter-1',
  source: 'MANUAL' as const,
  readingDate: '2026-05-31',
  periodStart: '2026-05-01',
  periodEnd: '2026-05-31',
}

describe('recordReading — idempotens', () => {
  it('returnerar befintlig avläsning utan att skapa en ny vid samma (meterId, externalId)', async () => {
    const existing = { id: 'reading-99', meterId: 'meter-1', externalId: 'ext-1' }
    const { service, prisma } = makeService({ existingReading: existing })

    const res = await service.recordReading(
      { ...dtoBase, value: 1240, externalId: 'ext-1' } as never,
      'org-1',
      'user-9',
    )

    expect(res.idempotent).toBe(true)
    expect(res.reading).toBe(existing)
    expect(prisma.meterReading.create).not.toHaveBeenCalled()
    expect(prisma.consumptionCharge.create).not.toHaveBeenCalled()
  })
})

describe('recordReading — CUMULATIVE (differens)', () => {
  it('beräknar förbrukning som differens mot föregående avläsning', async () => {
    const { service, prisma } = makeService({ previousReading: { value: 1000 } })

    const res = await service.recordReading(
      { ...dtoBase, value: 1240, readingType: 'CUMULATIVE' } as never,
      'org-1',
      'user-9',
    )

    expect(Number(res.charge?.quantity)).toBe(240)
    expect(Number(res.charge?.netAmount)).toBe(600) // 240 × 2.5
    expect(prisma.consumptionCharge.create).toHaveBeenCalledTimes(1)
  })

  it('första avläsningen är baslinje — ingen charge skapas', async () => {
    const { service, prisma } = makeService({ previousReading: null })

    const res = await service.recordReading(
      { ...dtoBase, value: 1000, readingType: 'CUMULATIVE' } as never,
      'org-1',
      'user-9',
    )

    expect(res.charge).toBeNull()
    expect(prisma.meterReading.create).toHaveBeenCalledTimes(1)
    expect(prisma.consumptionCharge.create).not.toHaveBeenCalled()
  })

  it('avvisar lägre mätarställning än föregående (mätarbyte) — differensen blir aldrig negativ', async () => {
    const { service } = makeService({ previousReading: { value: 1240 } })

    await expect(
      service.recordReading(
        { ...dtoBase, value: 1000, readingType: 'CUMULATIVE' } as never,
        'org-1',
        'user-9',
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('recordReading — PERIOD_VOLUME', () => {
  it('använder värdet direkt som periodförbrukning', async () => {
    const { service } = makeService()

    const res = await service.recordReading(
      { ...dtoBase, value: 300, readingType: 'PERIOD_VOLUME' } as never,
      'org-1',
      'user-9',
    )

    expect(Number(res.charge?.quantity)).toBe(300)
    expect(Number(res.charge?.netAmount)).toBe(750) // 300 × 2.5
  })
})

describe('recordReading — moms-snapshot', () => {
  it('EXEMPT för bostad (APARTMENT) — vatRate 0, ingen moms', async () => {
    const { service } = makeService({ previousReading: { value: 1000 } })

    const res = await service.recordReading({ ...dtoBase, value: 1240 } as never, 'org-1', 'user-9')

    expect(res.charge?.vatStatus).toBe('EXEMPT')
    expect(res.charge?.vatRate).toBe(0)
    expect(Number(res.charge?.vatAmount)).toBe(0)
    expect(Number(res.charge?.totalAmount)).toBe(600)
  })

  it('TAXABLE_25 för momspliktig lokal (frivillig skattskyldighet)', async () => {
    const meter = defaultMeter({
      unit: {
        id: 'unit-1',
        type: 'OFFICE',
        voluntaryTaxLiability: true,
        propertyId: 'prop-1',
        property: { consumptionBillingMode: 'RENT_NOTICE_LINE' },
      },
    })
    const { service } = makeService({ meter, previousReading: { value: 1000 } })

    const res = await service.recordReading({ ...dtoBase, value: 1240 } as never, 'org-1', 'user-9')

    expect(res.charge?.vatStatus).toBe('TAXABLE_25')
    expect(res.charge?.vatRate).toBe(25)
    expect(Number(res.charge?.vatAmount)).toBe(150) // 600 × 25%
    expect(Number(res.charge?.totalAmount)).toBe(750)
  })
})

describe('recordReading — debiterbarhet (PR 2 stannar vid DRAFT)', () => {
  it('skapar charge i status DRAFT, kind ACTUAL — inget verifikat/fordran', async () => {
    const { service } = makeService({ previousReading: { value: 1000 } })

    const res = await service.recordReading({ ...dtoBase, value: 1240 } as never, 'org-1', 'user-9')

    expect(res.charge?.status).toBe('DRAFT')
    expect(res.charge?.kind).toBe('ACTUAL')
    expect(res.charge?.invoiceId).toBeUndefined()
  })

  it('vakant enhet (inget aktivt avtal) → avläsning sparas, ingen charge', async () => {
    const { service, prisma } = makeService({ lease: null, previousReading: { value: 1000 } })

    const res = await service.recordReading({ ...dtoBase, value: 1240 } as never, 'org-1', 'user-9')

    expect(res.charge).toBeNull()
    expect(prisma.meterReading.create).toHaveBeenCalledTimes(1)
  })

  it('avvisar debiterbar avläsning utan gällande tariff (konfigurationsfel)', async () => {
    const { service } = makeService({ previousReading: { value: 1000 }, tariffs: [] })

    await expect(
      service.recordReading({ ...dtoBase, value: 1240 } as never, 'org-1', 'user-9'),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('createTariff — historik', () => {
  it('stänger föregående gällande tariff dagen innan den nya börjar gälla', async () => {
    const { service, prisma } = makeService()

    await service.createTariff(
      {
        scope: 'ORGANIZATION',
        meterType: 'ELECTRICITY',
        pricePerUnit: 3.0,
        validFrom: '2026-06-01',
      } as never,
      'org-1',
    )

    expect(prisma.consumptionTariff.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ validTo: null, meterType: 'ELECTRICITY' }),
        data: { validTo: new Date('2026-05-31') },
      }),
    )
    expect(prisma.consumptionTariff.create).toHaveBeenCalledTimes(1)
  })
})

describe('confirmCharge — DRAFT → CONFIRMED (PR 3)', () => {
  it('sätter CONFIRMED atomärt (villkorad på DRAFT) och bokför verifikat', async () => {
    const { service, prisma, accounting } = makeService({ existingCharge: chargeRow() })

    await service.confirmCharge('charge-1', 'org-1', 'user-9')

    // Atomär, race-säker övergång: status:'DRAFT' i WHERE hindrar att en samtidig
    // CANCELLED skrivs över till CONFIRMED.
    expect(prisma.consumptionCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'charge-1', organizationId: 'org-1', status: 'DRAFT' },
      data: { status: 'CONFIRMED' },
    })
    expect(accounting.createJournalEntryForConsumptionCharge).toHaveBeenCalledTimes(1)
  })

  it('annullerad post kan inte bokföras (updateMany matchar inte CANCELLED)', async () => {
    const { service, accounting } = makeService({
      existingCharge: chargeRow({ status: 'CANCELLED' }),
    })
    await expect(service.confirmCharge('charge-1', 'org-1', 'user-9')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(accounting.createJournalEntryForConsumptionCharge).not.toHaveBeenCalled()
  })

  it('redan CONFIRMED: idempotent self-heal — bokför (idempotent), kastar inte', async () => {
    const { service, accounting } = makeService({
      existingCharge: chargeRow({ status: 'CONFIRMED' }),
    })
    await expect(service.confirmCharge('charge-1', 'org-1', 'user-9')).resolves.toBeDefined()
    expect(accounting.createJournalEntryForConsumptionCharge).toHaveBeenCalledTimes(1)
  })

  it('bokföringsfel fäller inte confirm:en (loggas)', async () => {
    const { service, accounting } = makeService({ existingCharge: chargeRow() })
    accounting.createJournalEntryForConsumptionCharge.mockRejectedValueOnce(new Error('boom'))
    await expect(service.confirmCharge('charge-1', 'org-1', 'user-9')).resolves.toBeDefined()
  })
})

// ── Leveranssätt: CONFIRMED → ATTACHED (PR 4) ────────────────────────────────

function makeLeverans(charges: Record<string, unknown>[]) {
  const created: { lines: Record<string, unknown>[]; invoices: Record<string, unknown>[] } = {
    lines: [],
    invoices: [],
  }
  const prisma: Record<string, unknown> = {
    lease: { findFirst: jest.fn().mockResolvedValue({ id: 'lease-1', tenantId: 'ten-1' }) },
    consumptionCharge: {
      findMany: jest.fn().mockResolvedValue(charges),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rentNoticeLine: {
      create: jest.fn().mockImplementation(({ data }) => {
        created.lines.push(data)
        return Promise.resolve({ id: `line-${created.lines.length}`, ...data })
      }),
    },
    rentNotice: { update: jest.fn().mockResolvedValue({}) },
    invoice: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) => {
        created.invoices.push(data)
        return Promise.resolve({ id: 'inv-1', ...data })
      }),
    },
    invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma))
  const accounting = {
    createJournalEntryForConsumptionCharge: jest.fn(),
    createJournalEntryForInvoice: jest.fn(),
  }
  const service = new ConsumptionService(prisma as never, accounting as never)
  return { service, prisma: prisma as unknown as LeveransPrisma, accounting, created }
}

interface LeveransPrisma {
  lease: MockTable
  consumptionCharge: MockTable
  rentNoticeLine: MockTable
  rentNotice: MockTable
  invoice: MockTable
  invoiceEvent: MockTable
}

function leveransCharge(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    organizationId: 'org-1',
    leaseId: 'lease-1',
    meterType: 'ELECTRICITY',
    periodEnd: new Date('2026-05-31'),
    quantity: 240,
    pricePerUnit: 2.5,
    netAmount: 600,
    vatRate: 0,
    vatAmount: 0,
    totalAmount: 600,
    status: 'CONFIRMED',
    deliveryMode: 'RENT_NOTICE_LINE',
    ...over,
  }
}

describe('attachRentNoticeLineCharges (RENT_NOTICE_LINE, PR 4)', () => {
  it('2-mån-lag: hämtar charges med periodEnd <= sista dagen i (aviMonth − 2)', async () => {
    const { service, prisma } = makeLeverans([leveransCharge()])
    await service.attachRentNoticeLineCharges({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      rentNoticeId: 'rn-1',
      aviMonth: 7,
      aviYear: 2026,
    })
    // Juli-avi (M=7) → cutoff = maj 31 2026.
    expect(prisma.consumptionCharge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'CONFIRMED',
          deliveryMode: 'RENT_NOTICE_LINE',
          periodEnd: { lte: new Date(Date.UTC(2026, 5, 0)) },
        }),
      }),
    )
  })

  it('skapar avi-rader, markerar ATTACHED och sätter consumptionAmount = summan', async () => {
    const { service, prisma, created } = makeLeverans([
      leveransCharge({ id: 'c1', totalAmount: 600 }),
      leveransCharge({ id: 'c2', totalAmount: 300, periodEnd: new Date('2026-05-31') }),
    ])
    const sum = await service.attachRentNoticeLineCharges({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      rentNoticeId: 'rn-1',
      aviMonth: 7,
      aviYear: 2026,
    })

    expect(sum).toBe(900)
    expect(created.lines).toHaveLength(2)
    expect(created.lines[0]).toEqual(
      expect.objectContaining({ consumptionChargeId: 'c1', total: 600 }),
    )
    // Atomiskt anspråk CONFIRMED → ATTACHED per charge.
    expect(prisma.consumptionCharge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1', organizationId: 'org-1', status: 'CONFIRMED' },
        data: { status: 'ATTACHED' },
      }),
    )
    expect(prisma.rentNotice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rn-1' }, data: { consumptionAmount: 900 } }),
    )
  })

  it('inga charges → returnerar 0, rör inget dokument', async () => {
    const { service, prisma } = makeLeverans([])
    const sum = await service.attachRentNoticeLineCharges({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      rentNoticeId: 'rn-1',
      aviMonth: 7,
      aviYear: 2026,
    })
    expect(sum).toBe(0)
    expect(prisma.rentNoticeLine.create).not.toHaveBeenCalled()
    expect(prisma.rentNotice.update).not.toHaveBeenCalled()
  })
})

describe('invoiceSeparateCharges (SEPARATE_INVOICE, PR 4)', () => {
  it('bygger EN faktura (UTILITY) med en rad per charge och markerar ATTACHED + invoiceId', async () => {
    const { service, prisma, created } = makeLeverans([
      leveransCharge({
        id: 'c1',
        deliveryMode: 'SEPARATE_INVOICE',
        netAmount: 600,
        vatAmount: 0,
        totalAmount: 600,
      }),
    ])
    const invoice = await service.invoiceSeparateCharges('lease-1', 'org-1', 'user-9')

    expect(invoice).not.toBeNull()
    expect(created.invoices[0]).toEqual(
      expect.objectContaining({ type: 'UTILITY', total: 600, subtotal: 600, vatTotal: 0 }),
    )
    expect(prisma.consumptionCharge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1', organizationId: 'org-1', status: 'CONFIRMED' },
        data: { status: 'ATTACHED', invoiceId: 'inv-1' },
      }),
    )
  })

  it('INGEN dubbelbokning: bokföringen anropas aldrig (verifikat klart från PR 3)', async () => {
    const { service, accounting } = makeLeverans([
      leveransCharge({ deliveryMode: 'SEPARATE_INVOICE' }),
    ])
    await service.invoiceSeparateCharges('lease-1', 'org-1', 'user-9')
    expect(accounting.createJournalEntryForConsumptionCharge).not.toHaveBeenCalled()
    expect(accounting.createJournalEntryForInvoice).not.toHaveBeenCalled()
  })

  it('inga charges → returnerar null (ingen faktura)', async () => {
    const { service, prisma } = makeLeverans([])
    const invoice = await service.invoiceSeparateCharges('lease-1', 'org-1', 'user-9')
    expect(invoice).toBeNull()
    expect(prisma.invoice.create).not.toHaveBeenCalled()
  })
})

describe('ConsumptionController RBAC', () => {
  const guard = new RolesGuard(new Reflector())
  const proto = ConsumptionController.prototype

  function allows(handler: () => unknown, role: string): boolean {
    const ctx = {
      getHandler: () => handler,
      getClass: () => ConsumptionController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext
    try {
      return guard.canActivate(ctx) === true
    } catch (err) {
      if (err instanceof ForbiddenException) return false
      throw err
    }
  }

  it.each(['VIEWER', 'ACCOUNTANT'] as const)(
    'nekar %s på skriv (createMeter/updateMeter/createTariff/recordReading)',
    (role) => {
      expect(allows(proto.createMeter as () => unknown, role)).toBe(false)
      expect(allows(proto.updateMeter as () => unknown, role)).toBe(false)
      expect(allows(proto.createTariff as () => unknown, role)).toBe(false)
      expect(allows(proto.recordReading as () => unknown, role)).toBe(false)
      expect(allows(proto.confirmCharge as () => unknown, role)).toBe(false)
      expect(allows(proto.invoiceSeparateCharges as () => unknown, role)).toBe(false)
    },
  )

  it.each(['MANAGER', 'ADMIN', 'OWNER'] as const)('släpper in %s på skriv', (role) => {
    expect(allows(proto.createMeter as () => unknown, role)).toBe(true)
    expect(allows(proto.updateMeter as () => unknown, role)).toBe(true)
    expect(allows(proto.createTariff as () => unknown, role)).toBe(true)
    expect(allows(proto.recordReading as () => unknown, role)).toBe(true)
    expect(allows(proto.confirmCharge as () => unknown, role)).toBe(true)
    expect(allows(proto.invoiceSeparateCharges as () => unknown, role)).toBe(true)
  })

  it('läsning (findMeters/findCharges) är öppen även för VIEWER', () => {
    expect(allows(proto.findMeters as () => unknown, 'VIEWER')).toBe(true)
    expect(allows(proto.findCharges as () => unknown, 'VIEWER')).toBe(true)
  })
})
