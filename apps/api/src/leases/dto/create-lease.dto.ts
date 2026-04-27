import { IsUUID, IsDateString, IsNumber, IsOptional, IsEnum, Min } from 'class-validator'

export class CreateLeaseDto {
  @IsUUID()
  unitId!: string

  @IsUUID()
  tenantId!: string

  @IsDateString()
  startDate!: string

  @IsDateString()
  @IsOptional()
  endDate?: string

  @IsNumber()
  @Min(0)
  monthlyRent!: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  depositAmount?: number

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
