import type { SammaNycklar, CreateSigningRequestInput } from '@eken/shared'
import { IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateSigningRequestDto implements CreateSigningRequestInput {
  @ApiProperty({ description: 'Id för det kontrakts-Document som ska signeras' })
  @IsUUID('4', { message: 'documentId måste vara ett giltigt UUID' })
  documentId!: string
}

/** NYCKELPARITET mot det delade schemat — se övriga DTO:er. */
const _kontraktSigneringsbegaran: SammaNycklar<CreateSigningRequestDto, CreateSigningRequestInput> =
  true
void _kontraktSigneringsbegaran
