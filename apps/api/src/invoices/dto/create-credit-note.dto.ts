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

export class CreateCreditNoteDto {
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
