import { Type } from 'class-transformer'
import { IsBooleanString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'

import type { AiAssignmentStatus } from '@prisma/client'

/** Inkorgens sidstorlek. Ett tak som SYNS — svaret bär `total`, aldrig bara raderna. */
export const INKORG_SIDSTORLEK_MAX = 100
export const INKORG_SIDSTORLEK_STANDARD = 25

export class QueryAssignmentsDto {
  @IsOptional()
  @IsIn(['AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED'])
  status?: AiAssignmentStatus

  /**
   * Filtrera på skuggförslag. Sträng och inte boolean: query-parametrar är
   * alltid strängar, och en `@IsBoolean()` hade avvisat `?shadow=true`.
   */
  @IsOptional()
  @IsBooleanString()
  shadow?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INKORG_SIDSTORLEK_MAX)
  limit?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number
}
