import { z } from 'zod'

// Måste matcha backend-validering: min 8 tecken, minst 1 stor bokstav, 1 siffra.
export const passwordSchema = z
  .string()
  .min(8, 'Lösenordet måste vara minst 8 tecken')
  .regex(/[A-Z]/, 'Lösenordet måste innehålla minst en stor bokstav')
  .regex(/[0-9]/, 'Lösenordet måste innehålla minst en siffra')

export function readErrorMessage(err: unknown, fallback: string): string {
  return (
    (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
      ?.message ?? fallback
  )
}
