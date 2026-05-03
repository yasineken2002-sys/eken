import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { IsStrongPassword } from './password.decorators'

export class AcceptInviteDto {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  token!: string

  @ApiProperty({ minLength: 10 })
  @IsStrongPassword()
  newPassword!: string
}
