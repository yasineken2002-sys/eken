import { IsString, IsOptional, IsNumber, IsBoolean, Min } from 'class-validator'

export class UpdateOrganizationDto {
  @IsString()
  @IsOptional()
  bankgiro?: string

  @IsNumber()
  @IsOptional()
  @Min(1)
  paymentTermsDays?: number

  @IsString()
  @IsOptional()
  invoiceColor?: string

  @IsString()
  @IsOptional()
  invoiceTemplate?: string

  @IsBoolean()
  @IsOptional()
  morningReportEnabled?: boolean
}
