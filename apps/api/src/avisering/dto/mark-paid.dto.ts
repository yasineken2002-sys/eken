import { IsNumber, IsDateString, IsOptional, IsEnum, Min } from 'class-validator'
import { PaymentMethod } from '@prisma/client'

export class MarkPaidDto {
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
