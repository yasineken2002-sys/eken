import { api, get, post, patch } from '@/lib/api'
import type { UserRole } from '@eken/shared'

export interface OrgUser {
  id: string
  email: string
  firstName: string
  lastName: string
  role: UserRole
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface InviteUserInput {
  email: string
  firstName: string
  lastName: string
  role: 'ADMIN' | 'MANAGER'
}

export type AssignableRole = 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER'

export function fetchUsers(): Promise<OrgUser[]> {
  return get<OrgUser[]>('/users')
}

export function inviteUser(dto: InviteUserInput): Promise<OrgUser> {
  return post<OrgUser>('/users/invite', dto)
}

export function updateUserRole(id: string, role: AssignableRole): Promise<OrgUser> {
  return patch<OrgUser>(`/users/${id}/role`, { role })
}

export async function deactivateUser(id: string): Promise<OrgUser> {
  const { data } = await api.delete<{ data: OrgUser }>(`/users/${id}`)
  return data.data
}

export function reactivateUser(id: string): Promise<OrgUser> {
  return post<OrgUser>(`/users/${id}/reactivate`, {})
}
