import axios from 'axios'
import { useSessionStore } from '@/store/session.store'
import type {
  PortalActivationInfo,
  PortalAuthResult,
  PortalDashboard,
  PortalDocument,
  PortalInvoice,
  PortalLease,
  PortalMaintenanceTicket,
  PortalNews,
  PortalNotice,
} from '@/types/portal.types'

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/v1` : '/api'

export const portalApi = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
})

portalApi.interceptors.request.use((config) => {
  const devId = import.meta.env.VITE_DEV_TENANT_ID
  if (devId) config.headers['X-Dev-Tenant-Id'] = devId
  const token = useSessionStore.getState().getSessionToken()
  if (token) config.headers['Authorization'] = `Bearer ${token}`
  return config
})

portalApi.interceptors.response.use(
  (res) => res,
  (error: unknown) => Promise.reject(error),
)

async function get<T>(url: string): Promise<T> {
  const { data } = await portalApi.get<{ data: T }>(url)
  return data.data
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await portalApi.post<{ data: T }>(url, body)
  return data.data
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const fetchActivationInfo = (token: string) =>
  get<PortalActivationInfo>(`/tenant-portal/activation/${encodeURIComponent(token)}`)

export const activateAccount = (payload: { token: string; password: string }) =>
  post<PortalAuthResult>('/tenant-portal/activate', payload)

export const loginWithPassword = (payload: { email: string; password: string }) =>
  post<PortalAuthResult>('/tenant-portal/login', payload)

export const requestForgotPassword = (email: string) =>
  post<{ message: string }>('/tenant-portal/forgot-password', { email })

export const resetPassword = (payload: { token: string; password: string }) =>
  post<PortalAuthResult>('/tenant-portal/reset-password', payload)

export const logoutSession = (sessionToken: string) =>
  post<null>('/tenant-portal/logout', { sessionToken })

// ── Data ──────────────────────────────────────────────────────────────────────

export const fetchDashboard = () => get<PortalDashboard>('/portal/dashboard')
export const fetchLease = () => get<PortalLease>('/portal/lease')
export const fetchInvoices = () => get<PortalInvoice[]>('/portal/invoices')
export const fetchMaintenanceTickets = () => get<PortalMaintenanceTicket[]>('/portal/maintenance')
export const createMaintenanceTicket = (dto: {
  title: string
  description: string
  category: string
}) => post<PortalMaintenanceTicket>('/portal/maintenance', dto)

export async function submitMaintenanceRequest(dto: {
  title: string
  description: string
  category: string
}): Promise<PortalMaintenanceTicket> {
  return post<PortalMaintenanceTicket>('/portal/maintenance', dto)
}
export const addTicketComment = (ticketId: string, content: string) =>
  post<PortalMaintenanceTicket>(`/portal/maintenance/${ticketId}/comment`, { content })
export const fetchNotices = () => get<PortalNotice[]>('/portal/notices')
export const markNoticeRead = (id: string) => post<void>(`/portal/notices/${id}/read`)
export const fetchNews = () => get<PortalNews[]>('/portal/news')
export const fetchDocuments = () => get<PortalDocument[]>('/portal/documents')

// ── GDPR ──────────────────────────────────────────────────────────────────────

export const exportMyData = () => get<unknown>('/portal/me/export')

export async function deleteMyAccount(password: string): Promise<void> {
  await portalApi.delete('/portal/me', { data: { password } })
}
