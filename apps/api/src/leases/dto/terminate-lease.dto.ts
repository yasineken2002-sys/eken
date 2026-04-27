import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator'

export class TerminateLeaseDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  terminationReason?: string

  // Frivilligt slutdatum. Om utelämnat: idag + noticePeriodMonths.
  @IsDateString()
  @IsOptional()
  effectiveDate?: string
}
