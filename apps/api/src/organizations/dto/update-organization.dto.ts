import { IsString, IsOptional, IsNumber, IsBoolean, IsEnum, Matches, Min } from 'class-validator'
import { InvoiceTemplate } from '@prisma/client'

export class UpdateOrganizationDto {
  @IsString()
  @IsOptional()
  bankgiro?: string

  @IsNumber()
  @IsOptional()
  @Min(1)
  paymentTermsDays?: number

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'invoiceColor måste vara en giltig hex-färg, t.ex. #1a6b3c',
  })
  invoiceColor?: string

  @IsOptional()
  @IsEnum(InvoiceTemplate)
  invoiceTemplate?: InvoiceTemplate

  @IsBoolean()
  @IsOptional()
  morningReportEnabled?: boolean

  // ── Påminnelse- och inkassoinställningar ───────────────────────────────
  @IsBoolean()
  @IsOptional()
  remindersEnabled?: boolean

  @IsNumber()
  @IsOptional()
  @Min(0)
  reminderFeeSek?: number

  @IsNumber()
  @IsOptional()
  @Min(1)
  reminderFormalDay?: number

  @IsNumber()
  @IsOptional()
  @Min(1)
  reminderCollectionDay?: number

  @IsString()
  @IsOptional()
  collectionAgencyName?: string
}
