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

export class CreateTariffDto {
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
