import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator'
import { MaintenancePlanCategory } from '@prisma/client'

export class CreateMaintenancePlanDto {
  @IsString()
  @MinLength(3)
  title!: string

  @IsUUID()
  propertyId!: string

  @IsEnum(MaintenancePlanCategory)
  @IsOptional()
  category?: MaintenancePlanCategory

  @IsInt()
  @Min(2020)
  @Max(2060)
  plannedYear!: number

  @IsNumber()
  @Min(0)
  estimatedCost!: number

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
  description?: string

  @IsString()
  @IsOptional()
  notes?: string
}
