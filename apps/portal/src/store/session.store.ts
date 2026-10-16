import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import * as Sentry from '@sentry/react'
import { z } from 'zod'
import type { PortalSessionTenant } from '@/types/portal.types'

const STORAGE_KEY = 'tenant_session'
const anonymous: SessionSnapshot = {
  sessionToken: null,
  tenant: null,
  expiresAt: null,
  isAuthenticated: false,
}
// Lokal lagring är indata, inte ett bevis på en giltig serversession.
const storedSession = z.object({
  sessionToken: z.string().min(1),
  tenant: z.object({
    id: z.string().min(1),
    type: z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
    email: z.string(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    companyName: z.string().nullish(),
    phone: z.string().nullish(),
  }),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  isAuthenticated: z.literal(true),
})

interface SessionState {
  sessionToken: string | null
  tenant: PortalSessionTenant | null
  expiresAt: string | null
  isAuthenticated: boolean
  /** Lokal livstid för cache, komponenter och anrop. Aldrig token eller lagrad identifierare. */
  sessionGeneration: number
  setSession: (token: string, tenant: PortalSessionTenant, expiresAt: string) => void
  clearSession: () => void
  getSessionToken: () => string | null
  isExpired: () => boolean
  checkAndClearIfExpired: () => boolean
}

type SessionSnapshot = Pick<
  SessionState,
  'sessionToken' | 'tenant' | 'expiresAt' | 'isAuthenticated'
>

function snapshot(value: unknown): SessionSnapshot {
  const parsed = storedSession.safeParse(value)
  if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) return anonymous
  const { tenant, ...session } = parsed.data
  return {
    ...session,
    tenant: {
      id: tenant.id,
      email: tenant.email,
      ...(tenant.type !== undefined ? { type: tenant.type } : {}),
      ...(tenant.firstName != null ? { firstName: tenant.firstName } : {}),
      ...(tenant.lastName != null ? { lastName: tenant.lastName } : {}),
      ...(tenant.companyName != null ? { companyName: tenant.companyName } : {}),
      ...(tenant.phone != null ? { phone: tenant.phone } : {}),
    },
  }
}

function sameSession(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  return (
    a.sessionToken === b.sessionToken &&
    a.tenant?.id === b.tenant?.id &&
    a.expiresAt === b.expiresAt &&
    a.isAuthenticated === b.isAuthenticated
  )
}

// En annan fliks storage-event får inte skriva tillbaka samma värde och skapa
// eko. Läsningen nedan hämtar alltid NUVARANDE lagring, aldrig event.newValue.
let applyingStorage = false

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      ...anonymous,
      sessionGeneration: 0,
      setSession: (sessionToken, tenant, expiresAt) => {
        const next = snapshot({ sessionToken, tenant, expiresAt, isAuthenticated: true })
        if (sameSession(get(), next)) return
        Sentry.setUser(next.tenant ? { id: next.tenant.id, email: next.tenant.email } : null)
        set({ ...next, sessionGeneration: get().sessionGeneration + 1 })
      },
      clearSession: () => {
        Sentry.setUser(null)
        set({ ...anonymous, sessionGeneration: get().sessionGeneration + 1 })
      },
      getSessionToken: () => get().sessionToken,
      isExpired: () => {
        const { sessionToken, expiresAt } = get()
        return (
          !!sessionToken &&
          (!expiresAt ||
            !Number.isFinite(Date.parse(expiresAt)) ||
            Date.parse(expiresAt) <= Date.now())
        )
      },
      checkAndClearIfExpired: () => {
        if (!get().isExpired()) return false
        get().clearSession()
        return true
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          if (!applyingStorage) localStorage.setItem(name, value)
        },
        removeItem: (name) => {
          if (!applyingStorage) localStorage.removeItem(name)
        },
      })),
      partialize: ({ sessionToken, tenant, expiresAt, isAuthenticated }) => ({
        sessionToken,
        tenant,
        expiresAt,
        isAuthenticated,
      }),
      merge: (persisted, current) => {
        const next = snapshot(persisted)
        return {
          ...current,
          ...next,
          sessionGeneration: current.sessionGeneration + (sameSession(current, next) ? 0 : 1),
        }
      },
      onRehydrateStorage: () => (state) => {
        Sentry.setUser(state?.tenant ? { id: state.tenant.id, email: state.tenant.email } : null)
      },
    },
  ),
)

export function isSessionCurrent(generation: number): boolean {
  const state = useSessionStore.getState()
  return state.sessionGeneration === generation && !state.isExpired()
}

/** Monteras en gång av appens sessionsgräns; städas även vid StrictMode-remount. */
export function startSessionSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleExpiry = () => {
    clearTimeout(timer)
    const state = useSessionStore.getState()
    if (!state.sessionToken) return
    const remaining = state.expiresAt ? Date.parse(state.expiresAt) - Date.now() : 0
    timer = setTimeout(
      () => {
        useSessionStore.getState().checkAndClearIfExpired()
        scheduleExpiry()
      },
      Math.min(2_147_483_647, Math.max(0, Number.isFinite(remaining) ? remaining : 0)),
    )
  }
  const syncStorage = () => {
    let persisted: unknown = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && 'state' in parsed) persisted = parsed.state
      }
    } catch {
      /* Oåtkomlig eller skadad lagring ger utloggat läge. */
    }
    const next = snapshot(persisted)
    const current = useSessionStore.getState()
    if (sameSession(current, next)) return
    applyingStorage = true
    try {
      Sentry.setUser(next.tenant ? { id: next.tenant.id, email: next.tenant.email } : null)
      useSessionStore.setState({ ...next, sessionGeneration: current.sessionGeneration + 1 })
    } finally {
      applyingStorage = false
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (
      (event.key === STORAGE_KEY || event.key === null) &&
      (!event.storageArea || event.storageArea === localStorage)
    )
      syncStorage()
  }
  const onFocus = () => {
    syncStorage()
    useSessionStore.getState().checkAndClearIfExpired()
  }
  const unsubscribe = useSessionStore.subscribe(scheduleExpiry)
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  syncStorage()
  useSessionStore.getState().checkAndClearIfExpired()
  scheduleExpiry()
  return () => {
    clearTimeout(timer)
    unsubscribe()
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onFocus)
  }
}
