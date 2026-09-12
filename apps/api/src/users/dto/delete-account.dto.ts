import { IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class DeleteAccountDto {
  @ApiProperty({ description: 'Bekräfta med ditt nuvarande lösenord' })
  @IsString()
  @MinLength(1)
  @StrictString()
  password!: string
}
