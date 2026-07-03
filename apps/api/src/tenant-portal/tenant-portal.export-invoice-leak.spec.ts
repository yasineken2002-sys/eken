/**
 * Portal defense-in-depth (sista hålet av klassen) — bevis att GDPR Art. 15-exporten
 * (GET /portal/me/export) inte läcker interna Invoice-fält.
 *
 * Tidigare drog `invoices: { include: { lines: true } }` hela Invoice-raden rått och
 * returnerade den oförändrad — trackingToken (bearer-liknande), collectionExportKey
 * (delad R2-nyckel → cross-tenant PII), sendError, kravtrappa-fält och organizationId
 * följde med. Nu: SAFE_PORTAL_EXPORT_INVOICE_SELECT (lager 1) + mapExportInvoice (lager 2).
 *
 * Testet matar en "smutsig" faktura genom mapExportInvoice och asserterar:
 *  - frånvaro av bearer-liknande/interna/kravtrappa-fält,
 *  - att hyresgästens egna lines BEVARAS men med FK:n (invoiceId) strippad,
 *  - att interna relationer (events/bankTransactions/deposit/…) aldrig är med.
 */

// MaintenanceService → StorageService drar in @aws-sdk/client-s3 (ESM). Mocka.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { mapExportInvoice } from './tenant-portal.service'

function dirtyExportInvoice() {
  return {
    // ── Hyresgästens egen fakturadata (Art. 15 — ska bevaras) ────────────────
    id: 'inv-1',
    invoiceNumber: 'F-2026-001',
    type: 'SERVICE',
    status: 'SENT',
    subtotal: 1200,
    vatTotal: 300,
    total: 1500,
    dueDate: new Date('2026-06-30T00:00:00.000Z'),
    issueDate: new Date('2026-06-01T00:00:00.000Z'),
    paidAt: null,
    reference: 'Ref 123',
    ocrNumber: '1234567',
    notes: 'Hyresgästens egen notering',
    lines: [
      {
        id: 'line-1',
        description: 'Serviceavgift',
        quantity: 1,
        unitPrice: 1200,
        vatRate: 25,
        total: 1500,
        // FK som ska strippas:
        invoiceId: 'inv-1',
      },
    ],
    // ── INTERNA/INFRA/KRAVTRAPPA (ska ALDRIG med) ────────────────────────────
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    customerId: null,
    leaseId: 'lease-1',
    trackingToken: 'TRACK-BEARER-TOKEN',
    collectionExportKey: 'r2/inkasso-batch-xyz.zip',
    sendError: 'SMTP 550',
    remindersPaused: true,
    remindersPausedAt: new Date('2026-06-10T00:00:00.000Z'),
    remindersPausedReason: 'Skickad till inkasso',
    sentToCollectionAt: new Date('2026-06-15T00:00:00.000Z'),
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    // ── Interna relationer (ska ALDRIG med) ──────────────────────────────────
    events: [{ id: 'ev-1' }],
    bankTransactions: [{ id: 'bt-1' }],
    deposit: { id: 'dep-1' },
    paymentReminders: [{ id: 'pr-1' }],
    consumptionCharges: [{ id: 'cc-1' }],
  }
}

const FORBIDDEN_INVOICE_FIELDS = [
  'organizationId',
  'tenantId',
  'customerId',
  'leaseId',
  'trackingToken',
  'collectionExportKey',
  'sendError',
  'remindersPaused',
  'remindersPausedAt',
  'remindersPausedReason',
  'sentToCollectionAt',
  'createdAt',
  'updatedAt',
] as const

const FORBIDDEN_INVOICE_RELATIONS = [
  'events',
  'bankTransactions',
  'deposit',
  'paymentReminders',
  'consumptionCharges',
] as const

const EXPECTED_INVOICE_KEYS = [
  'dueDate',
  'id',
  'invoiceNumber',
  'issueDate',
  'lines',
  'notes',
  'ocrNumber',
  'paidAt',
  'reference',
  'status',
  'subtotal',
  'total',
  'type',
  'vatTotal',
]

describe('mapExportInvoice — GDPR-export defense-in-depth', () => {
  const inv = mapExportInvoice(dirtyExportInvoice() as never) as Record<string, unknown>

  it('svaret saknar bearer-liknande/interna/kravtrappa-fält', () => {
    for (const key of FORBIDDEN_INVOICE_FIELDS) {
      expect(inv).not.toHaveProperty(key)
    }
    // Explicit: bearer-liknande token + cross-tenant R2-nyckel.
    expect(inv).not.toHaveProperty('trackingToken')
    expect(inv).not.toHaveProperty('collectionExportKey')
  })

  it('svaret saknar interna relationer', () => {
    for (const rel of FORBIDDEN_INVOICE_RELATIONS) {
      expect(inv).not.toHaveProperty(rel)
    }
  })

  it('exponerar exakt de tillåtna Art. 15-fälten', () => {
    expect(Object.keys(inv).sort()).toEqual(EXPECTED_INVOICE_KEYS)
    // Hyresgästens egna uppgifter bevaras.
    expect(inv.total).toBe(1500)
    expect(inv.ocrNumber).toBe('1234567')
    expect(inv.reference).toBe('Ref 123')
    expect(inv.notes).toBe('Hyresgästens egen notering')
  })

  it('lines BEVARAS (Art. 15-data) men varje line SAKNAR FK:n invoiceId', () => {
    const lines = inv.lines as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    const line = lines[0]!

    // FK strippad.
    expect(line).not.toHaveProperty('invoiceId')

    // Egna raddata bevarade.
    expect(Object.keys(line).sort()).toEqual([
      'description',
      'id',
      'quantity',
      'total',
      'unitPrice',
      'vatRate',
    ])
    expect(line.description).toBe('Serviceavgift')
    expect(line.total).toBe(1500)
  })
})
