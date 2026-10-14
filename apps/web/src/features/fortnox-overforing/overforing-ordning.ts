import type { FortnoxExportRow } from '@/features/settings/api/fortnox-export.api'

/**
 * Tillstånd som kräver en människa: utfallet är okänt, avvisat eller kvittot
 * stämmer inte/är inte bekräftat. De visas först och ALLA — en avstämningsrad får
 * aldrig hamna under en gräns för "senaste".
 */
export const ATT_STAMMA_AV: ReadonlySet<FortnoxExportRow['state']> = new Set([
  'UNKNOWN',
  'REJECTED',
  'RECEIPT_MISMATCH',
  'RECEIPT_IDENTIFIED',
])

/** Delar raderna utan att ändra serverns ordning inom respektive del. */
export function ordnaForAvstamning(rows: readonly FortnoxExportRow[]): {
  attStammaAv: FortnoxExportRow[]
  ovriga: FortnoxExportRow[]
} {
  const attStammaAv: FortnoxExportRow[] = []
  const ovriga: FortnoxExportRow[] = []
  for (const row of rows) (ATT_STAMMA_AV.has(row.state) ? attStammaAv : ovriga).push(row)
  return { attStammaAv, ovriga }
}
