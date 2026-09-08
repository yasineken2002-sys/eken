import { IsEnum, IsString, IsEmail, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class CreateCustomerDto {
  @ApiProperty({ enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  type!: 'INDIVIDUAL' | 'COMPANY'

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  firstName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  lastName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  personalNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  companyName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  orgNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  contactPerson?: string

  @ApiProperty({ required: false })
  @IsEmail()
  @IsOptional()
  email?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  phone?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  street?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  city?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  postalCode?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  country?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  reference?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  notes?: string
}
