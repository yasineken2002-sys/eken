import type { MarkNoticePaidInput, SammaNycklar } from '@eken/shared'
import { IsNumber, IsDateString, IsOptional, IsEnum, Min } from 'class-validator'
import { PaymentMethod } from '@prisma/client'

// ── KONTRAKTET MOT WEBBEN ───────────────────────────────────────────────────
//
// `implements MarkNoticePaidInput` plus paritetsraden längst ned binder formen till
// `MarkNoticePaidSchema` i @eken/shared — samma mönster som #797/#799. Ett fält som bara
// finns på ena sidan blir ett kompileringsfel i stället för ett 400-svar.
//
// Klassen måste fortsätta importeras som VÄRDE i controllern; `import type`
// raderar den och ValidationPipe tappar all metadata (CLAUDE.md:s DTO-regel).
export class MarkPaidDto implements MarkNoticePaidInput {
  // Min 0.01: en nollbetalning är ingen affärshändelse och skulle ge en PAID-avi
  // utan motpost (BFL 5 kap 6 §).
  @IsNumber()
  @Min(0.01)
  paidAmount!: number

  // Betalningssätt — obligatoriskt. Styr vilket likvidkonto som debiteras i
  // betalningsverifikatet (BANK/MANUAL → 1930, CASH → 1910, SWISH → 1934).
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod

  @IsDateString()
  @IsOptional()
  paidAt?: string
}

/**
 * NYCKELPARITET mot det delade schemat. `implements` fångar fel TYP på ett fält
 * som finns i båda; den här raden fångar ett fält som SAKNAS i den ena — en
 * klass som utelämnar ett VALFRITT fält passerar `implements` utan anmärkning.
 */
const _kontraktAviBetald: SammaNycklar<MarkPaidDto, MarkNoticePaidInput> = true
void _kontraktAviBetald
