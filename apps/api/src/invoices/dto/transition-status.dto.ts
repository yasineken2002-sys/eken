import { IsEnum, IsObject, IsOptional } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class TransitionStatusDto {
  @ApiProperty({ enum: ['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID'] })
  @IsEnum(['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID'])
  status!: 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID'

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  payload?: Record<string, unknown>
}
