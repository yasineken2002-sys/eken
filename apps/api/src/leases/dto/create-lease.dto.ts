import { IsUUID, IsDateString, IsNumber, IsOptional, Min } from 'class-validator'

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
}
