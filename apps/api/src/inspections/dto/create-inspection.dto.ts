import { IsEnum, IsDateString, IsUUID, IsOptional } from 'class-validator'
import { InspectionType } from '@prisma/client'

export class CreateInspectionDto {
  @IsEnum(InspectionType)
  type!: InspectionType

  @IsDateString()
  scheduledDate!: string

  @IsUUID()
  propertyId!: string

  @IsUUID()
  unitId!: string

  @IsUUID()
  @IsOptional()
  leaseId?: string

  @IsUUID()
  @IsOptional()
  tenantId?: string
}
