import axios, { type AxiosError } from 'axios'
import { useAuthStore } from '@/stores/auth.store'

export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
})

// ─── Request interceptor: attach access token ─────────────────────────────────

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ─── Response interceptor: handle 401 + token refresh ────────────────────────

let isRefreshing = false
let pendingQueue: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = []

// /auth/* endpoints SKA inte triggera refresh – ett 401 där betyder fel lösenord
// eller utgånget refresh-token, inte ett expired access-token.
//
// BANKID:S INLOGGNINGSVÄGAR HÖR TILL SAMMA FAMILJ (#745 PR 3). Ett 401 från
// `bankid/login/collect` betyder "inget konto är kopplat till det här BankID:t"
// — inte att en access-token gått ut. Utan raden nedan gick det felet in i
// refresh-grenen, som utan refresh-token kastar "No refresh token", ANROPAR
// logout() och avvisar med FEL fel: gränssnittet hade visat ett meddelande om
// något annat, och en redan inloggad användare hade loggats ut av att någon
// provade BankID i samma flik.
//
// Anslutningsvägarna (`bankid/enroll/*`) står med FLIT inte här: de kräver
// inloggning, och ett 401 där ÄR en utgången access-token som ska förnyas.
const AUTH_PATH_RE = /\/auth\/(login|register|refresh|logout|bankid\/login)\b/

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config!
    const isAuthPath = typeof original.url === 'string' && AUTH_PATH_RE.test(original.url)
    if (error.response?.status !== 401 || (original as { _retry?: boolean })._retry || isAuthPath) {
      return Promise.reject(error)
    }

    ;(original as { _retry?: boolean })._retry = true

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        pendingQueue.push({
          resolve: (token) => {
            original.headers!.Authorization = `Bearer ${token}`
            resolve(api(original))
          },
          reject,
        })
      })
    }

    isRefreshing = true
    try {
      const { refreshToken, setTokens } = useAuthStore.getState()
      if (!refreshToken) throw new Error('No refresh token')

      const { data } = await axios.post<{ data: { accessToken: string; refreshToken: string } }>(
        '/api/v1/auth/refresh',
        { refreshToken },
      )

      const { accessToken, refreshToken: newRefresh } = data.data
      setTokens(accessToken, newRefresh)

      pendingQueue.forEach((p) => p.resolve(accessToken))
      pendingQueue = []

      original.headers!.Authorization = `Bearer ${accessToken}`
      return api(original)
    } catch (e) {
      pendingQueue.forEach((p) => p.reject(e))
      pendingQueue = []
      useAuthStore.getState().logout()
      return Promise.reject(e)
    } finally {
      isRefreshing = false
    }
  },
)

// ─── Typed helpers ────────────────────────────────────────────────────────────

export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const { data } = await api.get<{ data: T }>(url, { params })
  return data.data
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await api.post<{ data: T }>(url, body)
  return data.data
}

export async function patch<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await api.patch<{ data: T }>(url, body)
  return data.data
}

export async function del(url: string, config?: { data?: unknown }): Promise<void> {
  await api.delete(url, config)
}

// ─── Felmeddelande-extraktion ─────────────────────────────────────────────────
// API:t svarar konsekvent med { success: false, error: { message, ... } } —
// vi packar upp meddelandet här så att globala mutation-toasts och lokala
// onError-handlers slipper duplicera unwrap-logiken.
export function extractApiError(err: unknown, fallback = 'Något gick fel'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: { message?: unknown }; message?: unknown }
      | undefined
    const apiMessage = data?.error?.message
    if (typeof apiMessage === 'string' && apiMessage.trim()) return apiMessage
    if (Array.isArray(apiMessage) && apiMessage.length > 0)
      return apiMessage.filter((m) => typeof m === 'string').join('. ') || fallback
    if (typeof data?.message === 'string' && data.message.trim()) return data.message
    if (err.message && err.code !== 'ERR_BAD_RESPONSE') return err.message
  }
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/**
 * Är felet ett 403 från backend — alltså ett NEKANDE, inte ett haveri?
 *
 * Skiljelinjen finns för att de två kräver olika svar i gränssnittet. Ett 500
 * är "något gick sönder, försök igen"; ett 403 är "systemet fungerar, du får
 * inte se det här". Att visa det andra som det första gör en korrekt
 * behörighetsgräns till en upplevd bugg.
 *
 * 401 räknas INTE hit: interceptorn ovan försöker refresha token och loggar ut
 * vid misslyckande, så ett 401 blir aldrig ett stabilt lästillstånd.
 */
export function isForbidden(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 403
}
