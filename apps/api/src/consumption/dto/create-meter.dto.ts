import { IsEnum, IsOptional, IsString, IsUUID, IsDateString, MaxLength } from 'class-validator'
import { MeterType } from '@prisma/client'

export class CreateMeterDto {
  @IsUUID()
  unitId!: string

  @IsEnum(MeterType)
  type!: MeterType

  // Fri text, källagnostisk: "kWh" | "m³" | "MWh".
  @IsString()
  @MaxLength(16)
  unitOfMeasure!: string

  @IsString()
  @IsOptional()
  @MaxLength(64)
  serialNumber?: string

  // Källagnostik: extern koppling för framtida leverantörs-API.
  @IsString()
  @IsOptional()
  @MaxLength(64)
  provider?: string

  @IsString()
  @IsOptional()
  @MaxLength(128)
  externalId?: string

  @IsDateString()
  @IsOptional()
  installedAt?: string
}
