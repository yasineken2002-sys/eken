/**
 * T4/#47 — AI-datakontexten rapporterar nu BOKFÖRD intäkt (Σ 3xxx accrual via
 * delade AccountingService.getRevenueYearToDate = samma tal som dashboardens
 * "Totala intäkter"), och etiketterar den gamla Σ monthlyRent-summan ärligt som
 * "Förväntad månadshyra" (teoretisk run-rate) i stället för att presentera den
 * som intäkt. Bevisar skillnaden på testdata: förväntad 30000/mån vs bokförd
 * 250000 i år — två olika begrepp, inte förväxlingsbara.
 */

import { DataContextService } from './data-context.service'

const activeLease = (monthlyRent: number, id: string) => ({
  id,
  monthlyRent,
  startDate: new Date('2026-01-01T00:00:00Z'),
  tenancyStartDate: new Date('2026-01-01T00:00:00Z'),
  endDate: null,
  tenant: { id: `t-${id}`, type: 'INDIVIDUAL', firstName: 'A', lastName: 'B', companyName: null },
  unit: { id: `u-${id}`, name: 'Lgh', unitNumber: id },
})

function makePrisma() {
  return {
    organization: { findUnique: jest.fn().mockResolvedValue({ name: 'Org A', city: 'Stad' }) },
    property: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    unit: { groupBy: jest.fn().mockResolvedValue([]) },
    tenant: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    lease: {
      count: jest.fn().mockResolvedValue(0),
      // activeLeaseList (take: 30) → förväntad månadshyra 12000 + 18000 = 30000.
      findMany: jest
        .fn()
        .mockImplementation((args: { take?: number }) =>
          Promise.resolve(
            args?.take === 30 ? [activeLease(12000, '1'), activeLease(18000, '2')] : [],
          ),
        ),
    },
    invoice: {
      // PAID-fakturor med en distinkt Invoice-only-summa (99999) som INTE får
      // presenteras som monetärt belopp (kassa-blint, konkurrerar med bokförd
      // intäkt). Bara antalet (4 st) ska synas i FAKTUROR-listan.
      groupBy: jest
        .fn()
        .mockResolvedValue([{ status: 'PAID', _count: { id: 4 }, _sum: { total: 99999 } }]),
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
}

const fmtSEK = (n: number) =>
  new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(n)

describe('DataContextService — bokförd intäkt vs förväntad månadshyra', () => {
  it('rapporterar bokförd intäkt (accrual) OCH förväntad månadshyra, tydligt åtskilda', async () => {
    const getRevenueYearToDate = jest
      .fn()
      .mockResolvedValue({ total: 250000, from: new Date(), to: new Date() })
    const prisma = makePrisma()
    const service = new DataContextService(
      prisma as never,
      {
        getOverdueSnapshot: jest.fn().mockResolvedValue({ total: 0, count: 0, over30Count: 0 }),
      } as never,
      { getRevenueYearToDate } as never,
    )

    const ctx = await service.buildContext('org-1')

    // Auktoritativ, bokförd intäkt = dashboardens tal (250000).
    expect(ctx).toContain(`Bokförd intäkt i år (Σ 3xxx, räkenskapsår-till-idag): ${fmtSEK(250000)}`)
    // Förväntad månadshyra ärligt etiketterad (30000/mån), INTE kallad intäkt.
    expect(ctx).toContain(`Förväntad månadshyra (avtalad, aktiva kontrakt): ${fmtSEK(30000)}`)
    // Gamla, förväxlingsbara etiketten är borta.
    expect(ctx).not.toContain('Totala månadsinkomster')
    // De två talen är olika → begreppen är inte hopblandade.
    expect(250000).not.toBe(30000)

    // FAKTUROR-listan visar bara ANTAL — den blinda Invoice-only PAID-summan
    // (99999) presenteras aldrig som monetärt intäktstal.
    expect(ctx).toContain('Betalda: 4 st')
    expect(ctx).not.toContain(fmtSEK(99999))
    expect(ctx).not.toContain('Betalda: 4 st, totalt')

    // Tenant-scoping: bokförd intäkt hämtas för org-id:t.
    expect(getRevenueYearToDate).toHaveBeenCalledWith('org-1', expect.any(Date))
  })
})
