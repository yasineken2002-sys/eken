import type { SammaNycklar, RenewLeaseInput } from '@eken/shared'
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator'

export class RenewLeaseDto implements RenewLeaseInput {
  @IsDateString()
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
