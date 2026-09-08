import { ApiProperty } from '@nestjs/swagger'
import { IsEnum } from 'class-validator'
import type { SubscriptionPlan } from '@eken/shared'

export class ChangePlanDto {
  @ApiProperty({ enum: ['TRIAL', 'STARTER', 'MINI', 'STANDARD', 'PLUS', 'PRO'] })
  @IsEnum(['TRIAL', 'STARTER', 'MINI', 'STANDARD', 'PLUS', 'PRO'])
  plan!: SubscriptionPlan
}
