import { IsString, MaxLength, MinLength } from 'class-validator'

import type { AnswerQuestionInput, SammaNycklar } from '@eken/shared'

/**
 * Svaret på en fråga från agenten.
 *
 * BARA ett värde ur frågans egna alternativ godtas — men det prövas i TJÄNSTEN,
 * inte här: alternativen bor på raden och DTO:t kan inte se dem. Formen prövas
 * här, mängden där.
 */
export class AnswerQuestionDto implements AnswerQuestionInput {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  svar!: string
}

/** KOMPILERINGSTIDENS KOPPLING till webben. Se `create-from-assignment.dto.ts`. */
const _kontrakt: SammaNycklar<AnswerQuestionDto, AnswerQuestionInput> = true
void _kontrakt
