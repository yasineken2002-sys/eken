import { PartialType } from '@nestjs/swagger'
import { IsBoolean, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { CreateCustomerDto } from './create-customer.dto'

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {
  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean
}
