import { IsEnum, IsString, IsDateString, IsOptional } from 'class-validator'
import { InspectionStatus } from '@prisma/client'

export class UpdateInspectionDto {
  @IsEnum(InspectionStatus)
  @IsOptional()
  status?: InspectionStatus

  @IsString()
  @IsOptional()
  notes?: string

  @IsString()
  @IsOptional()
  overallCondition?: string

  @IsDateString()
  @IsOptional()
  completedAt?: string

  @IsDateString()
  @IsOptional()
  signedAt?: string

  @IsString()
  @IsOptional()
  tenantSignature?: string

  @IsString()
  @IsOptional()
  landlordSignature?: string
}
