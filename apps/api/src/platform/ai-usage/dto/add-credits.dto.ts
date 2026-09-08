import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Min } from 'class-validator'

export class AddCreditsDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  amount!: number

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string
}
