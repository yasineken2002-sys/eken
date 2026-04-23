import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator'

export class SendMessageDto {
  @IsUUID()
  @IsOptional()
  tenantId?: string

  @IsBoolean()
  @IsOptional()
  sendToAll?: boolean

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject!: string

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string
}
