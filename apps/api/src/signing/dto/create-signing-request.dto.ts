import { IsUUID } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateSigningRequestDto {
  @ApiProperty({ description: 'Id för det kontrakts-Document som ska signeras' })
  @IsUUID('4', { message: 'documentId måste vara ett giltigt UUID' })
  documentId!: string
}
