import { api, get, post, patch } from '@/lib/api'
import type { UserRole, ASSIGNABLE_ROLES } from '@eken/shared'

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
  role: AssignableRole
}

/**
 * Rollen som kan tilldelas — härledd ur @eken/shared, inte skriven här (R3).
 * Konstanten importeras type-only: bara typen behövs i den här filen.
 */
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

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
