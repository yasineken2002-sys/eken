import { get, post } from '@/lib/api'

export type TenantInviteStatus =
  | 'NOT_INVITED'
  | 'NO_EMAIL'
  | 'INVITED'
  | 'DELIVERED'
  | 'BOUNCED'
  | 'ACTIVATED'

export interface InviteStatusRow {
  tenantId: string
  name: string
  email: string
  status: TenantInviteStatus
  invitedAt: string | null
  inviteCount: number
  portalActivatedAt: string | null
  deliveredAt: string | null
  bouncedAt: string | null
  /** Förklaring vid BOUNCED (studs-orsak eller spam-anmälan) — annars null. */
  bounceReason: string | null
}

export interface InviteStatusList {
  counts: Record<TenantInviteStatus, number>
  total: number
  page: number
  pageSize: number
  items: InviteStatusRow[]
}

export interface TenantRef {
  tenantId: string
  name: string
  email: string
}

export interface InviteResult {
  invited: number
  alreadyActivated: number
  skippedRecent: number
  skippedNoEmail: number
  failed: number
  /** Hyresgäster utan giltig mejl — ytas så de kan åtgärdas (ej tyst skip). */
  noEmailTenants: TenantRef[]
  failedTenants: Array<TenantRef & { error: string }>
}

export function fetchInviteStatus(params?: {
  status?: TenantInviteStatus
  page?: number
  pageSize?: number
}): Promise<InviteStatusList> {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.page) q.set('page', String(params.page))
  if (params?.pageSize) q.set('pageSize', String(params.pageSize))
  const qs = q.toString()
  return get<InviteStatusList>(`/tenant-portal/admin/invitations${qs ? `?${qs}` : ''}`)
}

export function inviteTenants(body: {
  all?: boolean
  tenantIds?: string[]
  force?: boolean
}): Promise<InviteResult> {
  return post<InviteResult>('/tenant-portal/admin/invitations', body)
}

export function resendInvites(body: {
  tenantIds?: string[]
  onlyNotActivated?: boolean
}): Promise<InviteResult> {
  return post<InviteResult>('/tenant-portal/admin/invitations/resend', body)
}
