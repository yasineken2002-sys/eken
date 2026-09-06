import type { RegisterPaymentInput, SammaNycklar } from '@eken/shared'
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator'
import { PaymentMethod } from '@prisma/client'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

/**
 * Manuell betalningsregistrering på en faktura. Till skillnad från den generiska
 * statusövergången bokförs inbetalningen (likvidkonto D / 1510 K) — se
 * InvoicesService.markAsPaidManually.
 */

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements RegisterPaymentInput` plus paritetsraden längst ned binder formen till
// `RegisterPaymentSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class RegisterPaymentDto implements RegisterPaymentInput {
  @ApiProperty({ description: 'Inbetalt belopp (kr). Sparas i händelseloggen.' })
  @IsNumber()
  @IsPositive()
  amount!: number

  @ApiPropertyOptional({
    enum: PaymentMethod,
    description:
      'Betalningssätt: BANK, CASH, SWISH eller MANUAL. Utelämnat = MANUAL. ' +
      'OBS: tog tidigare emot etiketter som "Bankgiro" — de översätts numera i ' +
      'klienten och avvisas här.',
  })
  /**
   * SAMMA ENUM SOM AVIN. Var tidigare fri text som `toPaymentMethod` mappade
   * tyst — en felstavning blev `MANUAL` utan att något sa ifrån. Utelämnat
   * betyder `MANUAL`, och den defaulten sätts i tjänsten.
   */
  @IsOptional()
  @IsEnum(PaymentMethod, {
    message: `Betalningssättet måste vara ett av ${Object.values(PaymentMethod).join(', ')}`,
  })
  paymentMethod?: PaymentMethod

  /** Etiketten operatören valde ('Plusgiro'). Bevaras bredvid enumen. */
  @ApiPropertyOptional({
    example: 'Plusgiro',
    description:
      'Etiketten som visades för operatören. Sparas på betalningsraden så att ' +
      'skillnaden mellan bankgiro/plusgiro/autogiro inte går förlorad i enumen.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  paymentMethodRaw?: string

  @ApiPropertyOptional({ description: 'OCR/referens' })
  @IsOptional()
  @IsString()
  reference?: string

  @ApiPropertyOptional({ description: 'Betalningsdatum (ISO 8601). Standard: nu.' })
  @IsOptional()
  @IsDateString()
  paidAt?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktBetalning: SammaNycklar<RegisterPaymentDto, RegisterPaymentInput> = true
void _kontraktBetalning
