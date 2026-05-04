// Transient signal från change-password → login så admin-klienten kan visa
// "Lösenordet har bytts" på loginsidan efter forced-utloggningen.
// sessionStorage rensas när fliken stängs.

const KEY = 'eken-admin-login-flash'

export type AdminLoginFlash = { kind: 'password-changed'; email?: string }

export function setAdminLoginFlash(flash: AdminLoginFlash): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(flash))
  } catch {
    // sessionStorage saknas i privat läge — flashen tappas, inget farligt.
  }
}

export function consumeAdminLoginFlash(): AdminLoginFlash | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    sessionStorage.removeItem(KEY)
    const parsed = JSON.parse(raw) as AdminLoginFlash
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
