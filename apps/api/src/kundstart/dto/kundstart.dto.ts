import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

/** KUNDSTART-001 §5: brytdatum 'ÅÅÅÅ-MM-01' eller null (ingen gräns). Servern prövar dagen. */
export class SetCutoverDto {
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cutoverDate!: string | null
}

/** Öppningspaketets CSV som text (mall i KUNDUNDERLAG.md). Fastifys gräns är 1 MiB. */
export class UploadOpeningPackageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sourceName!: string

  @IsString()
  @MaxLength(900_000)
  innehall!: string

  @IsOptional()
  @IsBoolean()
  @StrictBoolean()
  nollOppning?: boolean
}

export class BindReadDto {
  @IsUUID()
  readRunId!: string
}

export class SeparateLedgerDto {
  @IsIn(['1510', '2890'])
  konto!: '1510' | '2890'

  @IsString()
  @MaxLength(2000)
  beskrivning!: string

  @IsString()
  @MaxLength(200)
  filnamn!: string

  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(900_000)
  innehall!: string | null
}

export class ApproveOpeningPackageDto {
  @IsInt()
  @Min(1)
  version!: number

  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sourceSha256!: string
}
