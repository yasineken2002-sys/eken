import { IsEnum, IsString, IsNumber, IsOptional } from 'class-validator'
import { InspectionItemCondition } from '@prisma/client'

export class UpdateInspectionItemDto {
  @IsEnum(InspectionItemCondition)
  @IsOptional()
  condition?: InspectionItemCondition

  @IsString()
  @IsOptional()
  notes?: string

  @IsNumber()
  @IsOptional()
  repairCost?: number
}
