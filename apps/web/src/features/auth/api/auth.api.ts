import { api, post } from '@/lib/api'
import type { AuthResponse } from '@/stores/auth.store'

export type { AuthResponse }

export interface LoginInput {
  email: string
  password: string
}

export interface RegisterInput {
  email: string
  password: string
  firstName: string
  lastName: string
  organizationName: string
  orgNumber?: string
  accountType?: 'COMPANY' | 'PRIVATE'
}

export async function loginApi(dto: LoginInput): Promise<AuthResponse> {
  return post<AuthResponse>('/auth/login', dto)
}

export async function registerApi(dto: RegisterInput): Promise<AuthResponse> {
  return post<AuthResponse>('/auth/register', dto)
}

export async function logoutApi(): Promise<void> {
  await api.post('/auth/logout')
}

// ── Lösenordshantering ──────────────────────────────────────────────────────

export async function changePasswordApi(input: {
  currentPassword: string
  newPassword: string
}): Promise<void> {
  await api.post('/auth/change-password', input)
}

export async function forgotPasswordApi(email: string): Promise<void> {
  await api.post('/auth/forgot-password', { email })
}

export async function resetPasswordApi(input: {
  token: string
  newPassword: string
}): Promise<void> {
  await api.post('/auth/reset-password', input)
}

// acceptInvite loggar INTE in användaren. Den sätter lösenordet och returnerar
// e-postadressen så att LoginPage kan förfylla fältet och visa "Konto aktiverat".
export async function acceptInviteApi(input: {
  token: string
  newPassword: string
}): Promise<{ email: string }> {
  return post<{ email: string }>('/auth/accept-invite', input)
}
