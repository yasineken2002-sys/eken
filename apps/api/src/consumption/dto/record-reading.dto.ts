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
export class RecordReadingDto {
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
