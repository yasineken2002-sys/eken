import { IsString, IsBoolean, IsUUID, IsObject } from 'class-validator'

export class ConfirmActionDto {
  @IsString()
  toolName!: string

  @IsObject()
  toolInput!: Record<string, unknown>

  @IsUUID()
  conversationId!: string

  @IsBoolean()
  confirmed!: boolean
}
