import { get } from '@/lib/api'

export interface DashboardStats {
  // Periodiserad intäkt (accrual) ur huvudboken: Σ kontoklass 3 för
  // räkenskapsåret till dags dato. from/to = periodens gränser (ISO).
  revenue: {
    total: number
    from: string
    to: string
  }
  // Faktisk förfallen, obetald skuld (RentNotice outstanding + OVERDUE Invoice,
  // exkl. deposition). Eget toppfält — spänner över båda skuldkällorna.
  overdue: {
    total: number
  }
  invoices: {
    total: number
    draft: number
    sent: number
    paid: number
    overdue: number
  }
  tenants: {
    total: number
    individual: number
    company: number
  }
  properties: {
    total: number
  }
  leases: {
    total: number
    active: number
    draft: number
  }
  recentInvoices: Array<{
    id: string
    invoiceNumber: string
    status: string
    total: number
    dueDate: string
    tenantName: string
  }>
}

export function getDashboardStats(): Promise<DashboardStats> {
  return get<DashboardStats>('/dashboard/stats')
}

export type DashboardPeriod = '6months' | '12months' | '24months'

export interface TimeseriesPoint {
  month: string
  revenue: number
  paidRevenue: number
  newLeases: number
  terminatedLeases: number
  occupancy: number
  openTickets: number
}

export function getDashboardTimeseries(period: DashboardPeriod): Promise<TimeseriesPoint[]> {
  return get<TimeseriesPoint[]>(`/dashboard/timeseries?period=${period}`)
}
