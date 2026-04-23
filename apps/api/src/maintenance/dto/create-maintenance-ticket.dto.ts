import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsNumber,
  MinLength,
  IsDateString,
} from 'class-validator'
import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

export class CreateMaintenanceTicketDto {
  @IsString()
  @MinLength(3)
  title!: string

  @IsString()
  @MinLength(10)
  description!: string

  @IsUUID()
  propertyId!: string

  @IsUUID()
  @IsOptional()
  unitId?: string

  @IsUUID()
  @IsOptional()
  tenantId?: string

  @IsEnum(MaintenanceCategory)
  @IsOptional()
  category?: MaintenanceCategory

  @IsEnum(MaintenancePriority)
  @IsOptional()
  priority?: MaintenancePriority

  @IsDateString()
  @IsOptional()
  scheduledDate?: string

  @IsNumber()
  @IsOptional()
  estimatedCost?: number
}
