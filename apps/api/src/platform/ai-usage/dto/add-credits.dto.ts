import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Min } from 'class-validator'
import { StrictString } from '../../../common/contract/strict-string.decorator'

export class AddCreditsDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  amount!: number

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @StrictString()
  note?: string
}
