/**
 * RentNotice-läcktätning (följd-PR efter 5a) — bevis att hyresgästportalen aldrig
 * läcker interna RentNotice-fält.
 *
 * Tidigare:
 *  - getNotices returnerade rå RentNotice (organizationId/sendError/sentTo) +
 *    hela property-kedjan via lease.
 *  - exportTenantData.rentNotices använde `omit` (blocklist) → sendError +
 *    kravtrapp-fält (collectionStage/probableLossAt) + framtida fält läckte auto.
 *
 * Fix: EN delad allow-list (SAFE_PORTAL_RENT_NOTICE_SELECT) + mapRentNotice,
 * applicerad på getNotices, getRentNotices OCH exportTenantData.rentNotices.
 * Testet matar "smutsiga" rader och asserterar att svaret/queryn SAKNAR de
 * interna fälten (not.toHaveProperty), samma mönster som 5a.
 */

// MaintenanceService → StorageService drar in @aws-sdk/client-s3 (ESM). Mocka.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { TenantPortalService } from './tenant-portal.service'

// Interna fält som ALDRIG får nå hyresgästen. reminderFeeAmount selekteras
// (behövs för payableTotal-beräkningen) men exponeras ALDRIG i svaret — därför
// är den med i OUTPUT-listan men inte i SELECT-listan.
const INTERNAL_FIELDS = [
  'organizationId',
  'tenantId',
  'leaseId',
  'sendError',
  'sentTo',
  'paidAmount',
  'paymentMethod',
  'reminderPdfStorageKey',
  'reminderMessageId',
  'collectionStage',
  'remindedAt',
  'collectionReadyAt',
  'writtenOffAt',
  'probableLossAt',
  'interestAccruedAmount',
  'interestAccruedThrough',
  'type',
  'periodStart',
  'periodEnd',
  'daysCharged',
  'totalDays',
  'isProrated',
] as const

const FORBIDDEN_IN_OUTPUT = [...INTERNAL_FIELDS, 'reminderFeeAmount'] as const

const EXPECTED_OUTPUT_KEYS = [
  'amount',
  'consumptionAmount',
  'dueDate',
  'id',
  'miscChargeAmount',
  'month',
  'noticeNumber',
  'ocrNumber',
  'paidAt',
  'payableTotal',
  'propertyName',
  'sentAt',
  'status',
  'totalAmount',
  'unitName',
  'vatAmount',
  'year',
]

// En RentNotice-rad där varje internt fält är satt till ett sentinel-värde.
function dirtyRentNotice() {
  return {
    // Hyresgäst-vänligt (kontraktet PortalRentNotice)
    id: 'rn-1',
    noticeNumber: 'AVI-2026-06-0001',
    ocrNumber: '1234567',
    month: 6,
    year: 2026,
    amount: 8000,
    vatAmount: 0,
    totalAmount: 8000,
    consumptionAmount: 250,
    miscChargeAmount: 500,
    reminderFeeAmount: 60,
    dueDate: new Date('2026-06-30T00:00:00.000Z'),
    paidAt: null,
    status: 'SENT',
    sentAt: new Date('2026-06-01T00:00:00.000Z'),
    lease: {
      unit: {
        id: 'u1',
        name: 'Lgh 1001',
        unitNumber: '1001',
        area: 55,
        floor: 2,
        rooms: 2,
        property: {
          id: 'p1',
          name: 'Storgatan 1',
          street: 'Storgatan 1',
          city: 'Lund',
          postalCode: '22222',
        },
      },
    },
    // ── INTERNA FÄLT (läckan) ──────────────────────────────────────────────
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    leaseId: 'lease-1',
    sendError: 'SMTP 550 mailbox full',
    sentTo: 'tenant@x.se',
    paidAmount: null,
    paymentMethod: null,
    reminderPdfStorageKey: 'reminders/org-1/secret.pdf',
    reminderMessageId: 'msg-123',
    collectionStage: 'REMINDED',
    remindedAt: new Date('2026-07-10T00:00:00.000Z'),
    collectionReadyAt: null,
    writtenOffAt: null,
    probableLossAt: new Date('2026-08-01T00:00:00.000Z'),
    interestAccruedAmount: 12,
    interestAccruedThrough: new Date('2026-07-31T00:00:00.000Z'),
    type: 'RENT',
    periodStart: null,
    periodEnd: null,
    daysCharged: null,
    totalDays: null,
    isProrated: false,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  }
}

