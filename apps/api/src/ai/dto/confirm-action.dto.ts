import type { ConfirmActionInput, SammaNycklar } from '@eken/shared'
import { IsString, IsBoolean, IsUUID, IsObject } from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

export class ConfirmActionDto implements ConfirmActionInput {
  @IsString()
  toolName!: string

  @IsObject()
  toolInput!: Record<string, unknown>

  @IsUUID()
  conversationId!: string

  @IsBoolean()
  @StrictBoolean()
  confirmed!: boolean
}

const _kontrakt: SammaNycklar<ConfirmActionDto, ConfirmActionInput> = true
void _kontrakt
