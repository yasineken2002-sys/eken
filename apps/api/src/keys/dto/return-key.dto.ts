import type { ReturnKeyInput, SammaNycklar } from '@eken/shared'
import { IsOptional, IsString, MaxLength } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { StrictIsoDatum } from '../../common/contract/strict-iso-datum.decorator'

export class ReturnKeyDto implements ReturnKeyInput {
  // Frivilligt återlämningsdatum — annars sätts now() i servicen.
  @StrictIsoDatum()
  @IsOptional()
  returnedAt?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @StrictString()
  notes?: string
}

const _kontrakt: SammaNycklar<ReturnKeyDto, ReturnKeyInput> = true
void _kontrakt
