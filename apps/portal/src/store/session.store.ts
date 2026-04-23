import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { PortalTenant } from '@/types/portal.types'

interface SessionState {
  sessionToken: string | null
  tenant: PortalTenant | null
  isAuthenticated: boolean
  setSession: (token: string, tenant: PortalTenant) => void
  clearSession: () => void
  getSessionToken: () => string | null
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessionToken: null,
      tenant: null,
      isAuthenticated: false,

      setSession: (sessionToken, tenant) => set({ sessionToken, tenant, isAuthenticated: true }),

      clearSession: () => set({ sessionToken: null, tenant: null, isAuthenticated: false }),

      getSessionToken: () => get().sessionToken,
    }),
    {
      name: 'tenant_session',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessionToken: state.sessionToken,
        tenant: state.tenant,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
)
