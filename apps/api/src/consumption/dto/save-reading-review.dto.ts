import {
  IsIn,
  IsInt,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator'
import type { SaveReadingReviewInput, SammaNycklar } from '@eken/shared'
import { StrictString } from '../../common/contract/strict-string.decorator'
import { IngenKoercion } from '../../common/contract/no-coercion.decorator'

export class SaveReadingReviewDto implements SaveReadingReviewInput {
  @IsUUID()
  @StrictString()
  readingId!: string

  @IsIn(['DATA', 'OVERLAP', 'DECREASE', 'HIGH_RATE'])
  @StrictString()
  findingCode!: SaveReadingReviewInput['findingCode']

  @Length(64, 64)
  @Matches(/^[a-f0-9]{64}$/)
  @StrictString()
  fingerprint!: string

  @IsInt()
  @Min(0)
  @Max(2147483646)
  @IngenKoercion()
  expectedRevision!: number

  @IsIn(['NEEDS_INVESTIGATION', 'CONFIRMED', 'EXPLAINED'])
  @StrictString()
  assessment!: SaveReadingReviewInput['assessment']

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['VERIFIED_CORRECT_REAL_INCREASE', 'INCORRECT'])
  @StrictString()
  billingBasisDecision?: SaveReadingReviewInput['billingBasisDecision']

  @IsString()
  @StrictString()
  // Samma UTF-16-längd som Zods min/max, även för emoji.
  @Matches(/^(?=[\s\S]{1,1000}(?![\s\S]))[\s\S]*\S/)
  comment!: string
}
const _kontrakt: SammaNycklar<SaveReadingReviewDto, SaveReadingReviewInput> = true
void _kontrakt
