import type { SendMessageInput, SammaNycklar } from '@eken/shared'
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class SendMessageDto implements SendMessageInput {
  @IsUUID()
  @IsOptional()
  tenantId?: string

  @IsBoolean()
  @IsOptional()
  @StrictBoolean()
  sendToAll?: boolean

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @StrictString()
  subject!: string

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @StrictString()
  content!: string
}

const _kontrakt: SammaNycklar<SendMessageDto, SendMessageInput> = true
void _kontrakt
