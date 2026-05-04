import { applyDecorators } from '@nestjs/common'
import { IsString, MinLength, MaxLength, Matches } from 'class-validator'
import { PASSWORD_MIN_LENGTH, PASSWORD_SPECIAL_CHAR_REGEX } from '@eken/shared'

/**
 * Stark lösenordspolicy som tillämpas på alla endpoints som sätter lösenord:
 *  - register
 *  - change-password (newPassword)
 *  - reset-password (newPassword)
 *  - accept-invite (newPassword)
 *  - tenant-portal activate / reset
 *
 * Krav: 10–128 tecken med minst en stor bokstav, en liten bokstav, en siffra
 * och ett specialtecken. Reglerna är synkade med shared/StrongPasswordSchema
 * samt validatePasswordStrength så UI alltid kan föregripa server-svaret.
 */
export function IsStrongPassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH, {
      message: `Lösenordet måste vara minst ${PASSWORD_MIN_LENGTH} tecken`,
    }),
    MaxLength(128, { message: 'Lösenordet är för långt' }),
    Matches(/[a-z]/, { message: 'Lösenordet måste innehålla en liten bokstav' }),
    Matches(/[A-Z]/, { message: 'Lösenordet måste innehålla en stor bokstav' }),
    Matches(/[0-9]/, { message: 'Lösenordet måste innehålla en siffra' }),
    Matches(PASSWORD_SPECIAL_CHAR_REGEX, {
      message: 'Lösenordet måste innehålla ett specialtecken',
    }),
  )
}
