import { IsIn, IsString, MinLength } from 'class-validator'

import type { FortnoxMappingInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

/**
 * PUT /integrations/fortnox/mappings. Formen bor i `fortnoxMappingInputSchema`.
 * Tjänsten kontrollerar dimensionen i Fortnox och fastigheten i organisationen.
 */
export class FortnoxMappingDto implements FortnoxMappingInput {
  @IsIn(['COST_CENTER', 'PROJECT'])
  dimensionType!: 'COST_CENTER' | 'PROJECT'

  @IsString()
  @StrictString()
  @MinLength(1)
  code!: string

  @IsString()
  @StrictString()
  @MinLength(1)
  propertyId!: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxMappingDto, FortnoxMappingInput> = true
void _kontrakt
