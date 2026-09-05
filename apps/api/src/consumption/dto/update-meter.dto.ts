import type { UpdateMeterInput, SammaNycklar } from '@eken/shared'
import { IsEnum, IsOptional, IsString, IsDateString, MaxLength } from 'class-validator'
import { MeterStatus } from '@prisma/client'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements UpdateMeterInput` och raden längst ned kräver EXAKT samma
// nyckelmängd. Formen ägs av `UpdateMeterSchema` i @eken/shared, som webbens formulär
// validerar mot — ett fält som bara finns på ena sidan är ett kompileringsfel i
// stället för ett 400-svar i produktion. Mönstret är #797:s; se
// packages/shared/src/schemas/contract.ts.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern — `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class UpdateMeterDto implements UpdateMeterInput {
  @IsEnum(MeterStatus)
  @IsOptional()
  status?: MeterStatus

  @IsString()
  @IsOptional()
  @MaxLength(64)
  serialNumber?: string

  @IsString()
  @IsOptional()
  @MaxLength(64)
  provider?: string

  @IsString()
  @IsOptional()
  @MaxLength(128)
  externalId?: string

  // Sätts vid mätarbyte: den gamla mätaren markeras REMOVED + removedAt. Dess
  // sista avläsning är slutvärdet; den nya mätarens första avläsning blir
  // baslinje (ingen debitering) — så att differensen aldrig blir negativ.
  @IsDateString()
  @IsOptional()
  removedAt?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` ovan fångar fel TYP på ett
 * fält som finns i båda; den här raden fångar ett fält som SAKNAS i den ena —
 * en klass som utelämnar ett VALFRITT fält passerar `implements` utan
 * anmärkning. Faller den står fältets namn i felmeddelandet.
 */
const _kontraktMatareUppdatering: SammaNycklar<UpdateMeterDto, UpdateMeterInput> = true
void _kontraktMatareUppdatering
