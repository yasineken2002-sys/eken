import type { RegisterPaymentInput, SammaNycklar } from '@eken/shared'
import { IsNumber, IsOptional, IsPositive, IsString, IsDateString } from 'class-validator'
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
    description: 'Betalningssätt (Bankgiro, Plusgiro, Swish, Kontant, Autogiro)',
  })
  @IsOptional()
  @IsString()
  paymentMethod?: string

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
