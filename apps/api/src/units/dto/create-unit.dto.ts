import type { SammaNycklar, CreateUnitInput } from '@eken/shared'
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

const UNIT_TYPES = ['APARTMENT', 'OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER'] as const
const UNIT_STATUSES = ['VACANT', 'OCCUPIED', 'UNDER_RENOVATION', 'RESERVED'] as const

export class CreateUnitDto implements CreateUnitInput {
  @IsUUID()
  propertyId!: string

  @IsString()
  @MinLength(1)
  @StrictString()
  name!: string

  @IsString()
  @MinLength(1)
  @StrictString()
  unitNumber!: string

  @IsEnum(UNIT_TYPES)
  type!: (typeof UNIT_TYPES)[number]

  @IsEnum(UNIT_STATUSES)
  @IsOptional()
  status?: (typeof UNIT_STATUSES)[number]

  @IsNumber()
  @Min(0)
  area!: number

  @IsNumber()
  @IsOptional()
  floor?: number

  @IsNumber()
  @IsOptional()
  rooms?: number

  @IsNumber()
  @Min(0)
  monthlyRent!: number

  /**
   * I2 — frivillig skattskyldighet, ett uttryckligt användarval.
   *
   * `ValidateIf(!== undefined)` i stället för `@IsOptional()`: ett utelämnat
   * fält är frånvarande, men ett uttryckligt `null` VALIDERAS och avvisas av
   * `@IsBoolean()` — både här och i PATCH (som ärver). Med `@IsOptional()` hade
   * `null` blivit en tyst no-op med 200 (se update-unit.dto.ts).
   * `@StrictBoolean()` godtar strängformerna `"true"`/`"false"` (normaliseras till
   * booleaner, husets kontrakt) och avvisar allt annat — `1`, `"ja"`, `""`, objekt —
   * i stället för att koercera. Det delade schemat godtar exakt samma värden
   * (R2, `unit-frivillig-kontrakt.spec.ts` prövar pariteten genom den riktiga pipen).
   */
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  @StrictBoolean()
  voluntaryTaxLiability?: boolean
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSkapaLagenhet: SammaNycklar<CreateUnitDto, CreateUnitInput> = true
void _kontraktSkapaLagenhet
