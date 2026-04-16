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
