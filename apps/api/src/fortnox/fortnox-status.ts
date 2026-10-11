/**
 * GET /integrations/fortnox/status — kontrakt v1 (CLAUDE1/STATUS-KONTRAKT.md).
 * Ren mappning från säkra DB-urval; tokens finns aldrig i indata.
 */
type Json = unknown

interface ConnectionRow {
  status: 'ACTIVE' | 'AUTH_LOST' | 'DISCONNECTED'
  fortnoxDatabaseNumber: number
  fortnoxOrgNumber: string | null
  fortnoxCompanyName: string | null
  exportVoucherSeries: string | null
  exportOmitDimensionsAt: Date | null
  connectedAt: Date
  disconnectedAt: Date | null
  lastErrorClass: string | null
  lastErrorAt: Date | null
}

interface ReadRow {
  id: string
  status: string
  financialYearId: number
  financialYearStart: Date | null
  financialYearEnd: Date | null
  costAccounts: number[]
  periodFrom: Date
  periodTo: Date
  startedAt: Date
  completedAt: Date | null
  reason: string | null
  uncertainties: Json
  coverage: Json
  summary: Json
}

const day = (d: Date) => d.toISOString().slice(0, 10)

export function toReadView(r: ReadRow | null, now: Date = new Date()) {
  if (!r) return null
  return {
    id: r.id,
    status: r.status,
    financialYearId: r.financialYearId,
    financialYearStart: r.financialYearStart ? day(r.financialYearStart) : null,
    financialYearEnd: r.financialYearEnd ? day(r.financialYearEnd) : null,
    // Det SPARADE kontourvalet för just denna läsning (inte formulärets state).
    // Måttet är "Nettobelopp för valda konton" — aldrig hela bolagets resultat.
    selectedAccounts: [...r.costAccounts].sort((a, b) => a - b),
    measure: 'NET_AMOUNT_SELECTED_ACCOUNTS' as const,
    periodFrom: day(r.periodFrom),
    periodTo: day(r.periodTo),
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    // Ålder i sekunder sedan läsningen avslutades (K-F4): ingen grön "aktuell"-flagga.
    ageSeconds: r.completedAt
      ? Math.max(0, Math.round((now.getTime() - r.completedAt.getTime()) / 1000))
      : null,
    reason: r.reason,
    uncertainties: Array.isArray(r.uncertainties) ? (r.uncertainties as string[]) : [],
    coverage: (r.coverage ?? {}) as Record<string, unknown>,
    summary: (r.summary ?? null) as Record<string, unknown> | null,
  }
}

export function toStatusResponse(input: {
  enabled: boolean
  connection: ConnectionRow | null
  mappings: Array<{
    id: string
    dimensionType: string
    code: string
    propertyId: string
    propertyName: string
  }>
  latestRead: ReadRow | null
  latestCompleteRead: ReadRow | null
  exports: {
    counts: Record<string, number>
    needsReconciliation: number
    sendingEnabled: boolean
    sendingDisabledReason: string | null
  }
}) {
  const c = input.connection
  return {
    enabled: input.enabled,
    connection: c
      ? {
          status: c.status,
          company: {
            name: c.fortnoxCompanyName,
            orgNumber: c.fortnoxOrgNumber,
            databaseNumber: c.fortnoxDatabaseNumber,
          },
          exportVoucherSeries: c.exportVoucherSeries,
          exportOmitDimensions: c.exportOmitDimensionsAt !== null,
          connectedAt: c.connectedAt.toISOString(),
          disconnectedAt: c.disconnectedAt ? c.disconnectedAt.toISOString() : null,
          lastErrorClass: c.lastErrorClass,
          lastErrorAt: c.lastErrorAt ? c.lastErrorAt.toISOString() : null,
        }
      : null,
    mappings: input.mappings,
    latestRead: toReadView(input.latestRead),
    latestCompleteRead: toReadView(input.latestCompleteRead),
    exports: input.exports,
  }
}
