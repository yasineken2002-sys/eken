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
import { InvoiceTemplate, BrandFont, VatReportingPeriod } from '@prisma/client'
import { DEFAULT_BRAND_COLOR, REMINDER_FEE_MAX_SEK } from '@eken/shared'

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
    message: `invoiceColor måste vara en giltig hex-färg, t.ex. ${DEFAULT_BRAND_COLOR}`,
  })
  invoiceColor?: string

  @IsOptional()
  @IsEnum(InvoiceTemplate)
  invoiceTemplate?: InvoiceTemplate

  // ── PDF-/dokumentvarumärke (Steg 3, PR 1 — endast datafundament) ──────────
  // Kontrollerad enum (inte fritext) så en ogiltig font-sträng aldrig kan nå
  // PDF-renderaren senare. Ingen renderare läser fältet ännu.
  @IsOptional()
  @IsEnum(BrandFont)
  brandFont?: BrandFont

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'brandSecondaryColor måste vara en giltig hex-färg, t.ex. #2563EB',
  })
  brandSecondaryColor?: string

  @IsBoolean()
  @IsOptional()
  morningReportEnabled?: boolean

  /**
   * SKUGGAGENTEN PÅ FELANMÄLAN (etapp 6).
   *
   * ── FÄLTET ÄR OWNER-ONLY, MEN DTO:N ÄR DET INTE ────────────────────────────
   *
   * `@Roles` sitter på RUTTEN, inte på fältet — `PATCH /organizations/me` är
   * ADMIN + OWNER, och det ska den förbli: en admin ska kunna ändra bankgiro och
   * fakturafärg. Men att slå PÅ en agent är ett annat slags beslut, och det ska
   * bara ägaren få fatta.
   *
   * Grinden ligger därför i TJÄNSTEN och inte här: DTO:t kan inte uttrycka
   * "det här fältet kräver en annan roll än de andra", och en `@ValidateIf` hade
   * flyttat regeln till en plats där bara HTTP-vägen ser den. Tjänsten är den
   * enda ingången alla anropare passerar — samma resonemang som
   * `DecideAssignmentDto.reason`, som är valfri här och obligatorisk där.
   */
  @IsBoolean()
  @IsOptional()
  shadowAgentEnabled?: boolean

  // ── Påminnelse- och inkassoinställningar ───────────────────────────────
  @IsBoolean()
  @IsOptional()
  remindersEnabled?: boolean

  // Taket är lagstadgat och tvingande (4 § och 6 § 1 st lagen 1981:739) — även
  // mot näringsidkare. Lager 1 av två: den här spärren hindrar att ett för högt
  // värde SKRIVS IN. Lager 2 klampar vid debiteringstillfället, för värden som
  // redan ligger i databasen eller kommer in någon annan väg.
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(REMINDER_FEE_MAX_SEK)
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

  // Momsredovisningsperiod (SFL 26 kap). Styr enbart hur berörda momsperioder
  // NAMNGES vid bakdaterad debitering (T1.4) — aldrig bokföringen.
  @IsEnum(VatReportingPeriod)
  @IsOptional()
  vatReportingPeriod?: VatReportingPeriod

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
