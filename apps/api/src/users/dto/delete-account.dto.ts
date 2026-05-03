import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class DeleteAccountDto {
  @ApiProperty({ description: 'Bekräfta med ditt nuvarande lösenord' })
  @IsString()
  @MinLength(1)
  password!: string
}
