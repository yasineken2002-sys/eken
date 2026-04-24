import { useAuthStore, type AuthOrg } from '@/stores/auth.store'
import type { User } from '@eken/shared'

const HASH_KEY = 'impersonate'

interface DecodedJwtPayload {
  sub: string
  email: string
  organizationId: string
  role: User['role']
  impersonatedBy?: string
  impersonationLogId?: string
  exp?: number
}

function decodeJwt(token: string): DecodedJwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payloadB64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const json = atob(padded)
    return JSON.parse(json) as DecodedJwtPayload
  } catch {
    return null
  }
}

function parseHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  return params.get(HASH_KEY)
}

function stripImpersonateFromHash() {
  const hash = window.location.hash
  if (!hash) return
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(raw)
  if (!params.has(HASH_KEY)) return
  params.delete(HASH_KEY)
  params.delete('logId') // legacy/extras från admin-klienten
  const remaining = params.toString()
  const url = `${window.location.pathname}${window.location.search}${remaining ? '#' + remaining : ''}`
  window.history.replaceState(null, '', url)
}

/**
 * Konsumerar ?impersonate=<jwt> från URL-hashen (om den finns), hydrerar
 * auth-store mot /v1/auth/me, och rensar hashen. Returnerar true om
 * impersonation aktiverats (så anroparen kan vänta på render-cykeln).
 */
export async function consumeImpersonationHash(): Promise<boolean> {
  const token = parseHash(window.location.hash)
  if (!token) return false

  const payload = decodeJwt(token)
  if (!payload || !payload.impersonatedBy) {
    stripImpersonateFromHash()
    return false
  }

  // Sätt minimal state direkt så axios interceptor hittar token, och hydrera
  // sedan user+org från /auth/me.
  useAuthStore.setState({
    accessToken: token,
    refreshToken: null, // impersonation-tokens kan inte refreshas
    isAuthenticated: true,
    user: null,
    organization: null,
  })

  stripImpersonateFromHash()

  try {
    // Viktigt: anropa /auth/me manuellt med fetch så vi inte drar in axios
    // innan storen är hydrerad. Annars triggas 401-interceptor på race.
    const res = await fetch('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`me failed: ${res.status}`)
    const body = (await res.json()) as {
      data: {
        user: User
        organization: AuthOrg
        impersonation: { active: boolean; platformUserId: string; logId: string | null } | null
      }
    }
    useAuthStore.setState({
      user: body.data.user,
      organization: body.data.organization,
    })
    return true
  } catch (err) {
    console.error('[impersonation] /auth/me misslyckades', err)
    useAuthStore.getState().clearAuth()
    return false
  }
}

/**
 * Kollar om nuvarande access-token är en impersonation-token.
 * Returnerar platformUserId om så är fallet, annars null.
 */
export function getImpersonation(): { platformUserId: string; logId: string | null } | null {
  const token = useAuthStore.getState().accessToken
  if (!token) return null
  const payload = decodeJwt(token)
  if (!payload?.impersonatedBy) return null
  return {
    platformUserId: payload.impersonatedBy,
    logId: payload.impersonationLogId ?? null,
  }
}
