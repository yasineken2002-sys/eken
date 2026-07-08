/**
 * #69 — rätt uppsägningstid per regelverk (privatuthyrningslagen vs hyreslagen).
 *
 * F2:s golv tillämpade hyreslagens tider på ALLA kontrakt. Privatuthyrningslagen
 * (2012:978 § 3) ger andra tider: hyresgäst 1 mån / hyresvärd 3 mån (bara bostad).
 * Dagens golv kunde neka en privatuthyrnings-hyresgäst dennes 1-månadersrätt.
 *
 * Bevisar:
 *   A) terminationNoticeMonths: regim + vem-säger-upp → rätt antal månader.
 *   B) terminate() end-to-end: privatuthyrning hyresgäst 1 mån / hyresvärd 3 mån;
 *      HYRESLAGEN oförändrat (F2-beteende bevarat).
 *   C) Månadsskiftesrundningen (F2) fortsatt korrekt för alla fall.
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { terminationNoticeMonths, defaultTenancyRegime } from './leases.compliance'
import { LeasesService } from './leases.service'

// ── A0. Default-regim: ALLTID hyreslagen (privatuthyrning = medvetet opt-in) ────
describe('#69 · defaultTenancyRegime — aldrig privatuthyrning per default', () => {
  it('default = TENANCY_ACT (en felklassning kan aldrig ge ogiltig uppsägning)', () => {
    expect(defaultTenancyRegime()).toBe('TENANCY_ACT')
  })
})

// ── A. Compliance-funktionen ───────────────────────────────────────────────────
describe('#69 · terminationNoticeMonths — regim + initiator', () => {
  it('privatuthyrning + bostad + HYRESGÄST → 1 mån (tvingande golv)', () => {
    expect(
      terminationNoticeMonths({
        regime: 'PRIVATE_RENTAL',
        initiator: 'TENANT',
        unitType: 'APARTMENT',
        contractualNoticeMonths: 3,
      }),
    ).toBe(1)
  })

  it('privatuthyrning + bostad + HYRESVÄRD → 3 mån (min), förlängs av avtal', () => {
    expect(
      terminationNoticeMonths({
        regime: 'PRIVATE_RENTAL',
        initiator: 'LANDLORD',
        unitType: 'APARTMENT',
        contractualNoticeMonths: 3,
      }),
    ).toBe(3)
    // Avtalat längre binder hyresvärden.
    expect(
      terminationNoticeMonths({
        regime: 'PRIVATE_RENTAL',
        initiator: 'LANDLORD',
        unitType: 'APARTMENT',
        contractualNoticeMonths: 6,
      }),
    ).toBe(6)
  })

  it('privatuthyrning felaktigt satt på LOKAL → faller tillbaka på hyreslagen (defensivt)', () => {
    // Privatuthyrningslagen gäller inte lokal; hyresgäst ska INTE få 1 mån här.
    expect(
      terminationNoticeMonths({
        regime: 'PRIVATE_RENTAL',
        initiator: 'TENANT',
        unitType: 'OFFICE',
        contractualNoticeMonths: 9,
      }),
    ).toBe(9)
  })

  it('HYRESLAGEN → avtalets noticePeriodMonths, oavsett initiator (oförändrat F2)', () => {
    for (const initiator of ['TENANT', 'LANDLORD'] as const) {
      expect(
        terminationNoticeMonths({
          regime: 'TENANCY_ACT',
          initiator,
          unitType: 'APARTMENT',
          contractualNoticeMonths: 3,
        }),
      ).toBe(3)
      expect(
        terminationNoticeMonths({
          regime: 'TENANCY_ACT',
          initiator,
          unitType: 'OFFICE',
          contractualNoticeMonths: 9,
        }),
      ).toBe(9)
    }
  })
})

// ── Harness för terminate() ────────────────────────────────────────────────────
function makeService(leaseOverrides: Record<string, unknown> = {}) {
  const lease = {
    id: 'lease-1',
    status: 'ACTIVE',
    organizationId: 'org-1',
    unitId: 'unit-1',
    tenantId: 'tenant-1',
    noticePeriodMonths: 3,
    tenancyRegime: 'PRIVATE_RENTAL',
    monthlyRent: 10000,
    depositAmount: 0,
    endDate: null,
    terminatedAt: null,
    unit: { type: 'APARTMENT', name: 'A1', property: { name: 'Fastighet 1' } },
    ...leaseOverrides,
  }
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue(lease),
      update: jest.fn().mockResolvedValue({ id: 'lease-1', unit: lease.unit }),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb({})),
  }
  const deposits = { markRefundPendingForLease: jest.fn().mockResolvedValue(undefined) }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  const noop = {} as never
  const service = new LeasesService(
    prisma as never,
    notifications as never,
    deposits as never,
    noop,
    noop,
    noop,
    noop,
    noop,
  )
  return { service, prisma }
}

const ymd = (d: Date | string) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
const endDateOf = (prisma: { lease: { update: jest.Mock } }) =>
  ymd((prisma.lease.update.mock.calls[0]![0] as { data: { endDate: Date } }).data.endDate)

// ── B/C. terminate() end-to-end ────────────────────────────────────────────────
describe('#69 · terminate() tillämpar rätt tid per regim + initiator', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-08-12T09:00:00Z')))
  afterEach(() => jest.useRealTimers())

  it('privatuthyrning, HYRESGÄST, för kort datum → 1 mån (30 sep), golvet NEKAR inte', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', { effectiveDate: '2026-08-13' }, 'org-1', 'TENANT')
    // endOfNoticePeriod(2026-08-12, 1) = 2026-09-30 — hyresgästens 1-månadersrätt respekteras.
    expect(endDateOf(prisma)).toBe('2026-09-30')
  })

  it('privatuthyrning, HYRESVÄRD, utan datum → 3 mån (30 nov)', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', {}, 'org-1', 'LANDLORD')
    expect(endDateOf(prisma)).toBe('2026-11-30')
  })

  it('privatuthyrning, HYRESVÄRD default (ingen initiator) → 3 mån', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', {}, 'org-1') // default LANDLORD
    expect(endDateOf(prisma)).toBe('2026-11-30')
  })

  it('HYRESLAGEN, HYRESGÄST → avtalets 3 mån (OFÖRÄNDRAT F2, INTE 1 mån)', async () => {
    const { service, prisma } = makeService({ tenancyRegime: 'TENANCY_ACT' })
    await service.terminate('lease-1', { effectiveDate: '2026-08-13' }, 'org-1', 'TENANT')
    expect(endDateOf(prisma)).toBe('2026-11-30')
  })

  it('HYRESLAGEN, lokal 9 mån, HYRESVÄRD → 31 maj (oförändrat F2)', async () => {
    const { service, prisma } = makeService({
      tenancyRegime: 'TENANCY_ACT',
      noticePeriodMonths: 9,
      unit: { type: 'OFFICE', name: 'L1', property: { name: 'F1' } },
    })
    await service.terminate('lease-1', {}, 'org-1', 'LANDLORD')
    expect(endDateOf(prisma)).toBe('2027-05-31')
  })

  it('privatuthyrning, HYRESGÄST önskar SENARE datum → respekteras (får förlänga)', async () => {
    const { service, prisma } = makeService()
    await service.terminate('lease-1', { effectiveDate: '2027-03-15' }, 'org-1', 'TENANT')
    expect(endDateOf(prisma)).toBe('2027-03-15')
  })
})
