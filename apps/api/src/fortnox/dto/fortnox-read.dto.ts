import { ArrayMinSize, IsArray, IsInt, IsPositive, IsString, Matches } from 'class-validator'

import type { FortnoxReadInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

const CIVIL = /^\d{4}-\d{2}-\d{2}$/

/**
 * POST /integrations/fortnox/reads. Formen bor i `fortnoxReadInputSchema`
 * (@eken/shared). Årsgränserna är klientens KOPIA ur katalogen och aldrig bevis:
 * tjänsten läser året ur Fortnox och avvisar avvikelse med 409.
 */
export class FortnoxReadDto implements FortnoxReadInput {
  @IsInt()
  @IsPositive()
  financialYearId!: number

  @IsString()
  @StrictString()
  @Matches(CIVIL)
  financialYearStart!: string

  @IsString()
  @StrictString()
  @Matches(CIVIL)
  financialYearEnd!: string

  @IsString()
  @StrictString()
  @Matches(CIVIL)
  periodFrom!: string

  @IsString()
  @StrictString()
  @Matches(CIVIL)
  periodTo!: string

  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  costAccounts!: number[]
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxReadDto, FortnoxReadInput> = true
void _kontrakt
