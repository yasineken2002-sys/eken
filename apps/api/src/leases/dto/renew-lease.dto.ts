import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator'

export class RenewLeaseDto {
  @IsDateString()
  @IsOptional()
  newEndDate?: string

  @IsNumber()
  @Min(0)
  @IsOptional()
  monthlyRent?: number
}
