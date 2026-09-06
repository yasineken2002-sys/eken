import type { SammaNycklar, RejectRentIncreaseInput } from '@eken/shared'
import { IsString, MaxLength, MinLength } from 'class-validator'

export class RejectRentIncreaseDto implements RejectRentIncreaseInput {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  rejectionReason!: string
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktAvslaHojning: SammaNycklar<RejectRentIncreaseDto, RejectRentIncreaseInput> = true
void _kontraktAvslaHojning
