import { IsString, IsNotEmpty } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @StrictString()
  refreshToken!: string
}
