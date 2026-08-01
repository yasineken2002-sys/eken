import { IsString, MaxLength, MinLength } from 'class-validator'
import { Transform } from 'class-transformer'

/**
 * Kroppen till POST /accounting/journal/:id/reverse.
 *
 * Importeras som VÄRDE (aldrig `import type`) — NestJS läser reflect-metadata i
 * runtime, och en typ-import gör klassen osynlig för ValidationPipe.
 *
 * Valideringen här är bekvämlighet, inte skyddet: samma regel upprepas i
 * `AccountingService.reverseJournalEntry` (chokepunkten).
 */
export class ReverseEntryDto {
  /**
   * Varför verifikatet rättas. Blir rättelsens beskrivning i huvudboken och går
   * inte att ändra efteråt — därför en riktig mening, inte "fel".
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Ange varför verifikatet rättas' })
  @MinLength(10, {
    message: 'Skälet måste vara minst 10 tecken — det blir rättelsens beskrivning i huvudboken',
  })
  @MaxLength(300, { message: 'Skälet får vara högst 300 tecken' })
  reason!: string
}
