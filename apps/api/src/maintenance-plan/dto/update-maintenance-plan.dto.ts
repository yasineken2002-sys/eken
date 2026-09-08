import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator'
import { MaintenancePlanCategory, MaintenancePlanStatus } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class UpdateMaintenancePlanDto {
  @IsString()
  @IsOptional()
  @StrictString()
  title?: string

  @IsEnum(MaintenancePlanCategory)
  @IsOptional()
  category?: MaintenancePlanCategory

  @IsEnum(MaintenancePlanStatus)
  @IsOptional()
  status?: MaintenancePlanStatus

  @IsInt()
  @Min(2020)
  @Max(2060)
  @IsOptional()
  plannedYear?: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  estimatedCost?: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  actualCost?: number

  @IsInt()
  @Min(1)
  @Max(3)
  @IsOptional()
  priority?: number

  @IsInt()
  @IsOptional()
  interval?: number

  @IsInt()
  @IsOptional()
  lastDoneYear?: number

  @IsString()
  @IsOptional()
  @StrictString()
  description?: string

  @IsString()
  @IsOptional()
  @StrictString()
  notes?: string

  @IsDateString()
  @IsOptional()
  completedAt?: string
}
