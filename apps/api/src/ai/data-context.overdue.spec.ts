/**
 * T4/#47 — AI-modulens datakontext läser nu DELADE OverdueDebtService för
 * "Förfallen skuld" (samma tal som dashboard + månadsrapport), i stället för sin
 * gamla blinda Invoice-only-OVERDUE-groupBy. Bevisar:
 *   • headline-skuldsiffran = snapshoten (inte Invoice-only-aggregatet),
 *   • det gamla (fel) Invoice-only-talet visas INTE längre som förfallen skuld,
 *   • org-id skickas till tjänsten (tenant-scoping bevaras).
 */

import { DataContextService } from './data-context.service'

// Minimal Prisma-mock: default [] / 0 för allt, override där testet bryr sig.
function makePrisma(overrides: Record<string, unknown> = {}) {
  const arr = () => jest.fn().mockResolvedValue([])
  const num = () => jest.fn().mockResolvedValue(0)
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Org A', city: 'Stad' }) },
    property: { count: num(), findMany: arr() },
    unit: {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'OCCUPIED', _count: { id: 3 } },
        { status: 'VACANT', _count: { id: 1 } },
      ]),
    },
    tenant: { count: num(), findMany: arr() },
    lease: { count: num(), findMany: arr() },
    invoice: {
      // Den GAMLA blinda källan: Invoice-only OVERDUE-aggregat (fel: 2 st/5000),
      // saknar hyresavier + DEPOSIT-exkl. Testet bevisar att detta INTE längre
      // är skuldsiffran AI:n ser.
      groupBy: jest.fn().mockResolvedValue([
        { status: 'OVERDUE', _count: { id: 2 }, _sum: { total: 5000 } },
        { status: 'PAID', _count: { id: 4 }, _sum: { total: 40000 } },
      ]),
      findMany: arr(),
    },
    ...overrides,
  }
  return prisma
}

describe('DataContextService — förfallen skuld via delade OverdueDebtService', () => {
  it('rapporterar snapshotens tal som "Förfallen skuld" (inte Invoice-only-groupByn)', async () => {
    const getOverdueSnapshot = jest
      .fn()
      .mockResolvedValue({ total: 21000, count: 3, over30Count: 1 })
    const prisma = makePrisma()
    const service = new DataContextService(
      prisma as never,
      { getOverdueSnapshot } as never,
      {
        getRevenueYearToDate: jest
          .fn()
          .mockResolvedValue({ total: 0, from: new Date(), to: new Date() }),
      } as never,
    )

    const ctx = await service.buildContext('org-1')

    // Headline = snapshoten (3 poster, 1 över 30 dagar) — samma som dashboarden.
    expect(ctx).toContain('Förfallen skuld: 3 poster')
    expect(ctx).toContain('varav 1 äldre än 30 dagar')

    // Detaljlist-queryn exkluderar DEPOSIT symmetriskt med OverdueDebtService.
    const overdueDetailCall = (prisma.invoice.findMany as jest.Mock).mock.calls.find(
      (c: [{ where?: Record<string, unknown> }]) => c[0]?.where?.['status'] === 'OVERDUE',
    )
    expect(overdueDetailCall?.[0].where).toMatchObject({ type: { not: 'DEPOSIT' } })

    // Det gamla, FELAKTIGA Invoice-only-talet (2 st) får INTE längre presenteras
    // som förfallet: FAKTUROR-listan hoppar OVERDUE-raden.
    expect(ctx).not.toContain('Förfallna: 2 st')
    // Ingen rad påstår längre "Förfallna fakturor: 2 st" (gamla headline-formen).
    expect(ctx).not.toMatch(/Förfallna fakturor: \d+ st/)

    // Tenant-scoping: tjänsten anropas med org-id:t (aldrig fel org).
    expect(getOverdueSnapshot).toHaveBeenCalledWith('org-1', expect.any(Date))
  })

  it('nollad snapshot → 0 poster, ingen krasch', async () => {
    const getOverdueSnapshot = jest.fn().mockResolvedValue({ total: 0, count: 0, over30Count: 0 })
    const service = new DataContextService(
      makePrisma() as never,
      { getOverdueSnapshot } as never,
      {
        getRevenueYearToDate: jest
          .fn()
          .mockResolvedValue({ total: 0, from: new Date(), to: new Date() }),
      } as never,
    )
    const ctx = await service.buildContext('org-2')
    expect(ctx).toContain('Förfallen skuld: 0 poster')
    expect(getOverdueSnapshot).toHaveBeenCalledWith('org-2', expect.any(Date))
  })
})
