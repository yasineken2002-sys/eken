import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator'
import { MaintenanceCategory } from '@prisma/client'

import type {
  AssignContractorInput,
  CreateContractorInput,
  SammaNycklar,
  UpdateContractorInput,
} from '@eken/shared'
import { MAINTENANCE_CATEGORIES } from '@eken/shared'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'

/**
 * HANTVERKARREGISTRET — formen bor i @eken/shared, gränserna här.
 *
 * `@IsEnum(MaintenanceCategory)` läser PRISMAS enum, inte den delade listan.
 * Det är avsiktligt och inte en andra uppräkning: de två är bundna av
 * `maintenance-enum-source.spec.ts`, som kräver likhet åt båda hållen. Att
 * validera mot Prisma här betyder att gränsen är densamma som databasens.
 */
export class CreateContractorDto implements CreateContractorInput {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  contactPerson?: string

  @IsOptional()
  @IsEmail()
  email?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  phone?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  orgNumber?: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAINTENANCE_CATEGORIES.length)
  @IsEnum(MaintenanceCategory, { each: true })
  categories?: MaintenanceCategory[]

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string

  // Se `no-coercion.decorator.ts`: utan den gör pipens implicita konvertering
  // strängen "false" till `true`, och en hantverkare någon avaktiverade hade
  // blivit aktiv igen.
  @IsOptional()
  @IngenKoercion()
  @IsBoolean()
  isActive?: boolean
}

export class UpdateContractorDto implements UpdateContractorInput {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  contactPerson?: string

  @IsOptional()
  @IsEmail()
  email?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  phone?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  orgNumber?: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAINTENANCE_CATEGORIES.length)
  @IsEnum(MaintenanceCategory, { each: true })
  categories?: MaintenanceCategory[]

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string

  @IsOptional()
  @IngenKoercion()
  @IsBoolean()
  isActive?: boolean
}

/**
 * PATCH /maintenance/:id/assign
 *
 * `null` är ett GILTIGT värde och betyder "ta bort tilldelningen".
 * `@IsOptional()` duger inte: den släpper igenom ett UTELÄMNAT fält, och då
 * hade "avtilldela" och "gör ingenting" varit samma anrop. `@IsUUID()` med
 * `IsOptional` på ett null-värde hoppas över av class-validator, vilket är
 * precis vad vi vill — men fältet måste vara NÄRVARANDE, och det bärs av att
 * schemat inte är `.optional()`.
 */
export class AssignContractorDto implements AssignContractorInput {
  @IsOptional()
  @IsUUID()
  contractorId!: string | null
}

const _kontraktSkapa: SammaNycklar<CreateContractorDto, CreateContractorInput> = true
const _kontraktUppdatera: SammaNycklar<UpdateContractorDto, UpdateContractorInput> = true
const _kontraktTilldela: SammaNycklar<AssignContractorDto, AssignContractorInput> = true
void _kontraktSkapa
void _kontraktUppdatera
void _kontraktTilldela
