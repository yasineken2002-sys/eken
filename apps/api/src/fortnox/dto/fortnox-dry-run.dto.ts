import { IsString, MinLength } from 'class-validator'

import type { FortnoxDryRunInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

/** POST /integrations/fortnox/exports/dry-run. Verifikatet kontrolleras org-bundet i tjänsten. */
export class FortnoxDryRunDto implements FortnoxDryRunInput {
  @IsString()
  @StrictString()
  @MinLength(1)
  journalEntryId!: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxDryRunDto, FortnoxDryRunInput> = true
void _kontrakt
