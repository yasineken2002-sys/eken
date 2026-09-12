import type { CreateMaintenancePlanInput, SammaNycklar } from '@eken/shared'
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
import { StrictString } from '../../common/contract/strict-string.decorator'

export class CreateMaintenancePlanDto implements CreateMaintenancePlanInput {
  @IsString()
  @MinLength(3)
  @StrictString()
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
  @StrictString()
  description?: string

  @IsString()
  @IsOptional()
  @StrictString()
  notes?: string
}

const _kontrakt: SammaNycklar<CreateMaintenancePlanDto, CreateMaintenancePlanInput> = true
void _kontrakt
