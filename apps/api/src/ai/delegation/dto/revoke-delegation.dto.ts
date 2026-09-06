import { IsOptional, IsString, MaxLength } from 'class-validator'

import type { RevokeDelegationInput, SammaNycklar } from '@eken/shared'

/**
 * Skälet till ett återkallande.
 *
 * Frivilligt med FLIT — se `RevokeDelegationSchema` i `@eken/shared`, där skälet
 * till frivilligheten står. Regeln bor i schemat och inte här, så att webben och
 * API:t inte kan ha var sin åsikt om den.
 */
export class RevokeDelegationDto implements RevokeDelegationInput {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  skäl?: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. Se `create-from-assignment.dto.ts`. */
const _kontrakt: SammaNycklar<RevokeDelegationDto, RevokeDelegationInput> = true
void _kontrakt
