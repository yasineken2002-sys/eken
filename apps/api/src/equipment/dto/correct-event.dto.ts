import { IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

/**
 * RÄTTELSE — en NY händelse som pekar tillbaka, aldrig en UPDATE.
 *
 * `UnitEquipmentEvent` är append-only med en databastrigger (#585), så en
 * felregistrerad händelse går inte att ändra ens av misstag. Det är avsiktligt:
 * tabellen är ENDA källan till att ett byte skett, till skillnad från avier och
 * fakturor som har sina domänrader kvar att jämföra mot. En ändrad rad här vore
 * inte en felaktig kopia utan en felaktig historia, och den skulle inte gå att
 * upptäcka.
 *
 * Rättelsen bär därför `correctsId`, och det fältet är `@unique`: två rättelser
 * kan inte peka på samma original. En förgrenad rättelsekedja är ingen rättelse.
 */
export class CorrectEventDto {
  /** Händelsen som blev fel. Måste tillhöra samma utrustning och samma org. */
  @IsUUID()
  correctsId!: string

  @StrictIsoDatum()
  occurredAt!: string

  @IsUUID()
  @IsOptional()
  performedById?: string

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  cost?: number

  @IsString()
  @IsOptional()
  @MaxLength(500)
  @StrictString()
  attachmentUrl?: string

  /** SKÄLET. Obligatoriskt — en rättelse utan skäl är bara en andra version. */
  @IsString()
  @MaxLength(1000)
  @StrictString()
  note!: string
}
