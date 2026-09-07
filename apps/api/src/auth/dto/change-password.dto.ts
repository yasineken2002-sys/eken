import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'
import type { SammaNycklar, ChangePasswordRequestInput } from '@eken/shared'

export class ChangePasswordDto implements ChangePasswordRequestInput {
  @ApiProperty()
  @IsString()
  currentPassword!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  newPassword!: string
}

const _kontraktChangePasswordDto: SammaNycklar<ChangePasswordDto, ChangePasswordRequestInput> = true
void _kontraktChangePasswordDto
