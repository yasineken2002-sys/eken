import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'
import type { SammaNycklar, AcceptInviteRequestInput } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class AcceptInviteDto implements AcceptInviteRequestInput {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  @StrictString()
  token!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  @StrictString()
  newPassword!: string
}

const _kontraktAcceptInviteDto: SammaNycklar<AcceptInviteDto, AcceptInviteRequestInput> = true
void _kontraktAcceptInviteDto
