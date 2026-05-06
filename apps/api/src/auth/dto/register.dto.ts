import {
  IsEmail,
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  IsDateString,
  MinLength,
  MaxLength,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { CompanyForm } from '@prisma/client'
import { IsStrongPassword } from './password.decorators'

const COMPANY_FORM_VALUES = Object.values(CompanyForm) as string[]

export class RegisterDto {
  @ApiProperty() @IsEmail({}, { message: 'Ogiltig e-postadress' }) email!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  password!: string

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) organizationName!: string

  // ─── Företagsform och organisationsnummer ────────────────────────────────
  // Validering av att orgNumber faktiskt matchar companyForm görs i
  // AuthService.register() via validateSwedishOrgNumber — class-validator
  // kan inte uttrycka beroenden mellan fält utan en custom validator.
  @ApiPropertyOptional({ enum: CompanyForm, default: CompanyForm.AB })
  @IsOptional()
  @IsIn(COMPANY_FORM_VALUES)
  companyForm?: CompanyForm

  @ApiPropertyOptional({ example: '556123-4567 (AB) eller 198512251234 (Enskild firma)' })
  @IsOptional()
  @IsString()
  orgNumber?: string

  // ─── F-skatt och moms (lagkrav på faktura) ───────────────────────────────
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hasFSkatt?: boolean

  @ApiPropertyOptional({ example: '2024-06-01' })
  @IsOptional()
  @IsDateString()
  fSkattApprovedDate?: string

  @ApiPropertyOptional({ example: '556123456701' })
  @IsOptional()
  @IsString()
  vatNumber?: string

  // ─── Bakåtkompatibilitet ─────────────────────────────────────────────────
  // Gamla klienter skickar ibland bara accountType ('COMPANY'/'PRIVATE').
  // Behålls för att inte bryta tidigare frontend-versioner — backend
  // härleder companyForm från accountType om companyForm saknas (PRIVATE
  // → ENSKILD_FIRMA, COMPANY → AB).
  @ApiPropertyOptional({ enum: ['COMPANY', 'PRIVATE'], default: 'COMPANY' })
  @IsOptional()
  @IsIn(['COMPANY', 'PRIVATE'])
  accountType?: string
}
