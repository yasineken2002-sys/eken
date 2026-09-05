import type { CreateCreditNoteInput, CreditNoteLineInput, SammaNycklar } from '@eken/shared'
import { IsArray, IsNumber, IsOptional, IsString, IsUUID, MinLength, Min } from 'class-validator'
import { ArrayMinSize, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'

/**
 * En rad att kreditera (#517).
 *
 * MOMSSATSEN GÅR INTE ATT ANGE, och det är hela poängen med att raden pekar på
 * en `invoiceLineId`: satsen ÄRVS från originalraden. Kunde klienten skicka en
 * egen sats gick det att kreditera bort utgående moms som aldrig bokfördes —
 * ett fel som lämnar huvudboken balanserad och momsredovisningen fel, alltså
 * precis den sorten som inte upptäcks av en balanskontroll.
 */
export class CreditNoteLineDto {
  @ApiProperty({ description: 'Raden på ursprungsfakturan som krediteras' })
  @IsUUID('4', { message: 'invoiceLineId måste vara ett giltigt UUID' })
  invoiceLineId!: string

  @ApiProperty({ required: false, description: 'Egen radtext. Utelämnad ärvs originalets.' })
  @IsOptional()
  @IsString()
  description?: string

  @ApiProperty({ description: 'Antal enheter som krediteras' })
  @IsNumber()
  @Min(0.01, { message: 'Antal måste vara större än noll' })
  quantity!: number

  @ApiProperty({ description: 'Belopp per enhet exklusive moms' })
  @IsNumber()
  @Min(0.01, { message: 'Belopp per enhet måste vara större än noll' })
  unitPrice!: number
}

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements CreateCreditNoteInput` plus paritetsraden längst ned binder formen till
// `CreateCreditNoteSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class CreateCreditNoteDto implements CreateCreditNoteInput {
  @ApiProperty({ type: [CreditNoteLineDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'En kreditnota måste innehålla minst en rad' })
  @ValidateNested({ each: true })
  @Type(() => CreditNoteLineDto)
  lines!: CreditNoteLineDto[]

  /**
   * Skälet blir kreditnotans egen anteckning och läggs i händelseloggen. Samma
   * krav som på en verifikaträttelse: en korrigering utan angivet skäl går inte
   * att granska i efterhand.
   */
  @ApiProperty({ description: 'Varför fakturan krediteras' })
  @IsString()
  @MinLength(5, { message: 'Ange ett skäl till krediteringen (minst 5 tecken)' })
  reason!: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktKreditnota: SammaNycklar<CreateCreditNoteDto, CreateCreditNoteInput> = true
void _kontraktKreditnota

/**
 * OCH RADTYPEN. Paritet på toppnivån räcker inte: `lines` är en NÄSTLAD typ, och
 * ett fält som läggs till på `CreditNoteLineSchema` men glöms i
 * `CreditNoteLineDto` syns inte i toppnivåns nyckelmängd. Hålet satt i precis
 * den mekanism den här serien infört — funnet av granskningen, inte av ett prov.
 */
const _kontraktKreditnotaRad: SammaNycklar<CreditNoteLineDto, CreditNoteLineInput> = true
void _kontraktKreditnotaRad
