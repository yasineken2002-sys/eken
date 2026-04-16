import { IsString, IsOptional, IsUUID, MinLength } from 'class-validator'

export class ChatDto {
  @IsString()
  @MinLength(1)
  message!: string

  @IsUUID()
  @IsOptional()
  conversationId?: string
}
