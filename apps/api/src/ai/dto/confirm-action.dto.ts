import { IsString, IsBoolean, IsUUID, IsObject } from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

export class ConfirmActionDto {
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
