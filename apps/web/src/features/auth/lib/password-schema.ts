import { StrongPasswordSchema } from '@eken/shared'

// Single source of truth — synkad med backend (apps/api/.../password.decorators.ts)
// och delade utils (validatePasswordStrength). Ändras kraven uppdateras alla
// formulär (registrering, byt lösenord, aktivering, glömt lösenord, portal).
export const passwordSchema = StrongPasswordSchema

export function readErrorMessage(err: unknown, fallback: string): string {
  return (
    (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
      ?.message ?? fallback
  )
}
