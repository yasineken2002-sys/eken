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

export class CreateJournalEntryDto {
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
