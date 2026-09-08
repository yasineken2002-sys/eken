import type { ReturnKeyInput, SammaNycklar } from '@eken/shared'
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator'

export class ReturnKeyDto implements ReturnKeyInput {
  // Frivilligt återlämningsdatum — annars sätts now() i servicen.
  @IsISO8601()
  @IsOptional()
  returnedAt?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}

const _kontrakt: SammaNycklar<ReturnKeyDto, ReturnKeyInput> = true
void _kontrakt
