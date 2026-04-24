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

export class CreateOrganizationDto {
  @ApiProperty() @IsString() name!: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() orgNumber?: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() vatNumber?: string
  @ApiProperty() @IsEmail() email!: string
  @ApiProperty({ required: false }) @IsString() @IsOptional() phone?: string
  @ApiProperty() @IsString() street!: string
  @ApiProperty() @IsString() city!: string
  @ApiProperty() @IsString() postalCode!: string
  @ApiProperty({ required: false, default: 'SE' })
  @IsString()
  @IsOptional()
  country?: string

  @ApiProperty({ enum: ['TRIAL', 'BASIC', 'STANDARD', 'PREMIUM'], required: false })
  @IsEnum(['TRIAL', 'BASIC', 'STANDARD', 'PREMIUM'])
  @IsOptional()
  plan?: 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'

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
  @ApiProperty() @IsString() adminFirstName!: string
  @ApiProperty() @IsString() adminLastName!: string

  @ApiProperty({
    required: false,
    description: 'Temporärt lösenord. Genereras automatiskt om utelämnat.',
  })
  @IsString()
  @MinLength(8)
  @IsOptional()
  adminPassword?: string
}

export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {}

export class SuspendOrganizationDto {
  @ApiProperty({ required: false }) @IsString() @IsOptional() reason?: string
}

export class CancelOrganizationDto {
  @ApiProperty({ required: false }) @IsString() @IsOptional() reason?: string
}
