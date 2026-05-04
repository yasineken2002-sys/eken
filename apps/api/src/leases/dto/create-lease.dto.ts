import {
  IsUUID,
  IsDateString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsString,
  IsBoolean,
  IsInt,
  Min,
  Max,
} from 'class-validator'

export class CreateLeaseDto {
  @IsUUID()
  unitId!: string

  @IsUUID()
  tenantId!: string

  @IsDateString()
  startDate!: string

  @IsDateString()
  @IsOptional()
  endDate?: string

  @IsNumber()
  @Min(0)
  monthlyRent!: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  depositAmount?: number

  @IsEnum(['FIXED_TERM', 'INDEFINITE'])
  @IsOptional()
  leaseType?: 'FIXED_TERM' | 'INDEFINITE'

  @IsNumber()
  @Min(1)
  @IsOptional()
  renewalPeriodMonths?: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  noticePeriodMonths?: number

  // ── Vad ingår ──────────────────────────────────────────────────────────
  @IsBoolean() @IsOptional() includesHeating?: boolean
  @IsBoolean() @IsOptional() includesWater?: boolean
  @IsBoolean() @IsOptional() includesHotWater?: boolean
  @IsBoolean() @IsOptional() includesElectricity?: boolean
  @IsBoolean() @IsOptional() includesInternet?: boolean
  @IsBoolean() @IsOptional() includesCleaning?: boolean
  @IsBoolean() @IsOptional() includesParking?: boolean
  @IsBoolean() @IsOptional() includesStorage?: boolean
  @IsBoolean() @IsOptional() includesLaundry?: boolean

  // ── Tilläggshyror ──────────────────────────────────────────────────────
  @IsNumber() @Min(0) @IsOptional() parkingFee?: number
  @IsNumber() @Min(0) @IsOptional() storageFee?: number
  @IsNumber() @Min(0) @IsOptional() garageFee?: number

  // ── Användning, husdjur, andrahand, försäkring ─────────────────────────
  @IsString() @IsOptional() usagePurpose?: string
  @IsEnum(['ALLOWED', 'REQUIRES_APPROVAL', 'NOT_ALLOWED'])
  @IsOptional()
  petsAllowed?: 'ALLOWED' | 'REQUIRES_APPROVAL' | 'NOT_ALLOWED'
  @IsString() @IsOptional() petsApprovalNotes?: string
  @IsBoolean() @IsOptional() sublettingAllowed?: boolean
  @IsBoolean() @IsOptional() requiresHomeInsurance?: boolean

  // ── Indexklausul ───────────────────────────────────────────────────────
  @IsEnum(['NONE', 'KPI', 'NEGOTIATED', 'MARKET_RENT'])
  @IsOptional()
  indexClauseType?: 'NONE' | 'KPI' | 'NEGOTIATED' | 'MARKET_RENT'
  @IsInt() @Min(1900) @Max(2100) @IsOptional() indexBaseYear?: number
  @IsString() @IsOptional() indexAdjustmentDate?: string
  @IsNumber() @Min(0) @Max(100) @IsOptional() indexMaxIncrease?: number
  @IsNumber() @Min(0) @Max(100) @IsOptional() indexMinIncrease?: number
  @IsString() @IsOptional() indexNotes?: string
}
