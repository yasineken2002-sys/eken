import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

import type { AddTicketCommentInput, SammaNycklar } from '@eken/shared'
import { StrictBoolean } from '../../common/contract/strict-boolean.decorator'
import { StrictString } from '../../common/contract/strict-string.decorator'

/**
 * POST /maintenance/:id/comments
 *
 * DEN HÄR DTO:n FANNS INTE. Controllern tog `@Body() body: { content: string;
 * isInternal?: boolean }` — en TS-typliteral, som försvinner i runtime. Det gav
 * NOLL validering på fritext från en inloggad användare: ingen längdgräns,
 * ingen typkontroll, och `isInternal` kunde vara vad som helst.
 *
 * Taket 4000 är samma som på ärendets `description`, och av samma skäl:
 * kommentarerna läses av skuggagenten, och en obunden sträng gör kostnaden per
 * ärende obunden uppåt.
 */
export class AddTicketCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  @StrictString()
  content!: string

  // Intern kommentar syns inte för hyresgästen i portalen.
  @IsBoolean()
  @IsOptional()
  @StrictBoolean()
  isInternal?: boolean
}

const _kontraktKommentar: SammaNycklar<AddTicketCommentDto, AddTicketCommentInput> = true
void _kontraktKommentar
