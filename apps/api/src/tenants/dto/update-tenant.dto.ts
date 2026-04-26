import { IsEnum, IsString, IsEmail, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

// Endast hyresgästens kontaktuppgifter kan uppdateras via denna route.
// Kontrakt (`lease`) hanteras via /v1/leases/:id.
export class UpdateTenantDto {
  @ApiProperty({ required: false, enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  @IsOptional()
  type?: 'INDIVIDUAL' | 'COMPANY'

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
