import { api, post } from '@/lib/api'
import type { AuthResponse } from '@/stores/auth.store'
import type {
  AcceptInviteRequestInput,
  ChangePasswordRequestInput,
  ForgotPasswordRequestInput,
  LoginInput,
  RegisterInput,
  ResetPasswordRequestInput,
} from '@eken/shared'

export type { AuthResponse }
export type { LoginInput, RegisterInput }

// ── DE TVÅ LOKALA KOPIORNA ÄR BORTA ──────────────────────────────────────────
//
// `LoginInput` och `RegisterInput` deklarerades här som egna interfaces medan
// `LoginSchema` och `RegisterSchema` fanns i @eken/shared hela tiden. Två
// beskrivningar av samma form, och de HADE glidit isär:
//
//   RegisterSchema saknade `acceptTerms` — fältet DTO:n kräver med
//   `@Equals(true)`. Den lokala kopian hade det. Den privata kopian var alltså
//   mer korrekt än den delade källan, och registreringen fungerade bara
//   därför. Schemat är rättat i samma PR.
//
// Kommentaren om `accountType` som stod här — att backend härleder companyForm
// ur den — hör till serverns beteende och står nu vid fältet i RegisterSchema.

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

export interface ChangePasswordResult {
  message: string
  loggedOut: true
}

export async function changePasswordApi(
  input: ChangePasswordRequestInput,
): Promise<ChangePasswordResult> {
  return post<ChangePasswordResult>('/auth/change-password', input)
}

export async function forgotPasswordApi(email: string): Promise<void> {
  const kropp: ForgotPasswordRequestInput = { email }
  await post<void>('/auth/forgot-password', kropp)
}

export async function resetPasswordApi(input: ResetPasswordRequestInput): Promise<void> {
  await post<void>('/auth/reset-password', input)
}

// acceptInvite loggar INTE in användaren. Den sätter lösenordet och returnerar
// e-postadressen så att LoginPage kan förfylla fältet och visa "Konto aktiverat".
export async function acceptInviteApi(input: AcceptInviteRequestInput): Promise<{ email: string }> {
  return post<{ email: string }>('/auth/accept-invite', input)
}
