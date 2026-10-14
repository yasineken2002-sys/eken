/** Server-built report evidence. Missing evidence never carries a numeric amount. */
export const REPORT_NOT_DETERMINABLE = 'REPORT_NOT_DETERMINABLE'

export type ReportReason =
  | 'OWNER_UNVERIFIED'
  | 'EXTERNAL_REPORT_UNAVAILABLE'
  | 'PROPERTY_ALLOCATION_UNVERIFIED'
  | 'READ_FAILED'

const REASONS: Record<ReportReason, string> = {
  OWNER_UNVERIFIED:
    'Bokföringsmåttet kan inte fastställas: organisationens huvudboksval är inte verifierat.',
  EXTERNAL_REPORT_UNAVAILABLE:
    'Bokföringsmåttet kan inte fastställas: organisationen har Fortnox som huvudbok och ett fullständigt, rättbundet rapportunderlag saknas. Evenos lokala bok ersätter inte detta underlag.',
  PROPERTY_ALLOCATION_UNVERIFIED:
    'Fastighetens resultat kan inte fastställas: verifierad fastighetsfördelning saknas.',
  READ_FAILED: 'Bokföringsmåttet kan inte fastställas: underlaget kunde inte läsas.',
}

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REASONS, value)
}

export function reportFailure(reason: ReportReason) {
  return {
    status: 'NOT_DETERMINABLE' as const,
    code: REPORT_NOT_DETERMINABLE,
    reason,
    message: REASONS[reason],
  }
}

export interface RevenueScope {
  organizationId: string
  metric: 'BOOKED_REVENUE'
  period?: { from: string; to: string }
  asOf?: string
  propertyId: null
}

export type BookedRevenue =
  | (ReturnType<typeof reportFailure> & { scope: RevenueScope })
  | {
      status: 'KNOWN'
      scope: RevenueScope & { period: { from: string; to: string } }
      source: 'EVENO_LEDGER'
      accountSystem: 'EVENO'
      accountRange: readonly [3000, 3999]
      definition: 'CREDIT_MINUS_DEBIT'
      currency: 'SEK'
      amountOre: number
      observedAt: string
      completeness: 'COMPLETE'
    }

export function formatBookedRevenue(value: BookedRevenue): string {
  if (value.status !== 'KNOWN') return value.message
  const amount = new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value.amountOre / 100)
  return (
    `${amount} — källa: Evenos huvudbok, 3xxx kredit−debet, ` +
    `period ${value.scope.period.from}–${value.scope.period.to}, läst per ${value.observedAt}`
  )
}
