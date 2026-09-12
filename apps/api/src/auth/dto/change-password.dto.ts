import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'
import type { SammaNycklar, ChangePasswordRequestInput } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class ChangePasswordDto implements ChangePasswordRequestInput {
  @ApiProperty()
  @IsString()
  @StrictString()
  currentPassword!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  @StrictString()
  newPassword!: string
}

const _kontraktChangePasswordDto: SammaNycklar<ChangePasswordDto, ChangePasswordRequestInput> = true
void _kontraktChangePasswordDto
