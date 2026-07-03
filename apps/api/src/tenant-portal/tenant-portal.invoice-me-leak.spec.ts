/**
 * Portal defense-in-depth (följd-PR efter Spår A) — bevis att getInvoices och
 * getMe inte läcker interna fält.
 *
 * - getInvoices: include:{property:true} → allow-list-select (lager 1). mapInvoice
 *   (lager 2) orörd → output BYTE-IDENTISK. Testet matar en "smutsig" faktura och
 *   asserterar exakt samma DTO som tidigare + frånvaro av property/unit-interna fält.
 * - getMe: mapMe (lager 2) ovanpå befintligt SAFE_PORTAL_TENANT_SELECT (lager 1).
 *   Asserterar frånvaro av organizationId/activationReminderSentAt/timestamps +
 *   organization.id.
 */

// MaintenanceService → StorageService drar in @aws-sdk/client-s3 (ESM). Mocka.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { TenantPortalService, mapMe } from './tenant-portal.service'

// ── getInvoices ─────────────────────────────────────────────────────────────

function dirtyInvoice() {
  return {
    id: 'inv-1',
    invoiceNumber: 'F-2026-001',
    type: 'SERVICE',
    status: 'SENT',
    total: 1500,
    dueDate: new Date('2026-06-30T00:00:00.000Z'),
    issueDate: new Date('2026-06-01T00:00:00.000Z'),
    paidAt: null,
    lease: {
      unit: {
        id: 'u1',
        name: 'Lgh 1001',
        unitNumber: '1001',
        area: 55,
        floor: 2,
        rooms: 2,
        // skulle läcka via include:true:
        monthlyRent: 12000,
        voluntaryTaxLiability: true,
        property: {
          id: 'p1',
          name: 'Storgatan 1',
          street: 'Storgatan 1',
          city: 'Lund',
          postalCode: '22222',
          organizationId: 'org-1',
          fireSafetyNotes: 'BRANDCELL-HEMLIGT',
          consumptionBillingMode: 'RENT_NOTICE_LINE',
        },
      },
    },
    // interna/oanvända fält som mapInvoice ignorerar:
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    leaseId: 'lease-1',
    lines: [{ id: 'l1', description: 'INTERN RADTEXT' }],
  }
}

// Exakt det mapInvoice producerade FÖRE refaktorn (byte-identisk referens).
const EXPECTED_INVOICE_DTO = {
  id: 'inv-1',
  invoiceNumber: 'F-2026-001',
  type: 'SERVICE',
  status: 'SENT',
  total: 1500,
  dueDate: '2026-06-30T00:00:00.000Z',
  issueDate: '2026-06-01T00:00:00.000Z',
  paidAt: null,
  propertyName: 'Storgatan 1',
  unitName: 'Lgh 1001',
}

describe('TenantPortalService — getInvoices defense-in-depth', () => {
  it('output BYTE-IDENTISK + svaret saknar property/unit-interna fält', async () => {
    const prisma = {
      invoice: { findMany: jest.fn().mockResolvedValue([dirtyInvoice()]) },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.getInvoices('tenant-1')

    expect(result).toHaveLength(1)
    const inv = result[0] as Record<string, unknown>

    // Byte-identisk med referens-DTO:n (mapInvoice orörd).
    expect(inv).toEqual(EXPECTED_INVOICE_DTO)

    // Frånvaro av interna/oanvända fält.
    for (const key of ['lines', 'lease', 'organizationId', 'tenantId', 'leaseId']) {
      expect(inv).not.toHaveProperty(key)
    }
    // propertyName/unitName är bara namn-strängar — inga nästlade interna objekt.
    expect(inv.propertyName).toBe('Storgatan 1')
    expect(inv.unitName).toBe('Lgh 1001')

    // Lager 1: query selekterar, drar aldrig lines eller property-interna fält.
    const arg = prisma.invoice.findMany.mock.calls[0][0]
    expect(arg.select).toBeDefined()
    expect(arg.include).toBeUndefined()
    expect(arg.select).not.toHaveProperty('lines')
    const propSelect = arg.select.lease.select.unit.select.property.select
    expect(propSelect).not.toHaveProperty('fireSafetyNotes')
    expect(propSelect).not.toHaveProperty('consumptionBillingMode')
    expect(arg.select.lease.select.unit.select).not.toHaveProperty('monthlyRent')
  })
})

// ── getMe (mapMe) ───────────────────────────────────────────────────────────

function dirtyTenant() {
  return {
    id: 'tenant-1',
    type: 'INDIVIDUAL',
    firstName: 'Anna',
    lastName: 'Svensson',
    companyName: null,
    email: 'anna@example.se',
    phone: '070-1234567',
    personalNumber: '19900101-1234',
    orgNumber: null,
    contactPerson: null,
    street: 'Storgatan 1',
    city: 'Lund',
    postalCode: '22222',
    country: 'SE',
    portalActivated: true,
    portalActivatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ocrNumber: '1234567',
    organization: { id: 'org-1', name: 'Eken Fastigheter' },
    // ── INTERNA/REDUNDANTA FÄLT (ska strippas) ──────────────────────────────
    organizationId: 'org-1',
    activationReminderSentAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    // credentials (skulle aldrig nå hit via lager 1, men bevisa lager 2 ändå):
    passwordHash: 'HASH',
    activationTokenHash: 'TOKHASH',
    passwordResetTokenHash: 'RESETHASH',
  }
}

const FORBIDDEN_ME_FIELDS = [
  'organizationId',
  'activationReminderSentAt',
  'createdAt',
  'updatedAt',
  'passwordHash',
  'activationTokenHash',
  'passwordResetTokenHash',
] as const

const EXPECTED_ME_KEYS = [
  'city',
  'companyName',
  'contactPerson',
  'country',
  'email',
  'firstName',
  'id',
  'lastName',
  'ocrNumber',
  'orgNumber',
  'organization',
  'personalNumber',
  'phone',
  'portalActivated',
  'portalActivatedAt',
  'postalCode',
  'street',
  'type',
]

describe('mapMe — getMe defense-in-depth', () => {
  it('svaret saknar interna fält + organization exponerar bara name (ej id)', () => {
    const me = mapMe(dirtyTenant() as never) as Record<string, unknown>

    for (const key of FORBIDDEN_ME_FIELDS) {
      expect(me).not.toHaveProperty(key)
    }
    expect(Object.keys(me).sort()).toEqual(EXPECTED_ME_KEYS)

    // organization: BARA name, aldrig intern id.
    expect(me.organization).toEqual({ name: 'Eken Fastigheter' })
    expect(me.organization).not.toHaveProperty('id')

    // Hyresgästens egna uppgifter bevaras (eget betalnings-OCR m.m.).
    expect(me.ocrNumber).toBe('1234567')
    expect(me.email).toBe('anna@example.se')
    expect(me.personalNumber).toBe('19900101-1234')
  })
})
