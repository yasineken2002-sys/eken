import { formatBookedRevenue, reportFailure, type BookedRevenue } from './report-evidence'

describe('rapportvärde utan påhittade belopp', () => {
  it('saknat underlag saknar belopp; faktiskt läst noll förblir känt', () => {
    const scope = {
      organizationId: 'O-A',
      metric: 'BOOKED_REVENUE' as const,
      propertyId: null,
      period: { from: '2026-09-01', to: '2026-09-30' },
    }
    const unknown: BookedRevenue = { ...reportFailure('EXTERNAL_REPORT_UNAVAILABLE'), scope }
    expect(unknown).not.toHaveProperty('amountOre')
    expect(formatBookedRevenue(unknown)).toContain('kan inte fastställas')
    expect(formatBookedRevenue(unknown)).not.toContain('0 kr')
    const known: BookedRevenue = {
      status: 'KNOWN',
      scope,
      source: 'EVENO_LEDGER',
      accountSystem: 'EVENO',
      accountRange: [3000, 3999],
      definition: 'CREDIT_MINUS_DEBIT',
      currency: 'SEK',
      amountOre: 0,
      observedAt: '2026-10-10T08:00:00Z',
      completeness: 'COMPLETE',
    }
    expect(formatBookedRevenue(known)).toContain('0')
    expect(formatBookedRevenue(known)).toContain('2026-09-01–2026-09-30')
    expect(formatBookedRevenue(known)).toContain('2026-10-10T08:00:00Z')
  })
})
