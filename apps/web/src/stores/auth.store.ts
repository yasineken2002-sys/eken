import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { User } from '@eken/shared'

export interface AuthOrg {
  id: string
  name: string
  orgNumber: string | null
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

      setAuth: ({ user, organization, accessToken, refreshToken }) =>
        set({ user, organization, accessToken, refreshToken, isAuthenticated: true }),

      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),

      clearAuth: () =>
        set({
          user: null,
          organization: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        }),

      logout: () =>
        set({
          user: null,
          organization: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        }),

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
