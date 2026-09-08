import type { SammaNycklar, TerminateLeaseInput } from '@eken/shared'
import { IsOptional, IsString, MaxLength } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

export class TerminateLeaseDto implements TerminateLeaseInput {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  @StrictString()
  terminationReason?: string

  // Frivilligt slutdatum. Om utelämnat: idag + noticePeriodMonths.
  @StrictIsoDatum()
  @IsOptional()
  effectiveDate?: string
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSagUppAvtal: SammaNycklar<TerminateLeaseDto, TerminateLeaseInput> = true
void _kontraktSagUppAvtal
