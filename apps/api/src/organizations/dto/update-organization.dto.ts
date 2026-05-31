import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsDateString,
  Matches,
  Min,
  Max,
} from 'class-validator'
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

  // ── Skatteinformation (F-skatt + moms) ──────────────────────────────────
  // companyForm är medvetet INTE uppdaterbar via detta endpoint — den
  // sätts vid registrering och får bara ändras via support. Anledning:
  // den styr eget kapital-serien i kontoplanen och en byte mitt i ett
  // räkenskapsår skulle leda till blandade konton som inte balanserar.
  @IsBoolean()
  @IsOptional()
  hasFSkatt?: boolean

  @IsDateString()
  @IsOptional()
  fSkattApprovedDate?: string

  @IsString()
  @IsOptional()
  vatNumber?: string

  // ── Hyresavi-inställningar ───────────────────────────────────────────────
  // Antal dagar före tillträde som deposition + första hyresavi förfaller.
  // Standard 7 (Hyresgästföreningens rekommendation). Hyresvärden väljer
  // 5/7/14 i SettingsPage.
  @IsNumber()
  @IsOptional()
  @Min(1)
  daysBeforeMoveInForFirstPayment?: number

  // ── Bankavstämning ───────────────────────────────────────────────────────
  // Intern kontrollgräns (#36): rader i PDF-bankavstämning vars belopp
  // överstiger detta flaggas/avvisas + loggas. Default 5 MSEK. Absolut tak
  // 50 MSEK (MAX_TX_AMOUNT) — högre värden clampas i resolveMaxTxAmount.
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(50_000_000)
  maxBankTxAmount?: number
}