function expectNoRentNoticeLeak(notice: Record<string, unknown>) {
  for (const key of FORBIDDEN_IN_OUTPUT) {
    expect(notice).not.toHaveProperty(key)
  }
  expect(Object.keys(notice).sort()).toEqual(EXPECTED_OUTPUT_KEYS)
  // Endast namnet från property/unit — aldrig hela objektet.
  expect(notice.propertyName).toBe('Storgatan 1')
  expect(notice.unitName).toBe('Lgh 1001')
  // payableTotal = hyra + förbrukning + övrig debitering + påminnelseavgift.
  expect(notice.payableTotal).toBe(8000 + 250 + 500 + 60)
}

function assertSelectShape(arg: Record<string, unknown>) {
  expect(arg.select).toBeDefined()
  expect(arg.include).toBeUndefined()
  expect(arg.omit).toBeUndefined()
  const select = arg.select as Record<string, unknown>
  for (const key of INTERNAL_FIELDS) {
    expect(select).not.toHaveProperty(key)
  }
  // property/unit-kedjan exponerar bara säkra fält (5a:s allow-lists).
  const propSelect = (
    select.lease as {
      select: { unit: { select: { property: { select: Record<string, unknown> } } } }
    }
  ).select.unit.select.property.select
  expect(propSelect).not.toHaveProperty('fireSafetyNotes')
  expect(propSelect).not.toHaveProperty('consumptionBillingMode')
}

describe('TenantPortalService — RentNotice-läcktätning', () => {
  it('getNotices: svaret saknar interna fält + queryn använder allow-list-select', async () => {
    const prisma = {
      rentNotice: { findMany: jest.fn().mockResolvedValue([dirtyRentNotice()]) },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.getNotices('tenant-1')

    expect(result).toHaveLength(1)
    expectNoRentNoticeLeak(result[0] as Record<string, unknown>)
    assertSelectShape(prisma.rentNotice.findMany.mock.calls[0][0])
  })

  it('getRentNotices: svaret saknar interna fält + allow-list-select (status-filter bevarat)', async () => {
    const prisma = {
      rentNotice: { findMany: jest.fn().mockResolvedValue([dirtyRentNotice()]) },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.getRentNotices('tenant-1')

    expectNoRentNoticeLeak(result[0] as Record<string, unknown>)
    const arg = prisma.rentNotice.findMany.mock.calls[0][0]
    assertSelectShape(arg)
    // Bara SENT/PAID/OVERDUE till hyresgästen (oförändrat beteende).
    expect(arg.where.status).toEqual({ in: ['SENT', 'PAID', 'OVERDUE'] })
  })

  it('exportTenantData.rentNotices: allow-list-select (inte omit/include) utan interna fält', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tenant-1',
          organization: { id: 'org-1', name: 'Eken' },
          leases: [],
          invoices: [],
          rentNotices: [],
          maintenanceTickets: [],
          documents: [],
        }),
      },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    await service.exportTenantData('tenant-1')

    const rentNoticesArg = prisma.tenant.findUnique.mock.calls[0][0].include.rentNotices
    // Allow-list (select), INTE blocklist (omit) eller rå (true).
    expect(rentNoticesArg).not.toBe(true)
    expect(rentNoticesArg.omit).toBeUndefined()
    expect(rentNoticesArg.select).toBeDefined()
    for (const key of INTERNAL_FIELDS) {
      expect(rentNoticesArg.select).not.toHaveProperty(key)
    }
  })
})
