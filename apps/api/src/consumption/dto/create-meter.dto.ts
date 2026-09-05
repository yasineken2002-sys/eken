import type { CreateMeterInput, SammaNycklar } from '@eken/shared'
import { IsEnum, IsOptional, IsString, IsUUID, IsDateString, MaxLength } from 'class-validator'
import { MeterType } from '@prisma/client'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements CreateMeterInput` och raden längst ned kräver EXAKT samma
// nyckelmängd. Formen ägs av `CreateMeterSchema` i @eken/shared, som webbens formulär
// validerar mot — ett fält som bara finns på ena sidan är ett kompileringsfel i
// stället för ett 400-svar i produktion. Mönstret är #797:s; se
// packages/shared/src/schemas/contract.ts.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern — `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class CreateMeterDto implements CreateMeterInput {
  @IsUUID()
  unitId!: string

  @IsEnum(MeterType)
  type!: MeterType

  // Fri text, källagnostisk: "kWh" | "m³" | "MWh".
  @IsString()
  @MaxLength(16)
  unitOfMeasure!: string

  @IsString()
  @IsOptional()
  @MaxLength(64)
  serialNumber?: string

  // Källagnostik: extern koppling för framtida leverantörs-API.
  @IsString()
  @IsOptional()
  @MaxLength(64)
  provider?: string

  @IsString()
  @IsOptional()
  @MaxLength(128)
  externalId?: string

  @IsDateString()
  @IsOptional()
  installedAt?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` ovan fångar fel TYP på ett
 * fält som finns i båda; den här raden fångar ett fält som SAKNAS i den ena —
 * en klass som utelämnar ett VALFRITT fält passerar `implements` utan
 * anmärkning. Faller den står fältets namn i felmeddelandet.
 */
const _kontraktMatare: SammaNycklar<CreateMeterDto, CreateMeterInput> = true
void _kontraktMatare
