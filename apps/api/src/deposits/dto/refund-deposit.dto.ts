import type { DepositDeductionInput, RefundDepositInput, SammaNycklar } from '@eken/shared'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'

export class DeductionDto {
  @IsString()
  @MaxLength(200)
  reason!: string

  @IsNumber()
  @Min(0)
  amount!: number
}

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements RefundDepositInput` plus paritetsraden längst ned binder formen till
// `RefundDepositSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class RefundDepositDto implements RefundDepositInput {
  @IsNumber()
  @Min(0)
  refundAmount!: number

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeductionDto)
  @IsOptional()
  // `@ArrayMinSize(0)` stod här och kunde per definition inte falla — varje
  // array har minst noll element. En kontroll som inte kan falla mäter
  // ingenting, och den läste som ett krav. Borttagen; `@IsArray()` ovan är den
  // som faktiskt fäller något.
  deductions?: DeductionDto[]

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktDepositionAterbetalning: SammaNycklar<RefundDepositDto, RefundDepositInput> = true
void _kontraktDepositionAterbetalning

/**
 * OCH RADTYPEN — samma lärdom som kreditnotans rader (#801): paritet på
 * toppnivån ser inte ett fält som läggs till i den NÄSTLADE typen.
 */
const _kontraktAvdrag: SammaNycklar<DeductionDto, DepositDeductionInput> = true
void _kontraktAvdrag
