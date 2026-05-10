import { useAuthStore } from '@/stores/auth.store'
import type { UserRole } from '@eken/shared'

const WRITE_ROLES: UserRole[] = ['MANAGER', 'ADMIN', 'OWNER']
const DELETE_ROLES: UserRole[] = ['ADMIN', 'OWNER']

/**
 * Får användaren skapa/ändra resurser? MANAGER och uppåt — backend:s
 * @Roles-decorators följer samma policy så UI och server är synkade.
 */
export function useCanWrite(): boolean {
  const role = useAuthStore((s) => s.user?.role)
  return role !== undefined && WRITE_ROLES.includes(role)
}

/**
 * Får användaren radera? ADMIN och OWNER. Backend:s @Roles-decorators
 * på destructive endpoints (DELETE /news/:id, etc.) följer samma policy.
 */
export function useCanDelete(): boolean {
  const role = useAuthStore((s) => s.user?.role)
  return role !== undefined && DELETE_ROLES.includes(role)
}

export function useCurrentRole(): UserRole | undefined {
  return useAuthStore((s) => s.user?.role)
}
