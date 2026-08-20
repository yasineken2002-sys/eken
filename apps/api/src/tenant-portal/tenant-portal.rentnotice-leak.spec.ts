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
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'

// Interna fält som ALDRIG får nå hyresgästen. reminderFeeAmount,
// interestAccruedAmount, type och payments selekteras (behövs för
// payableTotal-beräkningen) men exponeras ALDRIG i svaret — därför
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
  'interestAccruedThrough',
  'periodStart',
  'periodEnd',
  'daysCharged',
  'totalDays',
  'isProrated',
] as const

/**
 * #344 — fält VYNS select hämtar för restskuldsberäkningen, men som mappern
 * aldrig släpper vidare. De får finnas i vyns select och FÅR INTE finnas i
 * GDPR-exportens (som returnerar raderna RAW, utan mapper).
 */
const CALCULATION_ONLY_FIELDS = ['type', 'interestAccruedAmount', 'payments'] as const

const FORBIDDEN_IN_OUTPUT = [
  ...INTERNAL_FIELDS,
  'reminderFeeAmount',
  ...CALCULATION_ONLY_FIELDS,
] as const

const EXPECTED_OUTPUT_KEYS = [
  'amount',
  'consumptionAmount',
  'dueDate',
  'id',
  'miscChargeAmount',
  'month',
  'nominalTotal',
  'noticeNumber',
  'ocrNumber',
  'paid',
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
    // #344 — fälten restskulden räknas ur. `payments` bär medvetet FLER fält än
    // selecten hämtar, för att bevisa att mappern (lager 2) inte släpper vidare
    // dem även om selecten skulle drifta.
    payments: [{ amount: 3000, id: 'rnp-HEMLIGT', bankTransactionId: 'tx-HEMLIGT' }],
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
    credits: [],
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
  // #344 — payableTotal är RESTSKULDEN: brutto minus registrerad betalning.
  // Före #344 stod här bruttot (8 810) trots att 3 000 var betalt.
  expect(notice.payableTotal).toBe(8000 + 250 + 500 + 60 - 3000)
  expect(notice.paid).toBe(3000)
  // Nominell fordran — oberoende av betalningar. Gränssnittets "Kvar av" läser
  // det här fältet i stället för payableTotal + paid, som blir fel vid
  // överbetalning (granskningsfynd i #344).
  expect(notice.nominalTotal).toBe(8000 + 250 + 500 + 60)
}

/**
 * `allowCalculationFields` — vyns select FÅR hämta `type`/`interestAccruedAmount`/
 * `payments`; exportens får INTE. Första versionen av #344 la dem i den DELADE
 * selecten och läckte dem rakt in i GDPR-exporten (som saknar mapper). Det här
 * testet fångade det, och delningen nedan är vad som håller dem isär.
 */
function assertSelectShape(arg: Record<string, unknown>, allowCalculationFields = false) {
  expect(arg.select).toBeDefined()
  expect(arg.include).toBeUndefined()
  expect(arg.omit).toBeUndefined()
  const select = arg.select as Record<string, unknown>
  for (const key of INTERNAL_FIELDS) {
    expect(select).not.toHaveProperty(key)
  }
  for (const key of CALCULATION_ONLY_FIELDS) {
    if (allowCalculationFields) expect(select).toHaveProperty(key)
    else expect(select).not.toHaveProperty(key)
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
    const service = new TenantPortalService(
      prisma as never,
      testPersonalNumberService(),
      {} as never,
      {} as never,
    )

    const result = await service.getNotices('tenant-1')

    expect(result).toHaveLength(1)
    expectNoRentNoticeLeak(result[0] as Record<string, unknown>)
    const arg = prisma.rentNotice.findMany.mock.calls[0][0]
    assertSelectShape(arg, true)
    // T1.4 (hyresjurist): getNotices får ALDRIG visa PENDING/CANCELLED — en
    // efterdebiterad (backfill) avi vilar i PENDING tills manuell frisläppning.
    expect(arg.where.status).toEqual({ in: ['SENT', 'PAID', 'OVERDUE'] })
  })

  it('getRentNotices: svaret saknar interna fält + allow-list-select (status-filter bevarat)', async () => {
    const prisma = {
      rentNotice: { findMany: jest.fn().mockResolvedValue([dirtyRentNotice()]) },
    }
    const service = new TenantPortalService(
      prisma as never,
      testPersonalNumberService(),
      {} as never,
      {} as never,
    )

    const result = await service.getRentNotices('tenant-1')

    expectNoRentNoticeLeak(result[0] as Record<string, unknown>)
    const arg = prisma.rentNotice.findMany.mock.calls[0][0]
    assertSelectShape(arg, true)
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
    const service = new TenantPortalService(
      prisma as never,
      testPersonalNumberService(),
      {} as never,
      {} as never,
    )

    await service.exportTenantData('tenant-1')

    const rentNoticesArg = prisma.tenant.findUnique.mock.calls[0][0].include.rentNotices
    // Allow-list (select), INTE blocklist (omit) eller rå (true).
    expect(rentNoticesArg).not.toBe(true)
    expect(rentNoticesArg.omit).toBeUndefined()
    expect(rentNoticesArg.select).toBeDefined()
    for (const key of [...INTERNAL_FIELDS, ...CALCULATION_ONLY_FIELDS]) {
      // #344 — beräkningsfälten hör till VYNS select, aldrig exportens.
      // Exporten returnerar raderna RAW; allt som selekteras hamnar i filen.
      expect(rentNoticesArg.select).not.toHaveProperty(key)
    }
  })
})
