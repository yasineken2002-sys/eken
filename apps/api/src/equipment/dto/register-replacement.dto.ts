import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator'
import { EQUIPMENT_KINDS } from './create-equipment.dto'

/**
 * ETT BYTE ÄR EN HÄNDELSE, INTE EN UPPDATERING.
 *
 * Registreringen skriver fyra saker i EN transaktion:
 *   1. efterträdaren som en NY `UnitEquipment`
 *   2. `removedAt` + `replacedById` på föregångaren
 *   3. en `REPLACED`-händelse på föregångaren (append-only)
 *   4. en `INSTALLED`-händelse på efterträdaren
 *
 * Att de delar transaktion är inte bekvämlighet: en efterträdare utan händelse
 * är ett byte utan spår, och en händelse utan efterträdare är ett spår efter
 * något som inte finns.
 *
 * FÖRVÄNTNINGARNA ÄRVS INTE. Efterträdaren får sina egna värden eller inga alls
 * — att kopiera föregångarens vore att låta koden gissa åt människan, och ett
 * nytt kylskåp av annat fabrikat har inte samma livslängd som det gamla.
 */
export class RegisterReplacementDto {
  /** VAD som ersätter. Utelämnas `kind` ärvs föregångarens sort — samma sak, nytt exemplar. */
  @IsEnum(EQUIPMENT_KINDS)
  @IsOptional()
  kind?: (typeof EQUIPMENT_KINDS)[number]

  @IsString()
  @IsOptional()
  @MaxLength(120)
  label?: string

  /** NÄR bytet skedde. Blir efterträdarens `installedAt` och föregångarens `removedAt`. */
  @IsISO8601()
  occurredAt!: string

  /** AV VEM. Vilken MÄNNISKA som utförde arbetet — inte vem som registrerar det. */
  @IsUUID()
  @IsOptional()
  performedById?: string

  /** KOSTNAD, valfri. Utelämnad betyder OKÄND, aldrig noll. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  cost?: number

  /** BILAGA, valfri — kvitto eller protokoll (R2-nyckel). */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  attachmentUrl?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  note?: string

  @IsUUID()
  @IsOptional()
  maintenanceTicketId?: string

  @IsInt()
  @Min(1)
  @IsOptional()
  expectedLifespanYears?: number

  @IsInt()
  @Min(1)
  @IsOptional()
  serviceIntervalMonths?: number
}
