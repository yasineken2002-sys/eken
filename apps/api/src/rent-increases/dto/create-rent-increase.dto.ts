import type { SammaNycklar, CreateRentIncreaseInput } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'
import { IsNumber, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator'

export class CreateRentIncreaseDto implements CreateRentIncreaseInput {
  @IsUUID()
  leaseId!: string

  @IsNumber()
  @Min(1)
  newRent!: number

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @StrictString()
  reason!: string

  @StrictIsoDatum()
  effectiveDate!: string
}

// ── `notes` ÄR BORTTAGET, OCH DET ÄR EN RÄTTELSE ────────────────────────────
//
// Fältet togs emot av DTO:n, validerades (max 500), och SLÄNGDES sedan:
// `RentIncrease` har ingen `notes`-kolumn (schema.prisma, modellen) och
// `create()` läser aldrig `dto.notes`. Det var alltså ett fält som såg ut att
// spara en anteckning och inte gjorde det.
//
// Funnet av hyresjurist under granskningen av kontraktsbindningen. Jag var på
// väg att göra det VÄRRE: genom att ta in fältet i det delade schemat hade det
// blivit nåbart från gränssnittet för första gången, och nästa person som lade
// till ett textfält i formuläret hade fått en hyresvärd att skriva "Beslut
// fattat på stämman 2026-11-02" och tro att det dokumenterades.
//
// Ingen klient skickar det: webbens egen typ saknade fältet, vilket är just
// därför ingen märkt att det försvann. Att ta bort det är därför ofarligt och
// gör tyst dataförlust till ett tydligt fel.
//
// Vill någon ha anteckningen på riktigt är åtgärden en kolumn plus en skrivning
// i `create()` — inte att fältet får stå kvar och se ut att fungera.

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSkapaHojning: SammaNycklar<CreateRentIncreaseDto, CreateRentIncreaseInput> = true
void _kontraktSkapaHojning
