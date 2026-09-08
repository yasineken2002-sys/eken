import type { MarkNoticePaidInput, SammaNycklar } from '@eken/shared'
import { SEN_BOKFORING_MIN_SKAL, SEN_BOKFORING_MAX_SKAL } from '@eken/shared'
import {
  IsNumber,
  IsDateString,
  IsOptional,
  IsEnum,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'
import { Transform } from 'class-transformer'
import { PaymentMethod } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements MarkNoticePaidInput` plus paritetsraden längst ned binder formen till
// `MarkNoticePaidSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class MarkPaidDto implements MarkNoticePaidInput {
  // Min 0.01: en nollbetalning är ingen affärshändelse och skulle ge en PAID-avi
  // utan motpost (BFL 5 kap 6 §).
  @IsNumber()
  @Min(0.01)
  paidAmount!: number

  // Betalningssätt — obligatoriskt. Styr vilket likvidkonto som debiteras i
  // betalningsverifikatet (BANK/MANUAL → 1930, CASH → 1910, SWISH → 1934).
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod

  @IsDateString()
  @IsOptional()
  paidAt?: string

  /**
   * Skälet till att bokföra en betalning i ett STÄNGT RÄKENSKAPSÅR på första
   * öppna dag. Fältets NÄRVARO är samtycket — se schemats docblock.
   *
   * Rollspärren (OWNER) ligger i `assertFarBokforaSent`, inte här: DTO:n känner
   * inte till vem som frågar.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(SEN_BOKFORING_MIN_SKAL, {
    message:
      'Skälet måste vara minst 10 tecken — det sparas i verifikatets spår och ska gå att förstå i efterhand',
  })
  @MaxLength(SEN_BOKFORING_MAX_SKAL, { message: 'Skälet får vara högst 500 tecken' })
  @StrictString()
  senBokforingSkal?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktAviBetald: SammaNycklar<MarkPaidDto, MarkNoticePaidInput> = true
void _kontraktAviBetald
