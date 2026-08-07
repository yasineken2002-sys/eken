import { IsString, MinLength } from 'class-validator'

/**
 * G4a — skälet till att en påminnelseavgift stryks.
 *
 * Fritext, inte en enum. Skälet blir motverifikatets beskrivning i huvudboken
 * och ska gå att förstå av en revisor som läser verifikatet fristående ett år
 * senare (BFL 5 kap — verifikationen ska ange vad transaktionen avser). En
 * enum-kod hade tvingat fram en gissning om vilka fall som kan uppstå; det
 * vanligaste ("betalningen hade kommit fram men var inte matchad") skiljer sig
 * dessutom från de övriga på ett sätt som spelar roll för bedömningen.
 *
 * Minimilängden speglar REVERSAL_REASON_MIN_LENGTH i AccountingService: ett
 * skäl som bara är "fel" hjälper ingen.
 */
export class ReverseReminderFeeDto {
  @IsString()
  @MinLength(10)
  reason!: string
}
