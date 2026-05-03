import { applyDecorators } from '@nestjs/common'
import { IsString, MinLength, MaxLength, Matches } from 'class-validator'

/**
 * Stark lösenordspolicy som tillämpas på alla endpoints som sätter lösenord:
 *  - register
 *  - change-password (newPassword)
 *  - reset-password (newPassword)
 *  - accept-invite (newPassword)
 *  - tenant-portal activate / reset
 *
 * Krav: 10–128 tecken, minst en stor, minst en liten och minst en siffra.
 * Specialtecken är rekommenderat men inte hård krav (NIST SP 800-63B).
 */
export function IsStrongPassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(10, { message: 'Lösenordet måste vara minst 10 tecken' }),
    MaxLength(128, { message: 'Lösenordet är för långt' }),
    Matches(/[a-z]/, { message: 'Lösenordet måste innehålla en liten bokstav' }),
    Matches(/[A-Z]/, { message: 'Lösenordet måste innehålla en stor bokstav' }),
    Matches(/[0-9]/, { message: 'Lösenordet måste innehålla en siffra' }),
  )
}
