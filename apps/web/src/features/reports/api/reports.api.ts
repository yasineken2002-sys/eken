import { api, get } from '@/lib/api'
import type { BalanceSheet, ProfitLossReport, VatReport } from '@eken/shared'

export const fetchProfitLoss = (params: {
  from: string
  to: string
  propertyId?: string
}): Promise<ProfitLossReport> =>
  get<ProfitLossReport>('/accounting/reports/profit-loss', params as Record<string, unknown>)

export const fetchBalanceSheet = (asOf: string): Promise<BalanceSheet> =>
  get<BalanceSheet>('/accounting/reports/balance-sheet', { asOf })

export const fetchVatReport = (params: { from: string; to: string }): Promise<VatReport> =>
  get<VatReport>('/accounting/reports/vat', params as Record<string, unknown>)

// SIE4 är en filnedladdning (octet-stream) — kringgår { data }-wrappern och
// triggar en webbläsarnedladdning direkt, likt besiktnings-PDF-flödet.
export async function downloadSie4(from: string, to: string): Promise<void> {
  const res = await api.get('/accounting/reports/sie4', {
    params: { from, to },
    responseType: 'blob',
  })
  const url = window.URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `bokforing-${from}-${to}.se`
  a.click()
  window.URL.revokeObjectURL(url)
}
