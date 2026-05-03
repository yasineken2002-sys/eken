import { IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  newPassword!: string
}
