import { get, post } from '@/lib/api'

// T1.4 / #44 — efterdebitering (bakdaterad debitering). Speglar backendens
// RentBackfillService-typer. Kön + preview skapar ALDRIG en avi; bara confirm gör
// det (den bindande människo-handlingen).

export type BackfillMonthStatus =
  | 'BILLABLE'
  | 'BEYOND_WARNING'
  | 'BEYOND_HARD_CAP'
  | 'CLOSED_PERIOD'

export interface BackfillSummary {
  billableCount: number
  billableTotal: number
  beyondWarningCount: number
  beyondWarningTotal: number
  hardCappedCount: number
  closedCount: number
}

export interface BackfillMonthPreview {
  year: number
  month: number
  periodStart: string
  periodEnd: string
  daysCharged: number
  totalDays: number
  isProrated: boolean
  amount: number
  vatAmount: number
  totalAmount: number
  ageMonths: number
  status: BackfillMonthStatus
}

export interface BackfillPreview {
  leaseId: string
  months: BackfillMonthPreview[]
  summary: BackfillSummary
  hasVoluntaryTaxLiability: boolean
  // Momsperioder (org:ens redovisningsperiod) som efterdebiteringen berör, t.ex.
  // ["Q1 2026", "Q2 2026"]. Tom om lokalen inte är momspliktig.
  vatPeriods: string[]
}

export interface BackfillQueueItem {
  leaseId: string
  tenantName: string
  unitLabel: string
  propertyLabel: string
  summary: BackfillSummary
  requiresApproval: boolean
  maxAgeMonths: number
  hasVoluntaryTaxLiability: boolean
}

export interface BackfillResult {
  created: unknown[]
  skippedExisting: number
  skippedClosed: number
  skippedBeyondWarning: number
  blockedHardCap: number
  skippedMissingAccount: number
}

export function fetchBackfillQueue() {
  return get<BackfillQueueItem[]>('/avisering/backfill/queue')
}

export function fetchBackfillPreview(leaseId: string) {
  return get<BackfillPreview>(`/avisering/backfill/${leaseId}/preview`)
}

export function confirmBackfill(
  leaseId: string,
  opts: { allowBeyondWarning: boolean; vatDeclarationAcknowledged: boolean },
) {
  return post<BackfillResult>(`/avisering/backfill/${leaseId}/confirm`, opts)
}
