import type { SammaNycklar, CreateEquipmentInput } from '@eken/shared'
import { EQUIPMENT_KINDS } from '@eken/shared'
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator'

/**
 * Enumvärdena speglar `UnitEquipmentKind` i schemat. De står som en `as const`
 * och inte som Prismas genererade enum av samma skäl som `create-unit.dto.ts`:
 * DTO:n måste överleva som ETT VÄRDE i runtime för att `ValidationPipe` ska ha
 * metadata att läsa (CLAUDE.md, DTO-regeln).
 */
// EQUIPMENT_KINDS bor i @eken/shared — se dess docblock om de två kopiorna.
export { EQUIPMENT_KINDS }

export class CreateEquipmentDto implements CreateEquipmentInput {
  @IsUUID()
  unitId!: string

  @IsEnum(EQUIPMENT_KINDS)
  kind!: (typeof EQUIPMENT_KINDS)[number]

  @IsString()
  @IsOptional()
  @MaxLength(120)
  label?: string

  /** NÄR-halvan av frågan. Obligatorisk — se kolumnens docblock i schemat. */
  @IsISO8601()
  installedAt!: string

  /**
   * INGEN DEFAULT, med flit. Är ett kylskåps livslängd 15 år eller 20? Sätter
   * koden ett tal börjar systemet larma på hela beståndet utifrån en siffra
   * ingen bestämt. Ett värde ska komma från en människa.
   */
  @IsInt()
  @Min(1)
  @IsOptional()
  expectedLifespanYears?: number

  @IsInt()
  @Min(1)
  @IsOptional()
  serviceIntervalMonths?: number
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSkapaUtrustning: SammaNycklar<CreateEquipmentDto, CreateEquipmentInput> = true
void _kontraktSkapaUtrustning
