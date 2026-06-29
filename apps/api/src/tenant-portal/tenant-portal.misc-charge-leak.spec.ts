/**
 * 5b — MiscCharge-vy för hyresgästen (SISTA PR i Spår A). Bevis att portalen
 * aldrig läcker interna MiscCharge-fält, döljer DRAFT/CANCELLED och är IDOR-säker.
 *
 * Speglar consumption-/RentNotice-mönstret: allow-list-select (SAFE_PORTAL_
 * MISC_CHARGE_SELECT) + mapMiscCharge (lager 2) + status-filter [CONFIRMED,
 * ATTACHED] + scope HÅRT på tenantId (från @CurrentTenant, aldrig query-param).
 */

// MaintenanceService → StorageService drar in @aws-sdk/client-s3 (ESM). Mocka.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { TenantPortalService } from './tenant-portal.service'

// Interna fält som ALDRIG får nå hyresgästen (PR 5-kartläggningens allow-list).
const FORBIDDEN_FIELDS = [
  'vatStatus',
  'vatRate',
  'status',
  'sourceType',
  'sourceRefId',
  'organizationId',
  'leaseId',
  'tenantId',
  'createdAt',
  'updatedAt',
] as const

const EXPECTED_OUTPUT_KEYS = [
  'description',
  'id',
  'incidentDate',
  'netAmount',
  'totalAmount',
  'vatAmount',
]

// En MiscCharge-rad där varje internt fält är satt till ett sentinel-värde.
function dirtyMiscCharge(over: { id?: string; tenantId?: string; status?: string } = {}) {
  return {
    // Hyresgäst-vänligt (kontraktet PortalMiscCharge)
    id: over.id ?? 'mc-1',
    description: 'Krossad fönsterruta kök',
    incidentDate: new Date('2026-05-12T00:00:00.000Z'),
    netAmount: 2400,
    vatAmount: 0,
    totalAmount: 2400,
    // ── INTERNA FÄLT (läckan) ──────────────────────────────────────────────
    vatStatus: 'EXEMPT',
    vatRate: 0,
    status: over.status ?? 'CONFIRMED',
    sourceType: 'MAINTENANCE_TICKET',
    sourceRefId: 'ticket-secret-123',
    organizationId: 'org-1',
    leaseId: 'lease-1',
    tenantId: over.tenantId ?? 'tenant-1',
    createdAt: new Date('2026-05-12T08:00:00.000Z'),
    updatedAt: new Date('2026-05-12T08:00:00.000Z'),
  }
}

describe('TenantPortalService — 5b MiscCharge-läcktätning + DRAFT/IDOR', () => {
  it('getMiscCharges: svaret saknar interna fält + queryn använder allow-list-select', async () => {
    const prisma = {
      miscCharge: { findMany: jest.fn().mockResolvedValue([dirtyMiscCharge()]) },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    const result = await service.getMiscCharges('tenant-1')

    expect(result).toHaveLength(1)
    const charge = result[0] as Record<string, unknown>
    for (const key of FORBIDDEN_FIELDS) {
      expect(charge).not.toHaveProperty(key)
    }
    expect(Object.keys(charge).sort()).toEqual(EXPECTED_OUTPUT_KEYS)
    expect(charge.description).toBe('Krossad fönsterruta kök')
    expect(charge.totalAmount).toBe(2400)

    // Lager 1: select (aldrig include), inga interna fält efterfrågas.
    const arg = prisma.miscCharge.findMany.mock.calls[0][0]
    expect(arg.select).toBeDefined()
    expect(arg.include).toBeUndefined()
    for (const key of FORBIDDEN_FIELDS) {
      expect(arg.select).not.toHaveProperty(key)
    }
  })

  it('DRAFT/CANCELLED döljs: queryn filtrerar status in [CONFIRMED, ATTACHED]', async () => {
    const prisma = {
      miscCharge: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    await service.getMiscCharges('tenant-1')

    const arg = prisma.miscCharge.findMany.mock.calls[0][0]
    expect(arg.where.status).toEqual({ in: ['CONFIRMED', 'ATTACHED'] })
    // DRAFT/CANCELLED får ALDRIG ingå i filtret.
    expect(arg.where.status.in).not.toContain('DRAFT')
    expect(arg.where.status.in).not.toContain('CANCELLED')
  })

  it('IDOR: granne A↔B — hyresgäst A ser ALDRIG hyresgäst B:s debiteringar', async () => {
    // Simulera DB-scoping: findMany filtrerar på where.tenantId (precis som Postgres).
    const DB = [
      dirtyMiscCharge({ id: 'charge-A', tenantId: 'tenant-A', status: 'CONFIRMED' }),
      dirtyMiscCharge({ id: 'charge-B', tenantId: 'tenant-B', status: 'CONFIRMED' }),
    ]
    const prisma = {
      miscCharge: {
        findMany: jest.fn((args: { where: { tenantId: string; status: { in: string[] } } }) =>
          Promise.resolve(
            DB.filter(
              (r) => r.tenantId === args.where.tenantId && args.where.status.in.includes(r.status),
            ),
          ),
        ),
      },
    }
    const service = new TenantPortalService(prisma as never, {} as never, {} as never)

    // tenantId kommer ENBART från @CurrentTenant i controllern — aldrig från input.
    const aResult = await service.getMiscCharges('tenant-A')
    const bResult = await service.getMiscCharges('tenant-B')

    expect(aResult.map((c) => c.id)).toEqual(['charge-A'])
    expect(bResult.map((c) => c.id)).toEqual(['charge-B'])
    // A ser ALDRIG B:s post.
    expect(aResult.some((c) => c.id === 'charge-B')).toBe(false)
    // Queryn scopades på exakt den efterfrågade tenanten.
    const calls = prisma.miscCharge.findMany.mock.calls as Array<[{ where: { tenantId: string } }]>
    expect(calls[0]?.[0].where.tenantId).toBe('tenant-A')
    expect(calls[1]?.[0].where.tenantId).toBe('tenant-B')
  })
})
