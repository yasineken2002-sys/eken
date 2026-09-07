import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'
import type { SammaNycklar, ResetPasswordRequestInput } from '@eken/shared'

export class ResetPasswordDto implements ResetPasswordRequestInput {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  token!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  newPassword!: string
}

const _kontraktResetPasswordDto: SammaNycklar<ResetPasswordDto, ResetPasswordRequestInput> = true
void _kontraktResetPasswordDto
