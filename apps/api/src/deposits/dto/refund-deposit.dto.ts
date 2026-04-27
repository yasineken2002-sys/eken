import { Type } from 'class-transformer'
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'

export class DeductionDto {
  @IsString()
  @MaxLength(200)
  reason!: string

  @IsNumber()
  @Min(0)
  amount!: number
}

export class RefundDepositDto {
  @IsNumber()
  @Min(0)
  refundAmount!: number

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeductionDto)
  @IsOptional()
  @ArrayMinSize(0)
  deductions?: DeductionDto[]

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}
