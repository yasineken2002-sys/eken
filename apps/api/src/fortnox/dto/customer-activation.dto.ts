import type { ApproveCustomerActivationInput, SammaNycklar } from '@eken/shared'
import { IsInt, IsString, Matches, Min } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'

/** KUNDSTART-001 §6: kundaktivering, bunden till räkenskapsår och konsekvenstextens sha. */
export class ApproveCustomerActivationDto implements ApproveCustomerActivationInput {
  @IsInt()
  @Min(1)
  financialYearId!: number

  @IsString()
  @StrictString()
  @Matches(/^[0-9a-f]{64}$/)
  consequencesSha256!: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _kontrakt: SammaNycklar<ApproveCustomerActivationDto, ApproveCustomerActivationInput> = true
void _kontrakt
