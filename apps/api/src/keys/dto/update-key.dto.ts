import type { UpdateKeyInput, SammaNycklar } from '@eken/shared'
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { KeyStatus, KeyType } from '@prisma/client'
import { StrictString } from '../../common/contract/strict-string.decorator'

// Statusbyte via PATCH får BARA sätta LOST eller REPLACED. Återlämning sker via
// PATCH /keys/:id/return (sätter returnedAt). En RETURNED nyckel är låst.
const PATCHABLE_STATUSES = ['LOST', 'REPLACED'] as const

export class UpdateKeyDto implements UpdateKeyInput {
  @IsIn(PATCHABLE_STATUSES)
  @IsOptional()
  status?: Extract<KeyStatus, 'LOST' | 'REPLACED'>

  @IsEnum(KeyType)
  @IsOptional()
  type?: KeyType

  @IsString()
  @IsOptional()
  @MaxLength(120)
  @StrictString()
  label?: string

  @IsString()
  @IsOptional()
  @MaxLength(120)
  @StrictString()
  issuedToName?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @StrictString()
  notes?: string
}

const _kontrakt: SammaNycklar<UpdateKeyDto, UpdateKeyInput> = true
void _kontrakt
