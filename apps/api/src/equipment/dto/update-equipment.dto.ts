import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator'

/**
 * VAD SOM INTE GÅR ATT ÄNDRA, och varför.
 *
 * `kind`, `unitId` och `installedAt` saknas här med flit. De tre är sakens
 * IDENTITET: ett kylskåp som blir en diskmaskin är inte samma sak uppdaterad,
 * det är en annan sak — och `installedAt` är NÄR-halvan av frågan historiken
 * svarar på. Att kunna skriva om den vore att kunna skriva om historien utan
 * att lämna spår, vilket är exakt vad append-only-händelserna finns för att
 * hindra. Fel sak registrerad tas bort och registreras på nytt.
 *
 * `removedAt` och `replacedById` saknas också: de sätts av bytesregistreringen,
 * som skriver händelsen i samma transaktion. En fri UPDATE på dem hade kunnat
 * markera ett byte utan att lämna en händelse.
 */
export class UpdateEquipmentDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  label?: string

  @IsInt()
  @Min(1)
  @IsOptional()
  expectedLifespanYears?: number

  @IsInt()
  @Min(1)
  @IsOptional()
  serviceIntervalMonths?: number
}
