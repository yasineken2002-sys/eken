import { Equals, IsBoolean, IsString, Matches } from 'class-validator'

import type { FortnoxSendInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

/** POST /integrations/fortnox/exports/:id/send. Formen bor i `fortnoxSendInputSchema`. */
export class FortnoxSendDto implements FortnoxSendInput {
  @IsString()
  @StrictString()
  @Matches(/^[0-9a-f]{64}$/)
  draftHash!: string

  @IsBoolean()
  @StrictBoolean()
  @Equals(true)
  confirm!: true
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxSendDto, FortnoxSendInput> = true
void _kontrakt
