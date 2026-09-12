import type { BuyCreditsInput, SammaNycklar } from '@eken/shared'
import { ApiProperty } from '@nestjs/swagger'
import { IsIn } from 'class-validator'
import { StrictString } from '../../common/contract/strict-string.decorator'

export class BuyCreditsDto implements BuyCreditsInput {
  @ApiProperty({ enum: [100, 500, 1000], description: 'Antal credits att köpa' })
  @IsIn([100, 500, 1000])
  amount!: 100 | 500 | 1000
}

export class HistoryQueryDto {
  @ApiProperty({ required: false, default: 30 })
  @StrictString()
  days?: string
}

const _kontrakt: SammaNycklar<BuyCreditsDto, BuyCreditsInput> = true
void _kontrakt
