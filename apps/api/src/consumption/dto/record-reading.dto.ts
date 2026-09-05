import type { CreateReadingInput, SammaNycklar } from '@eken/shared'
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
  MaxLength,
} from 'class-validator'
import { ReadingSource, ReadingType } from '@prisma/client'

// EN källagnostisk väg in: MANUAL, IMPORT och framtida API skickar samma DTO
// till recordReading(). source skiljer enbart ursprung; logiken är identisk.

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements CreateReadingInput` och raden längst ned kräver EXAKT samma
// nyckelmängd. Formen ägs av `CreateReadingSchema` i @eken/shared, som webbens formulär
// validerar mot — ett fält som bara finns på ena sidan är ett kompileringsfel i
// stället för ett 400-svar i produktion. Mönstret är #797:s; se
// packages/shared/src/schemas/contract.ts.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern — `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class RecordReadingDto implements CreateReadingInput {
  @IsUUID()
  meterId!: string

  // Mätarställning (CUMULATIVE) eller periodförbrukning (PERIOD_VOLUME).
  @IsNumber()
  value!: number

  @IsEnum(ReadingType)
  @IsOptional()
  readingType?: ReadingType

  @IsEnum(ReadingSource)
  source!: ReadingSource

  // När mätaren lästes.
  @IsDateString()
  readingDate!: string

  // Mätperioden (skild från fakturadatum) — styr räkenskapsåret.
  @IsDateString()
  periodStart!: string

  @IsDateString()
  periodEnd!: string

  // Datakällans avläsnings-id. Idempotensnyckel (meterId + externalId): samma
  // avläsning från ett API/en import skapar aldrig en dubblett.
  @IsString()
  @IsOptional()
  @MaxLength(128)
  externalId?: string

  // Valfritt: bind avläsningen till ett specifikt hyresavtal. Utelämnat → det
  // aktiva avtal som täcker perioden härleds.
  @IsUUID()
  @IsOptional()
  leaseId?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` ovan fångar fel TYP på ett
 * fält som finns i båda; den här raden fångar ett fält som SAKNAS i den ena —
 * en klass som utelämnar ett VALFRITT fält passerar `implements` utan
 * anmärkning. Faller den står fältets namn i felmeddelandet.
 */
const _kontraktAvlasning: SammaNycklar<RecordReadingDto, CreateReadingInput> = true
void _kontraktAvlasning
