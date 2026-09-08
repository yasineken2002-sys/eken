import { ApiProperty } from '@nestjs/swagger'
import { IsIn } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class BuyCreditsDto {
  @ApiProperty({ enum: [100, 500, 1000], description: 'Antal credits att köpa' })
  @IsIn([100, 500, 1000])
  amount!: 100 | 500 | 1000
}

export class HistoryQueryDto {
  @ApiProperty({ required: false, default: 30 })
  @StrictString()
  days?: string
}
