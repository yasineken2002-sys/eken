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
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class UpdateMaintenanceTicketDto {
  @IsString()
  @IsOptional()
  @StrictString()
  title?: string

  @IsString()
  @IsOptional()
  @StrictString()
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
  @StrictBoolean()
  tenantNotified?: boolean
}
