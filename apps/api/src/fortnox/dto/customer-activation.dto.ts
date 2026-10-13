import type {
  ApproveCustomerActivationInput,
  ChooseLedgerOwnerInput,
  SammaNycklar,
} from '@eken/shared'
import { IsInt, IsString, IsUUID, Matches, Min } from 'class-validator'
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

/** HUVUDBOK-STEG1 (154): val av Fortnox som huvudbok, bundet till den aktiva kundaktiveringen. */
export class ChooseLedgerOwnerDto implements ChooseLedgerOwnerInput {
  @IsString()
  @StrictString()
  @IsUUID()
  activationId!: string
}

const _kontraktHuvudbok: SammaNycklar<ChooseLedgerOwnerDto, ChooseLedgerOwnerInput> = true
void _kontraktHuvudbok
