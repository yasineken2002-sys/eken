import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator'
import { ApiProperty, PartialType } from '@nestjs/swagger'
import { StrictString } from '../../../common/contract/strict-string.decorator'

export class CreateOrganizationDto {
  @ApiProperty()
  @IsString()
  @StrictString()
  name!: string
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  orgNumber?: string
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  vatNumber?: string
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  phone?: string
  @ApiProperty()
  @IsString()
  @StrictString()
  street!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  city!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  postalCode!: string
  @ApiProperty({ required: false, default: 'SE' })
  @IsString()
  @IsOptional()
  @StrictString()
  country?: string

  @ApiProperty({
    enum: ['TRIAL', 'STARTER', 'MINI', 'STANDARD', 'PLUS', 'PRO'],
    required: false,
  })
  @IsEnum(['TRIAL', 'STARTER', 'MINI', 'STANDARD', 'PLUS', 'PRO'])
  @IsOptional()
  plan?: 'TRIAL' | 'STARTER' | 'MINI' | 'STANDARD' | 'PLUS' | 'PRO'

  @ApiProperty({ required: false, description: 'Längd på trial i dagar (default 30)' })
  @IsInt()
  @Min(0)
  @IsOptional()
  trialDays?: number

  @ApiProperty({ required: false })
  @IsEmail()
  @IsOptional()
  billingEmail?: string

  @ApiProperty({ required: false, description: 'Månatlig avgift i SEK' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  monthlyFee?: number

  // Första admin-användaren skapas tillsammans med organisationen.
  @ApiProperty() @IsEmail() adminEmail!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  adminFirstName!: string
  @ApiProperty()
  @IsString()
  @StrictString()
  adminLastName!: string

  @ApiProperty({
    required: false,
    description: 'Temporärt lösenord. Genereras automatiskt om utelämnat.',
  })
  @IsString()
  @MinLength(8)
  @IsOptional()
  @StrictString()
  adminPassword?: string
}

export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {}

export class SuspendOrganizationDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  reason?: string
}

export class CancelOrganizationDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @StrictString()
  reason?: string
}
