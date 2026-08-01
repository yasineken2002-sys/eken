import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator'
import { Transform } from 'class-transformer'
import { AccountingPeriodEventReasonCategory } from '@prisma/client'

/**
 * Kroppen till POST /accounting/periods/:year/:month/reopen.
 *
 * Importeras som VÄRDE (aldrig `import type`) — NestJS läser reflect-metadata i
 * runtime, och en typ-import gör klassen osynlig för ValidationPipe.
 *
 * Validering här är BEKVÄMLIGHET, inte skyddet: samma två regler upprepas i
 * `AccountingPeriodService.reopenPeriod` (chokepunkten) och `reasonCategory` +
 * `reason`-längden tvingas dessutom av CHECK-villkor i databasen. Tre lager, för
 * att en framtida intern anropare inte ska kunna smita förbi det som gör
 * händelsen läsbar i efterhand.
 */
export class ReopenPeriodDto {
  /**
   * Varför perioden öppnas igen, i klartext. Sparas i periodens historik och går
   * inte att ändra efteråt. Minst 10 tecken efter trimning — samma gräns som
   * DB:ns CHECK, så en sträng med bara blanksteg inte räknas som ett skäl.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ange varför perioden öppnas igen' })
  @MinLength(10, {
    message:
      'Skälet måste vara minst 10 tecken — det sparas i historiken och ska gå att förstå i efterhand',
  })
  @MaxLength(500, { message: 'Skälet får vara högst 500 tecken' })
  reason!: string

  /**
   * MISSING_ENTRY (en post saknas) eller EXISTING_ENTRY_INCORRECT (en bokförd
   * post är fel). Kategorin GRINDAR — den senare avvisas innan någon händelse
   * skrivs. Se `canReopenForCorrection`.
   */
  @IsEnum(AccountingPeriodEventReasonCategory, {
    message: 'Ange om en post saknas eller om en bokförd post är felaktig',
  })
  reasonCategory!: AccountingPeriodEventReasonCategory
}
