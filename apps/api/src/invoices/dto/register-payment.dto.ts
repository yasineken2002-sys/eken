import { IsNumber, IsOptional, IsPositive, IsString, IsDateString } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

/**
 * Manuell betalningsregistrering på en faktura. Till skillnad från den generiska
 * statusövergången bokförs inbetalningen (likvidkonto D / 1510 K) — se
 * InvoicesService.markAsPaidManually.
 */
export class RegisterPaymentDto {
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
