import type { SammaNycklar, RenewLeaseInput } from '@eken/shared'
import { IsNumber, IsOptional, Min } from 'class-validator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

export class RenewLeaseDto implements RenewLeaseInput {
  @StrictIsoDatum()
  @IsOptional()
  newEndDate?: string

  @IsNumber()
  @Min(0)
  @IsOptional()
  monthlyRent?: number
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktForlangAvtal: SammaNycklar<RenewLeaseDto, RenewLeaseInput> = true
void _kontraktForlangAvtal
