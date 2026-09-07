import { IsEnum, IsString, IsNumber, IsOptional, MaxLength, Min, Max } from 'class-validator'
import { InspectionItemCondition } from '@prisma/client'

import type { UpdateInspectionItemInput, SammaNycklar } from '@eken/shared'
import { INSPECTION_TEXT_MAX, REPAIR_COST_MAX } from '@eken/shared'

/**
 * PATCH /inspections/:id/items/:itemId
 *
 * `repairCost` är `null | number | undefined`, och de tre betyder olika saker:
 * `null` NOLLSTÄLLER (webbens sifferfält skickar det när rutan töms), medan
 * utelämnat lämnar värdet i fred. `@IsOptional()` hoppar över båda, så DTO:n
 * godtog redan `null` — typen säger det nu också.
 *
 * GRÄNSERNA är kolumnens: `Decimal(10, 2)` rymmer högst 99 999 999,99. Utan
 * `@Max` föll ett större tal först i Postgres, som `numeric field overflow` —
 * ett 500-fel om ett värde någon skrev i ett vanligt inmatningsfält. `@Min(0)`
 * är samma sak åt andra hållet: en reparation kostar inte minus.
 */
export class UpdateInspectionItemDto implements UpdateInspectionItemInput {
  @IsEnum(InspectionItemCondition)
  @IsOptional()
  condition?: InspectionItemCondition

  @IsString()
  @MaxLength(INSPECTION_TEXT_MAX)
  @IsOptional()
  notes?: string

  @IsNumber()
  @Min(0)
  @Max(REPAIR_COST_MAX)
  @IsOptional()
  repairCost?: number | null
}

const _kontraktUppdateraPost: SammaNycklar<UpdateInspectionItemDto, UpdateInspectionItemInput> =
  true
void _kontraktUppdateraPost
