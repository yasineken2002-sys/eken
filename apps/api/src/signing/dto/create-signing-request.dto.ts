import type { SammaNycklar, CreateSigningRequestInput } from '@eken/shared'
import { IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateSigningRequestDto implements CreateSigningRequestInput {
  @ApiProperty({ description: 'Id för det kontrakts-Document som ska signeras' })
  // UTAN versionsgräns. Dekoratorn krävde v4 medan schemat säger
  // `z.string().uuid()`, som godtar alla versioner — en v1-UUID passerade
  // alltså klienten och föll först i pipen. Två beskrivningar av samma mängd
  // är inte en beskrivning.
  @IsUUID(undefined, { message: 'documentId måste vara ett giltigt UUID' })
  documentId!: string
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSigneringsbegaran: SammaNycklar<CreateSigningRequestDto, CreateSigningRequestInput> =
  true
void _kontraktSigneringsbegaran
