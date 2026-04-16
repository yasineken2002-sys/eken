import { IsEnum, IsString, IsEmail, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateTenantDto {
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
  companyName?: string

  @ApiProperty()
  @IsEmail()
  email!: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  phone?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  personalNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  orgNumber?: string

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
}
