import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as Sentry from '@sentry/react'

export interface PlatformUser {
  id: string
  email: string
  firstName: string
  lastName: string
  totpEnabled: boolean
}

interface AuthState {
  accessToken: string | null
  refreshToken: string | null
  user: PlatformUser | null
  isAuthenticated: boolean
  setSession: (params: { accessToken: string; refreshToken: string; user: PlatformUser }) => void
  setTokens: (accessToken: string, refreshToken: string) => void
  setUser: (user: PlatformUser) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      setSession: ({ accessToken, refreshToken, user }) => {
        Sentry.setUser({ id: user.id, email: user.email })
        set({ accessToken, refreshToken, user, isAuthenticated: true })
      },
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setUser: (user) => {
        Sentry.setUser({ id: user.id, email: user.email })
        set({ user })
      },
      logout: () => {
        Sentry.setUser(null)
        set({ accessToken: null, refreshToken: null, user: null, isAuthenticated: false })
      },
    }),
    { name: 'eken-admin-auth' },
  ),
)
