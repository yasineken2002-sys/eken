import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsNumber,
  IsDateString,
  IsBoolean,
} from 'class-validator'
import { MaintenanceCategory, MaintenancePriority, MaintenanceStatus } from '@prisma/client'

export class UpdateMaintenanceTicketDto {
  @IsString()
  @IsOptional()
  title?: string

  @IsString()
  @IsOptional()
  description?: string

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

  @IsEnum(MaintenanceStatus)
  @IsOptional()
  status?: MaintenanceStatus

  @IsDateString()
  @IsOptional()
  scheduledDate?: string

  @IsNumber()
  @IsOptional()
  estimatedCost?: number

  @IsNumber()
  @IsOptional()
  actualCost?: number

  @IsBoolean()
  @IsOptional()
  tenantNotified?: boolean
}
