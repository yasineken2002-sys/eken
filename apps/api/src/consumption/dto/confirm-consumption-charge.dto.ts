import { Length, Matches } from 'class-validator'
import type { ConfirmConsumptionChargeInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class ConfirmConsumptionChargeDto implements ConfirmConsumptionChargeInput {
  @Length(64, 64)
  @Matches(/^[a-f0-9]{64}$/)
  @StrictString()
  expectedFingerprint!: string
}
const _contract: SammaNycklar<ConfirmConsumptionChargeDto, ConfirmConsumptionChargeInput> = true
void _contract
