import type { CreateTariffInput, SammaNycklar } from '@eken/shared'
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
  MaxLength,
  Min,
} from 'class-validator'
import { MeterType, TariffScope } from '@prisma/client'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// Klassen deklarerar `implements CreateTariffInput` och raden längst ned kräver EXAKT samma
// nyckelmängd. Formen ägs av `CreateTariffSchema` i @eken/shared, som webbens formulär
// validerar mot — ett fält som bara finns på ena sidan är ett kompileringsfel i
// stället för ett 400-svar i produktion. Mönstret är #797:s; se
// packages/shared/src/schemas/contract.ts.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern — `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class CreateTariffDto implements CreateTariffInput {
  @IsEnum(TariffScope)
  scope!: TariffScope

  // Krävs när scope = PROPERTY respektive UNIT (valideras i servicen).
  @IsUUID()
  @IsOptional()
  propertyId?: string

  @IsUUID()
  @IsOptional()
  unitId?: string

  @IsEnum(MeterType)
  meterType!: MeterType

  // Pris per förbrukningsenhet (kr/kWh, kr/m³). Decimal(10,4) i DB.
  @IsNumber()
  @Min(0)
  pricePerUnit!: number

  // Valfri fast månadsavgift (abonnemang). Lagras men tillämpas inte på charge
  // i PR 2 — net = quantity × pricePerUnit. Reserverad för senare.
  @IsNumber()
  @Min(0)
  @IsOptional()
  fixedMonthlyFee?: number

  // Tariffen gäller från detta datum. En tidigare gällande tariff (validTo=null)
  // för samma scope/mål/meterType stängs automatiskt dagen innan (historik).
  @IsDateString()
  validFrom!: string

  // Beräkningsgrund (JB 12:19): fri dokumentationstext om hur vidaredebiteringen
  // beräknas. Valfri, ren dokumentation — ingår aldrig i charge-/bokföringskalkyl.
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  calculationBasis?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` ovan fångar fel TYP på ett
 * fält som finns i båda; den här raden fångar ett fält som SAKNAS i den ena —
 * en klass som utelämnar ett VALFRITT fält passerar `implements` utan
 * anmärkning. Faller den står fältets namn i felmeddelandet.
 */
const _kontraktTariff: SammaNycklar<CreateTariffDto, CreateTariffInput> = true
void _kontraktTariff
