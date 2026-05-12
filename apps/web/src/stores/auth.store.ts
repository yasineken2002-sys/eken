import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import * as Sentry from '@sentry/react'
import type { User } from '@eken/shared'

export interface AuthOrg {
  id: string
  name: string
  orgNumber: string | null
  // Version av Användarvillkor + Integritetspolicy som organisationen
  // senast accepterat. null = legacy-konto (innan acceptance-fältet
  // fanns) eller färska konton vars version blivit lägre än
  // CURRENT_TERMS_VERSION. Frontend visar re-acceptance-modal då.
  termsVersion: string | null
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: User
  organization: AuthOrg
}

interface AuthState {
  user: User | null
  organization: AuthOrg | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  setAuth: (response: AuthResponse) => void
  setTokens: (accessToken: string, refreshToken: string) => void
  setOrgTermsVersion: (version: string) => void
  clearAuth: () => void
  logout: () => void // alias for clearAuth — used by Axios interceptor
  getAccessToken: () => string | null
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      organization: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      setAuth: ({ user, organization, accessToken, refreshToken }) => {
        Sentry.setUser({ id: user.id, email: user.email })
        Sentry.setTag('organizationId', organization.id)
        set({ user, organization, accessToken, refreshToken, isAuthenticated: true })
      },

      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),

      setOrgTermsVersion: (version) =>
        set((state) =>
          state.organization
            ? { organization: { ...state.organization, termsVersion: version } }
            : state,
        ),

      clearAuth: () => {
        Sentry.setUser(null)
        set({
          user: null,
          organization: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        })
      },

      logout: () => {
        Sentry.setUser(null)
        set({
          user: null,
          organization: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        })
      },

      getAccessToken: () => get().accessToken,
    }),
    {
      name: 'eken-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        organization: state.organization,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
)
