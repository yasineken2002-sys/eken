import { IsNumber, IsDateString, IsOptional, Min } from 'class-validator'

export class MarkPaidDto {
  @IsNumber()
  @Min(0)
  paidAmount!: number

  @IsDateString()
  @IsOptional()
  paidAt?: string
}
