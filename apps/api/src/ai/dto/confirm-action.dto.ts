import { IsString, IsBoolean, IsUUID, IsObject } from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class ConfirmActionDto {
  @IsString()
  @StrictString()
  toolName!: string

  @IsObject()
  toolInput!: Record<string, unknown>

  @IsUUID()
  conversationId!: string

  @IsBoolean()
  @StrictBoolean()
  confirmed!: boolean
}
