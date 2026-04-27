import {
  IsUUID,
  IsDateString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsString,
  IsEmail,
  Min,
  ValidateNested,
  ValidateIf,
} from 'class-validator'
import { Type } from 'class-transformer'

export class NewTenantDto {
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  type!: 'INDIVIDUAL' | 'COMPANY'

  @IsString()
  @IsOptional()
  firstName?: string

  @IsString()
  @IsOptional()
  lastName?: string

  @IsString()
  @IsOptional()
  companyName?: string

  @IsEmail()
  email!: string

  @IsString()
  @IsOptional()
  phone?: string
}

export class CreateLeaseWithTenantDto {
  @IsUUID()
  unitId!: string

  @IsUUID()
  @IsOptional()
  existingTenantId?: string

  @ValidateIf((o: CreateLeaseWithTenantDto) => !o.existingTenantId)
  @ValidateNested()
  @Type(() => NewTenantDto)
  @IsOptional()
  newTenant?: NewTenantDto

  @IsNumber()
  @Min(0)
  monthlyRent!: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  depositAmount?: number

  @IsDateString()
  startDate!: string

  @IsDateString()
  @IsOptional()
  endDate?: string

  @IsEnum(['FIXED_TERM', 'INDEFINITE'])
  @IsOptional()
  leaseType?: 'FIXED_TERM' | 'INDEFINITE'

  @IsNumber()
  @Min(1)
  @IsOptional()
  renewalPeriodMonths?: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  noticePeriodMonths?: number
}
