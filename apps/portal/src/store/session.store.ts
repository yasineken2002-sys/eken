import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { PortalTenant } from '@/types/portal.types'

interface SessionState {
  sessionToken: string | null
  tenant: PortalTenant | null
  expiresAt: string | null
  isAuthenticated: boolean
  setSession: (token: string, tenant: PortalTenant, expiresAt: string) => void
  clearSession: () => void
  getSessionToken: () => string | null
  /**
   * Returnerar true om sessionen har gått ut. Anropas vid app-start och
   * inför varje skyddad route så vi kan logga ut användaren proaktivt
   * istället för att vänta på första 401:an från API:t.
   */
  isExpired: () => boolean
  /**
   * Kontrollera utgång och rensa sessionen om den passerats.
   * Returnerar true om sessionen rensades.
   */
  checkAndClearIfExpired: () => boolean
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessionToken: null,
      tenant: null,
      expiresAt: null,
      isAuthenticated: false,

      setSession: (sessionToken, tenant, expiresAt) =>
        set({ sessionToken, tenant, expiresAt, isAuthenticated: true }),

      clearSession: () =>
        set({ sessionToken: null, tenant: null, expiresAt: null, isAuthenticated: false }),

      getSessionToken: () => get().sessionToken,

      isExpired: () => {
        const { expiresAt, sessionToken } = get()
        if (!sessionToken) return false
        if (!expiresAt) return false
        return new Date(expiresAt).getTime() <= Date.now()
      },

      checkAndClearIfExpired: () => {
        if (get().isExpired()) {
          set({ sessionToken: null, tenant: null, expiresAt: null, isAuthenticated: false })
          return true
        }
        return false
      },
    }),
    {
      name: 'tenant_session',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessionToken: state.sessionToken,
        tenant: state.tenant,
        expiresAt: state.expiresAt,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.checkAndClearIfExpired()
      },
    },
  ),
)
