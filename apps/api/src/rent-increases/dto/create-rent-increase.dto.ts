import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

export class CreateRentIncreaseDto {
  @IsUUID()
  leaseId!: string

  @IsNumber()
  @Min(1)
  newRent!: number

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string

  @IsDateString()
  effectiveDate!: string

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string
}
