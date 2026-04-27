import { IsUUID, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator'

export class CreateDepositDto {
  @IsUUID()
  leaseId!: string

  // Frivilligt — om utelämnat används Lease.depositAmount.
  @IsNumber()
  @Min(1)
  @IsOptional()
  amount?: number

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}
