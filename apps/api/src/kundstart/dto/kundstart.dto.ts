import type {
  ApproveOpeningPackageInput,
  BindOpeningReadInput,
  FirstPeriodRegisterInput,
  SammaNycklar,
  SeparateLedgerInput,
  SetCutoverInput,
  UploadOpeningPackageInput,
} from '@eken/shared'
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

// KUNDSTART-001: formen bor i @eken/shared (schemas/kundstart.ts). Varje DTO bär
// `implements` + nyckelparitet, och KONTRAKTSREGISTER kör giltig/ogiltig genom båda.

const DATUM = /^\d{4}-\d{2}-\d{2}$/
const SHA256 = /^[0-9a-f]{64}$/

/** KUNDSTART-001 §5: brytdatum 'ÅÅÅÅ-MM-01' eller null (ingen gräns). Servern prövar dagen. */
export class SetCutoverDto implements SetCutoverInput {
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @StrictString()
  @Matches(DATUM)
  cutoverDate!: string | null
}

/** Öppningspaketets CSV som text (mall i KUNDUNDERLAG.md). Fastifys gräns är 1 MiB. */
export class UploadOpeningPackageDto implements UploadOpeningPackageInput {
  @IsString()
  @StrictString()
  @MinLength(1)
  @MaxLength(200)
  sourceName!: string

  @IsString()
  @StrictString()
  @MaxLength(900_000)
  innehall!: string

  @IsOptional()
  @IsBoolean()
  @StrictBoolean()
  nollOppning?: boolean
}

export class BindReadDto implements BindOpeningReadInput {
  @IsString()
  @StrictString()
  @IsUUID()
  readRunId!: string
}

export class SeparateLedgerDto implements SeparateLedgerInput {
  @IsIn(['1510', '2890'])
  @StrictString()
  konto!: '1510' | '2890'

  @IsString()
  @StrictString()
  @MaxLength(2000)
  beskrivning!: string

  @IsString()
  @StrictString()
  @MaxLength(200)
  filnamn!: string

  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @StrictString()
  @MaxLength(900_000)
  innehall!: string | null

  /** S5-1: den separata reskontrans system (t.ex. "Gamla systemet X, kundreskontra B"). */
  @IsOptional()
  @IsString()
  @StrictString()
  @MaxLength(200)
  system?: string

  /** S5-1: ansvarig för den separata reskontran (namn/roll). */
  @IsOptional()
  @IsString()
  @StrictString()
  @MaxLength(200)
  ansvarig?: string
}

/** KUNDSTART-009: tidigare systemets periodbundna register för perioder från brytdatum. */
export class FirstPeriodRegisterDto implements FirstPeriodRegisterInput {
  @IsString()
  @StrictString()
  @MinLength(1)
  @MaxLength(200)
  filnamn!: string

  @IsString()
  @StrictString()
  @MaxLength(900_000)
  innehall!: string

  @IsString()
  @StrictString()
  @MaxLength(200)
  system!: string

  @IsString()
  @StrictString()
  @MaxLength(200)
  ansvarig!: string

  @IsString()
  @StrictString()
  @Matches(DATUM)
  tackningFran!: string

  @IsString()
  @StrictString()
  @Matches(DATUM)
  tackningTill!: string

  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Min(1000, { each: true })
  @Max(9999, { each: true })
  intaktskonton!: number[]

  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Min(1000, { each: true })
  @Max(9999, { each: true })
  forskottskonton!: number[]
}

export class ApproveOpeningPackageDto implements ApproveOpeningPackageInput {
  @IsInt()
  @Min(1)
  version!: number

  @IsString()
  @StrictString()
  @Matches(SHA256)
  sourceSha256!: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. */
const _k1: SammaNycklar<SetCutoverDto, SetCutoverInput> = true
const _k2: SammaNycklar<UploadOpeningPackageDto, UploadOpeningPackageInput> = true
const _k3: SammaNycklar<BindReadDto, BindOpeningReadInput> = true
const _k4: SammaNycklar<SeparateLedgerDto, SeparateLedgerInput> = true
const _k5: SammaNycklar<FirstPeriodRegisterDto, FirstPeriodRegisterInput> = true
const _k6: SammaNycklar<ApproveOpeningPackageDto, ApproveOpeningPackageInput> = true
void [_k1, _k2, _k3, _k4, _k5, _k6]
