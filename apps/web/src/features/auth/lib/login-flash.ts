// Transient signal från accept-invite → login eller change-password → login
// som överlever en route-byte (vår routing är useState-baserad, så ett
// zustand-snapshot mellan renderingar räcker inte). sessionStorage rensas av
// webbläsaren när fliken stängs.

const KEY = 'eken-login-flash'

export type LoginFlash =
  | { kind: 'account-activated'; email: string }
  | { kind: 'password-changed'; email?: string }

export function setLoginFlash(flash: LoginFlash): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(flash))
  } catch {
    // sessionStorage kan saknas i privat läge — fallback: tappa flashen.
  }
}

export function consumeLoginFlash(): LoginFlash | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    sessionStorage.removeItem(KEY)
    const parsed = JSON.parse(raw) as LoginFlash
    if (parsed?.kind === 'account-activated' && typeof parsed.email === 'string') {
      return parsed
    }
    if (parsed?.kind === 'password-changed') {
      return {
        kind: 'password-changed',
        ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}
