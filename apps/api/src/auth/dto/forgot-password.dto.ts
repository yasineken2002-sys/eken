import { IsEmail } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import type { SammaNycklar, ForgotPasswordRequestInput } from '@eken/shared'

export class ForgotPasswordDto implements ForgotPasswordRequestInput {
  @ApiProperty()
  @IsEmail({}, { message: 'Ogiltig e-postadress' })
  email!: string
}

const _kontraktForgotPasswordDto: SammaNycklar<ForgotPasswordDto, ForgotPasswordRequestInput> = true
void _kontraktForgotPasswordDto
