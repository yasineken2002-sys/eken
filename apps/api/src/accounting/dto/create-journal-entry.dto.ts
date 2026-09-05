import type { CreateJournalEntryInput, SammaNycklar } from '@eken/shared'
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'
import { Transform, Type } from 'class-transformer'

/**
 * Kroppen till POST /accounting/journal-entries — människans väg till ett fritt
 * verifikat, motsvarigheten till AI-verktyget `create_journal_entry`.
 *
 * VÄRDE-IMPORT i controllern, aldrig `import type`: NestJS läser
 * reflect-metadata i runtime, och en typ-import raderar klassen så ValidationPipe
 * tappar all metadata. Samma sak gäller `@Type(() => JournalLineDto)` nedan —
 * utan den blir raderna vanliga objekt och radvalideringen körs aldrig.
 *
 * VALIDERINGEN HÄR ÄR BEKVÄMLIGHET, INTE SKYDDET. Balanskravet, kontouppslaget
 * och periodspärren sitter i `AccountingService.createManualJournalEntry` och i
 * `createNumberedEntry`. Den senare är chokepunkten för alla verifikat som
 * skrivs GENOM AccountingService — AI-verktygen har en egen skrivtransaktion, se
 * `manual-entry.ts`. Det som står här ger bara ett snabbare och tydligare fel
 * för det uppenbara.
 */
export class JournalLineDto {
  @IsInt({ message: 'Kontonummer måste vara ett heltal' })
  @Min(1000, { message: 'BAS-kontonummer är fyrsiffriga (1000–8999)' })
  @Max(8999, { message: 'BAS-kontonummer är fyrsiffriga (1000–8999)' })
  accountNumber!: number

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Debet anges med högst två decimaler' })
  @Min(0, { message: 'Debet kan inte vara negativt — byt till kredit i stället' })
  debit?: number

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Kredit anges med högst två decimaler' })
  @Min(0, { message: 'Kredit kan inte vara negativt — byt till debet i stället' })
  credit?: number

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200, { message: 'Radtexten får vara högst 200 tecken' })
  description?: string
}

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements CreateJournalEntryInput` och raden längst ned kräver
// EXAKT samma nyckelmängd. Formen ägs alltså av `CreateJournalEntrySchema` i
// @eken/shared, som webbens formulär validerar mot — ett fält som bara finns på
// ena sidan är ett kompileringsfel i stället för ett 400-svar i produktion.
//
// VÄRDEIMPORT av typen är inte nödvändig (det är en typ), men klassen självt
// måste fortsätta importeras som VÄRDE i controllern — `import type` raderar den
// och ValidationPipe tappar all metadata. Se CLAUDE.md:s DTO-regel.
export class CreateJournalEntryDto implements CreateJournalEntryInput {
  @IsISO8601({}, { message: 'Datum måste anges som ÅÅÅÅ-MM-DD' })
  date!: string

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ange vad verifikatet avser' })
  @MinLength(3, { message: 'Beskrivningen måste vara minst 3 tecken' })
  @MaxLength(300, { message: 'Beskrivningen får vara högst 300 tecken' })
  description!: string

  @IsArray()
  @ArrayMinSize(2, { message: 'Ett verifikat behöver minst två konteringsrader' })
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[]

  /**
   * Klientens egen nyckel. Två anrop med samma nyckel ger EN journalpost —
   * `sourceId` i namnrymden `MANUAL`. Webben skickar ett uuid per öppnad modal,
   * så ett omtag efter en tappad uppkoppling inte blir två verifikat i
   * huvudboken. Utelämnas den skapas alltid ett nytt verifikat, vilket är rätt
   * för en anropare som inte kan göra om sitt anrop.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'Idempotensnyckeln får vara högst 120 tecken' })
  idempotencyKey?: string

  /** Valfri bilaga (kvitto/underlag), redan uppladdad — URL:en lagras på posten. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentUrl?: string
}

/**
 * NYCKELPARITET mot det delade schemat. Faller kompileringen här står det
 * saknade fältets namn i felmeddelandet.
 *
 * `implements` ovan räcker inte: en klass som utelämnar ett VALFRITT fält ur
 * interfacet passerar `implements` utan anmärkning. Raden nedan gör inte det.
 */
const _kontraktVerifikat: SammaNycklar<CreateJournalEntryDto, CreateJournalEntryInput> = true
void _kontraktVerifikat
