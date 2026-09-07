import { IsEnum, IsDateString, IsUUID, IsOptional } from 'class-validator'
import { InspectionType } from '@prisma/client'

import type { CreateInspectionInput, SammaNycklar } from '@eken/shared'

/**
 * POST /inspections
 *
 * Formen är oförändrad; det som är nytt är att den är BUNDEN till
 * `CreateInspectionSchema`. Bindningen har en andra konsument: ägar-AI:ns
 * `create_inspection` anropar `inspectionsService.create` direkt och går alltså
 * förbi den här klassen — den parsar numera samma schema i stället för att
 * casta `toolInput.type as never`. Se `tool-executor.service.ts`.
 */
export class CreateInspectionDto implements CreateInspectionInput {
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

// NYCKELPARITET mot det delade schemat — bryts den faller BYGGET, inte ett prov.
const _kontraktSkapaBesiktning: SammaNycklar<CreateInspectionDto, CreateInspectionInput> = true
void _kontraktSkapaBesiktning
