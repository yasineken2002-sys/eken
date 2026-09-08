import type { UpdateCustomerInput, SammaNycklar } from '@eken/shared'
import { PartialType } from '@nestjs/swagger'
import { IsBoolean, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { CreateCustomerDto } from './create-customer.dto'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

export class UpdateCustomerDto
  extends PartialType(CreateCustomerDto)
  implements UpdateCustomerInput
{
  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  @StrictBoolean()
  isActive?: boolean
}

const _kontrakt: SammaNycklar<UpdateCustomerDto, UpdateCustomerInput> = true
void _kontrakt
