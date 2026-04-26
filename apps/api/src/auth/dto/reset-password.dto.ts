import { IsString, MinLength, Matches } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  token!: string

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Lösenordet måste vara minst 8 tecken' })
  @Matches(/[A-Z]/, { message: 'Lösenordet måste innehålla minst en stor bokstav' })
  @Matches(/[0-9]/, { message: 'Lösenordet måste innehålla minst en siffra' })
  newPassword!: string
}
