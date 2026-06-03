import { IsEnum, IsOptional, IsString, IsDateString, MaxLength } from 'class-validator'
import { MeterStatus } from '@prisma/client'

export class UpdateMeterDto {
  @IsEnum(MeterStatus)
  @IsOptional()
  status?: MeterStatus

  @IsString()
  @IsOptional()
  @MaxLength(64)
  serialNumber?: string

  @IsString()
  @IsOptional()
  @MaxLength(64)
  provider?: string

  @IsString()
  @IsOptional()
  @MaxLength(128)
  externalId?: string

  // Sätts vid mätarbyte: den gamla mätaren markeras REMOVED + removedAt. Dess
  // sista avläsning är slutvärdet; den nya mätarens första avläsning blir
  // baslinje (ingen debitering) — så att differensen aldrig blir negativ.
  @IsDateString()
  @IsOptional()
  removedAt?: string
}
