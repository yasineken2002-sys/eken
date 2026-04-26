import { IsEmail } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail({}, { message: 'Ogiltig e-postadress' })
  email!: string
}
