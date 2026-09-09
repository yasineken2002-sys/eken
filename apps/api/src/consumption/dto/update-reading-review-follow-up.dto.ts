import { IsBoolean } from 'class-validator'
import type { UpdateReadingReviewFollowUpInput, SammaNycklar } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'

export class UpdateReadingReviewFollowUpDto implements UpdateReadingReviewFollowUpInput {
  @IsBoolean()
  @StrictBoolean()
  enabled!: boolean
}
const _kontrakt: SammaNycklar<UpdateReadingReviewFollowUpDto, UpdateReadingReviewFollowUpInput> =
  true
void _kontrakt
