import { IsInt, IsPositive, IsString, Matches } from 'class-validator'

import type { FortnoxReconcileInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

/** POST /integrations/fortnox/exports/:id/reconcile. Servern läser exakt identiteten i Fortnox. */
export class FortnoxReconcileDto implements FortnoxReconcileInput {
  @IsInt()
  @IsPositive()
  year!: number

  @IsString()
  @StrictString()
  @Matches(/^[A-Za-z0-9]{1,10}$/)
  series!: string

  @IsInt()
  @IsPositive()
  number!: number
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<FortnoxReconcileDto, FortnoxReconcileInput> = true
void _kontrakt
