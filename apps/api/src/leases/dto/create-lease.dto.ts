import type { SammaNycklar, CreateLeaseInput } from '@eken/shared'
import { CreateLeaseSchema } from '@eken/shared'
import { UppfyllerSchemat } from '../../common/contract/uppfyller-schemat.decorator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'
import {
  IsUUID,
  IsNumber,
  IsOptional,
  IsEnum,
  IsString,
  IsBoolean,
  IsInt,
  Min,
  Max,
} from 'class-validator'

@UppfyllerSchemat(CreateLeaseSchema)
export class CreateLeaseDto implements CreateLeaseInput {
  @IsUUID()
  unitId!: string

  @IsUUID()
  tenantId!: string

  @StrictIsoDatum()
  startDate!: string

  @StrictIsoDatum()
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

  // Regelverk (#69). Utelämnas normalt → service sätter default efter enhetstyp
  // (bostad → privatuthyrning, lokal → hyreslagen). PRIVATE_RENTAL bara för bostad.
  @IsEnum(['PRIVATE_RENTAL', 'TENANCY_ACT'])
  @IsOptional()
  tenancyRegime?: 'PRIVATE_RENTAL' | 'TENANCY_ACT'

  @IsNumber()
  @Min(1)
  @IsOptional()
  renewalPeriodMonths?: number

  // JB 12 kap 4 § — uppsägningstid får aldrig vara 0. Lagens minimum är
  // 3 mån (bostad) eller 9 mån (lokal). Service-laget validerar mot unit.type.
  @IsInt()
  @Min(1)
  @Max(60)
  @IsOptional()
  noticePeriodMonths?: number

  @StrictBoolean() // ── Vad ingår ──────────────────────────────────────────────────────────
  @IsBoolean()
  @IsOptional()
  includesHeating?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesWater?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesHotWater?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesElectricity?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesInternet?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesCleaning?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesParking?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesStorage?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() includesLaundry?: boolean

  // ── Tilläggshyror ──────────────────────────────────────────────────────
  @IsNumber() @Min(0) @IsOptional() parkingFee?: number
  @IsNumber() @Min(0) @IsOptional() storageFee?: number
  @IsNumber() @Min(0) @IsOptional() garageFee?: number

  // ── Användning, husdjur, andrahand, försäkring ─────────────────────────
  @IsString()
  @IsOptional()
  @StrictString()
  usagePurpose?: string
  @IsEnum(['ALLOWED', 'REQUIRES_APPROVAL', 'NOT_ALLOWED'])
  @IsOptional()
  petsAllowed?: 'ALLOWED' | 'REQUIRES_APPROVAL' | 'NOT_ALLOWED'
  @IsString()
  @IsOptional()
  @StrictString()
  petsApprovalNotes?: string
  @StrictBoolean() @IsBoolean() @IsOptional() sublettingAllowed?: boolean
  @StrictBoolean() @IsBoolean() @IsOptional() requiresHomeInsurance?: boolean

  // ── Indexklausul ───────────────────────────────────────────────────────
  @IsEnum(['NONE', 'KPI', 'NEGOTIATED', 'MARKET_RENT'])
  @IsOptional()
  indexClauseType?: 'NONE' | 'KPI' | 'NEGOTIATED' | 'MARKET_RENT'
  @IsInt() @Min(1900) @Max(2100) @IsOptional() indexBaseYear?: number
  @IsString()
  @IsOptional()
  @StrictString()
  indexAdjustmentDate?: string
  @IsNumber() @Min(0) @Max(100) @IsOptional() indexMaxIncrease?: number
  @IsNumber() @Min(0) @Max(100) @IsOptional() indexMinIncrease?: number
  @IsString()
  @IsOptional()
  @StrictString()
  indexNotes?: string

  // ── Övriga villkor / särskilda bestämmelser (Kontraktsmall 2.0) ────────
  // Fritextfält för egna villkor utöver standardparagraferna. Renderas
  // som egen § "Övriga villkor & särskilda bestämmelser" i kontraktet
  // när det är ifyllt.
  @IsString()
  @IsOptional()
  @StrictString()
  specialTerms?: string
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSkapaAvtal: SammaNycklar<CreateLeaseDto, CreateLeaseInput> = true
void _kontraktSkapaAvtal
