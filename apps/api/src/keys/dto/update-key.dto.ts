import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { KeyStatus, KeyType } from '@prisma/client'

// Statusbyte via PATCH får BARA sätta LOST eller REPLACED. Återlämning sker via
// PATCH /keys/:id/return (sätter returnedAt). En RETURNED nyckel är låst.
const PATCHABLE_STATUSES = ['LOST', 'REPLACED'] as const

export class UpdateKeyDto {
  @IsIn(PATCHABLE_STATUSES)
  @IsOptional()
  status?: Extract<KeyStatus, 'LOST' | 'REPLACED'>

  @IsEnum(KeyType)
  @IsOptional()
  type?: KeyType

  @IsString()
  @IsOptional()
  @MaxLength(120)
  label?: string

  @IsString()
  @IsOptional()
  @MaxLength(120)
  issuedToName?: string

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string
}
