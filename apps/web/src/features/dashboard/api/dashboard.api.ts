import { get } from '@/lib/api'

export interface DashboardStats {
  invoices: {
    total: number
    draft: number
    sent: number
    paid: number
    overdue: number
    totalRevenue: number
    overdueAmount: number
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
