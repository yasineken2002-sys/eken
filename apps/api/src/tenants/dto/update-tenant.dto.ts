import type { SammaNycklar, UpdateTenantInput } from '@eken/shared'
import { IsEnum, IsString, IsEmail, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../common/contract/strict-string.decorator'

// Endast hyresgästens kontaktuppgifter kan uppdateras via denna route.
// Kontrakt (`lease`) hanteras via /v1/leases/:id.
export class UpdateTenantDto implements UpdateTenantInput {
  @ApiProperty({ required: false, enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  @IsOptional()
  type?: 'INDIVIDUAL' | 'COMPANY'

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
  companyName?: string

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
  personalNumber?: string

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  orgNumber?: string

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
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktUppdateraHyresgast: SammaNycklar<UpdateTenantDto, UpdateTenantInput> = true
void _kontraktUppdateraHyresgast
