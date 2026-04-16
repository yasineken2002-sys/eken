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

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config!
    if (error.response?.status !== 401 || (original as { _retry?: boolean })._retry) {
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

export async function del(url: string): Promise<void> {
  await api.delete(url)
}
