import { IsEnum, IsString, IsEmail, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateCustomerDto {
  @ApiProperty({ enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  type!: 'INDIVIDUAL' | 'COMPANY'

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  firstName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  lastName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  personalNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  companyName?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  orgNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  contactPerson?: string

  @ApiProperty({ required: false })
  @IsEmail()
  @IsOptional()
  email?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  phone?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  street?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  city?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  postalCode?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  country?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  reference?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  notes?: string
}
