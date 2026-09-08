import { CreateLeaseWithTenantSchema } from '@eken/shared'
import { UppfyllerSchemat } from '../../common/contract/uppfyller-schemat.decorator'

import type { SammaNycklar, CreateLeaseWithTenantInput, NewTenantInLeaseInput } from '@eken/shared'
import {
  IsUUID,
  IsNumber,
  IsOptional,
  IsEnum,
  IsString,
  IsEmail,
  IsBoolean,
  IsInt,
  Min,
  Max,
  ValidateNested,
  ValidateIf,
} from 'class-validator'
import { Type } from 'class-transformer'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

export class NewTenantDto implements NewTenantInLeaseInput {
  @IsEnum(['INDIVIDUAL', 'COMPANY'])
  type!: 'INDIVIDUAL' | 'COMPANY'

  @IsString()
  @IsOptional()
  @StrictString()
  firstName?: string

  @IsString()
  @IsOptional()
  @StrictString()
  lastName?: string

  @IsString()
  @IsOptional()
  @StrictString()
  companyName?: string

  @IsEmail()
  email!: string

  @IsString()
  @IsOptional()
  @StrictString()
  phone?: string

  @IsString()
  @IsOptional()
  @StrictString()
  personalNumber?: string

  @IsString()
  @IsOptional()
  @StrictString()
  orgNumber?: string

  @IsString()
  @IsOptional()
  @StrictString()
  street?: string

  @IsString()
  @IsOptional()
  @StrictString()
  city?: string

  @IsString()
  @IsOptional()
  @StrictString()
  postalCode?: string

  @IsString()
  @IsOptional()
  @StrictString()
  country?: string
}

@UppfyllerSchemat(CreateLeaseWithTenantSchema)
export class CreateLeaseWithTenantDto implements CreateLeaseWithTenantInput {
  @IsUUID()
  unitId!: string

  @IsUUID()
  @IsOptional()
  existingTenantId?: string

  @ValidateIf((o: CreateLeaseWithTenantDto) => !o.existingTenantId)
  @ValidateNested()
  @Type(() => NewTenantDto)
  @IsOptional()
  newTenant?: NewTenantDto

  @IsNumber()
  @Min(0)
  monthlyRent!: number

  @IsNumber()
  @Min(0)
  @IsOptional()
  depositAmount?: number

  @StrictIsoDatum()
  startDate!: string

  @StrictIsoDatum()
  @IsOptional()
  endDate?: string

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
  @IsString()
  @IsOptional()
  @StrictString()
  specialTerms?: string

  @StrictBoolean() // När `true` aktiveras kontraktet (DRAFT → ACTIVE) i samma anrop. Då
  // enqueueasr också välkomstmejlet med aktiveringslänk + PDF-genereringen.
  // Default false → spara som utkast.
  @IsBoolean()
  @IsOptional()
  activate?: boolean
}

/**
 * NYCKELPARITET — BÅDA NIVÅERNA.
 *
 * `implements` på ytterklassen fångar inte att den NÄSTLADE `newTenant` glidit:
 * `SammaNycklar` jämför nycklarna på den nivå den får, och ett fält som saknas
 * inuti `NewTenantDto` syns inte uppifrån. Den nästlade typen får därför en
 * egen rad.
 */
const _kontraktAvtalMedHyresgast: SammaNycklar<
  CreateLeaseWithTenantDto,
  CreateLeaseWithTenantInput
> = true
void _kontraktAvtalMedHyresgast

const _kontraktNyHyresgastIAvtal: SammaNycklar<NewTenantDto, NewTenantInLeaseInput> = true
void _kontraktNyHyresgastIAvtal
